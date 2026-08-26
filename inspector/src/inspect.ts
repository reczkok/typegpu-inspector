import { readPackageJSON } from 'pkg-types';
import type { Browser, Page } from 'playwright-chromium';
import type { ViteDevServer } from 'vite';
import {
  diagnoseInspectionFailure,
  getErrorMessage,
} from './browser/diagnostics.ts';
import {
  INSPECTOR_BROWSER_CONTEXT_OPTIONS,
  launchInspectorBrowser,
} from './inspect/browser.ts';
import {
  prepareInspectionInput,
  normalizeInput,
  type PreparedInput,
} from './inspect/input.ts';
import {
  buildSymbolInspectionModule,
  normalizeSymbolInput,
} from './inspect/symbols.ts';
import { resolvePackagePathFrom } from './inspect/paths.ts';
import {
  acquireInspectorSession,
  invalidateInspectorSession,
  type AcquiredInspectorSession,
  type InspectorSessionLease,
} from './inspect/session.ts';
import {
  INSPECTOR_HARNESS_PATH,
  startInspectorViteServer,
} from './inspect/vite.ts';
import {
  DEFAULT_INSPECTION_TIMEOUT_MS,
  MAX_SESSION_ESTABLISHMENT_MS,
  SessionInfrastructureError,
  createAbortError,
  isAbortError,
} from './shared.ts';
import type {
  BrowserInspectRequest,
  InspectTypegpuModuleInput,
  InspectTypegpuSymbolsInput,
  InspectionCause,
  InspectionStats,
  InspectionTimings,
  TargetDiagnostic,
  TypeGpuInspectionReport,
  TypeGpuTargetReport,
} from './types.ts';
import { inferTargetOutcome } from './browser/outcome.ts';

type BrowserTransferResult =
  | { ok: true; json: string }
  | {
      ok: false;
      error: {
        name?: string | undefined;
        message: string;
        stack?: string | undefined;
        environmentLedger?: TypeGpuInspectionReport['ledger'];
      };
    };

export {
  normalizeInput,
  buildSymbolInspectionModule,
  normalizeSymbolInput,
};

export type InspectTypegpuModuleOptions = {
  /** Cancels the inspection: pending waits reject and the session lease is released. */
  signal?: AbortSignal | undefined;
};

/** One inspection attempt, including the isolated retry that may follow it. */
type InspectionRun = {
  deadline: InspectionDeadline;
  signal?: AbortSignal | undefined;
};

export async function inspectTypegpuModule(
  input: InspectTypegpuModuleInput,
  options: InspectTypegpuModuleOptions = {},
): Promise<TypeGpuInspectionReport> {
  return runInspection(input, {
    deadline: createInspectionDeadline(input.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS),
    signal: options.signal,
  });
}

async function runInspection(
  input: InspectTypegpuModuleInput,
  run: InspectionRun,
): Promise<TypeGpuInspectionReport> {
  const { deadline, signal } = run;
  const inspectionStartedAt = performance.now();
  const timings: Partial<InspectionTimings> = {};
  const consoleMessages: TypeGpuInspectionReport['console'] = [];
  const pageErrors: string[] = [];
  let serverErrors: string[] = [];
  let normalized: PreparedInput | undefined;
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let sessionLease: InspectorSessionLease | undefined;
  let acquiredSession: AcquiredInspectorSession | undefined;
  let moduleUrl: string | undefined;
  let cleanupDirs: string[] = [];
  let shouldCloseBrowser = true;
  let shouldCloseServer = true;
  let browserVersion: string | undefined;
  let report: TypeGpuInspectionReport | undefined;
  let failure: { error: unknown } | undefined;

  try {
    normalized = await measureInspectionStep(
      timings,
      'prepareInputMs',
      () => withDeadline(
        prepareInspectionInput(input),
        run,
        'preparing inspection input',
      ),
    );
    cleanupDirs = normalized.cleanupDirs;
    moduleUrl = normalized.moduleUrl;

    if (normalized.reuseBrowser) {
      const acquisition = acquireInspectorSession(normalized);
      acquiredSession = await keepOrDispose(
        acquisition,
        withDeadline(
          acquisition,
          run,
          'acquiring the reusable inspector session',
          { establishment: true },
        ),
        (acquired) => acquired.release(),
      );
      timings.startViteMs = acquiredSession.timings.startViteMs;
      timings.acquireBrowserMs = acquiredSession.timings.acquireBrowserMs;
      timings.sessionReused = acquiredSession.reused;
      cleanupDirs = acquiredSession.cleanupDirs;
      // The deadline is threaded into lease() itself: a Promise.race here would
      // leave an ownerless lease behind and wedge the session queue.
      sessionLease = await acquiredSession.session.lease(normalized, {
        timeoutMs: getRemainingDeadlineMs(deadline),
        signal,
      });
      server = sessionLease.server;
      browser = sessionLease.browser;
      serverErrors = sessionLease.serverErrors;
      moduleUrl = sessionLease.moduleUrl;
      shouldCloseBrowser = false;
      shouldCloseServer = false;
      await withDeadline(
        sessionLease.context.clearCookies(),
        run,
        'resetting browser cookies',
      );
    } else {
      server = await measureInspectionStep(timings, 'startViteMs', () => {
        const starting = startInspectorViteServer(normalized!, serverErrors);
        return keepOrDispose(
          starting,
          withDeadline(starting, run, 'starting Vite', { establishment: true }),
          (viteServer) => viteServer.close(),
        );
      });
      browser = await measureInspectionStep(
        timings,
        'acquireBrowserMs',
        () => {
          const launching = launchInspectorBrowser();
          return keepOrDispose(
            launching,
            withDeadline(launching, run, 'launching Chromium', { establishment: true }),
            (launched) => launched.close(),
          );
        },
      );
    }

    // A cold session still pays for Vite's first transform and dependency
    // optimization while the harness loads, so that stays on the establishment
    // budget; a reused session runs entirely on the caller budget.
    const coldStart = timings.sessionReused !== true;
    const baseUrl = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}`;
    browserVersion = browser.version();
    page = await measureInspectionStep(
      timings,
      'openPageMs',
      () => {
        const opening = sessionLease
          ? sessionLease.context.newPage()
          : browser!.newPage(INSPECTOR_BROWSER_CONTEXT_OPTIONS);
        return keepOrDispose(
          opening,
          withDeadline(opening, run, 'opening a browser page', { establishment: coldStart }),
          (opened) => opened.close(),
        );
      },
    );
    page.on('console', (message) => {
      if (!isHarnessConsoleNoise(message.text())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.stack || error.message);
    });

    await measureInspectionStep(timings, 'loadHarnessMs', () =>
      withDeadline((async () => {
        await page!.goto(new URL(INSPECTOR_HARNESS_PATH, baseUrl).href, {
          waitUntil: 'domcontentloaded',
          timeout: 0,
        });
        await page!.waitForFunction(
          () => typeof window.__TYPEGPU_INSPECT__ === 'function',
          undefined,
          { timeout: 0 },
        );
        await page!.evaluate(() => {
          document.body.innerHTML = '';
          localStorage.clear();
          sessionStorage.clear();
        });
      })(), run, 'loading the browser harness', { establishment: coldStart }),
    );

    const browserRequest: BrowserInspectRequest = {
      moduleUrl: moduleUrl ?? normalized.moduleUrl,
      sourceKind: normalized.sourceKind,
      exportName: normalized.exportName,
      diagnosticsOnly: normalized.diagnosticsOnly,
      timeoutMs: getRemainingDeadlineMs(deadline),
      features: normalized.features,
      strictNames: normalized.strictNames,
      autoBind: normalized.autoBind,
      documentHtml: normalized.documentHtml,
      browserSetup: normalized.browserSetup,
      quiescent: normalized.quiescent,
      maxWgslBytes: input.maxWgslBytes,
      typegpuVersion: await withDeadline(
        readPackageVersionFrom(normalized.cwd, 'typegpu', normalized.dependencyResolution),
        run,
        'reading the TypeGPU package version',
      ),
    };

    const transfer = await measureInspectionStep(
      timings,
      'browserInspectionMs',
      () => withDeadline<BrowserTransferResult>(
        page!.evaluate(async (request) => {
          try {
            if (!window.__TYPEGPU_INSPECT__) {
              throw new Error('TypeGPU inspector harness did not initialize.');
            }
            const json = JSON.stringify(await window.__TYPEGPU_INSPECT__(request));
            if (json === undefined) {
              throw new Error('TypeGPU inspector harness returned an unserializable result.');
            }
            return { ok: true, json };
          } catch (error) {
            return {
              ok: false,
              error: {
                name: error instanceof Error ? error.name : undefined,
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                environmentLedger: window.__TYPEGPU_ENVIRONMENT_LEDGER__,
              },
            };
          }
        }, browserRequest) as Promise<BrowserTransferResult>,
        run,
        'running browser inspection',
      ),
    );
    if (!transfer.ok) {
      throw deserializeBrowserError(transfer.error);
    }
    const result = JSON.parse(transfer.json) as TypeGpuInspectionReport;

    const groupedConsole = groupConsoleMessages([...consoleMessages, ...result.console]);
    const stats = addInspectionTimings(
      addConsoleStats(result.stats, groupedConsole.summary),
      timings,
      inspectionStartedAt,
    );
    const allPageErrors = [...pageErrors, ...serverErrors, ...result.pageErrors];

    report = {
      ...result,
      ok: result.ok && allPageErrors.length === 0,
      environment: {
        ...result.environment,
        browserVersion,
      },
      stats,
      console: groupedConsole.messages,
      pageErrors: allPageErrors,
    };
  } catch (error) {
    failure = { error };
  } finally {
    // Cleanup runs before any retry so a cancelled or failed run never keeps
    // the page open or the session lease held.
    await page?.close().catch(() => undefined);
    await sessionLease?.release().catch(() => undefined);
    acquiredSession?.release();
    if (shouldCloseBrowser) {
      await browser?.close().catch(() => undefined);
    }
    if (shouldCloseServer) {
      await server?.close().catch(() => undefined);
    }
    for (const cleanupDir of cleanupDirs) {
      await cleanupTempDir(cleanupDir);
    }
  }

  if (report) {
    return report;
  }

  const error = failure?.error;
  if (isAbortError(error) || signal?.aborted) {
    throw isAbortError(error) ? error : createAbortError();
  }

  if (
    normalized?.reuseBrowser &&
    isReusableSessionInfrastructureError(error) &&
    hasRemainingDeadlineMs(deadline)
  ) {
    if (shouldInvalidateSession(error)) {
      await invalidateInspectorSession(normalized);
    }
    // The isolated retry continues on the same deadline, so a failed reusable
    // run plus its retry can never exceed the caller's total budget.
    return runInspection({ ...input, reuseBrowser: false }, run);
  }

  return createFailureReport(error, {
    browserVersion,
    requestedFeatures: normalized?.features ?? input.features ?? [],
    consoleMessages,
    pageErrors: [...pageErrors, ...serverErrors],
    timings: completeInspectionTimings(timings, inspectionStartedAt),
  });
}

export async function inspectTypegpuSymbols(
  input: InspectTypegpuSymbolsInput,
  options: {
    addDirectSymbolDiagnostic?: boolean;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<TypeGpuInspectionReport> {
  const normalized = normalizeSymbolInput(input);
  const symbolModule = buildSymbolInspectionModule(normalized);

  const report = await inspectTypegpuModule({
    cwd: normalized.cwd,
    source: {
      kind: 'inlineCode',
      inlineCode: symbolModule.inlineCode,
      inlineSourcePath: symbolModule.inlineSourcePath,
    },
    exportName: 'inspect',
    timeoutMs: normalized.timeoutMs,
    viteConfigPath: normalized.viteConfigPath,
    features: normalized.features,
    strictNames: normalized.strictNames,
    autoBind: normalized.autoBind,
    reuseBrowser: normalized.reuseBrowser,
    documentHtml: normalized.documentHtml,
    browserSetup: normalized.browserSetup,
    quiescent: normalized.quiescent,
    dependencyAliases: normalized.dependencyAliases,
    fsAllow: normalized.fsAllow,
    staticAssetRoutes: normalized.staticAssetRoutes,
    dependencyResolution: normalized.dependencyResolution,
    ...normalized.reportOptions,
  }, { signal: options.signal });
  const attributed = attributeSymbolFailure(report, symbolModule.requestedTargets);
  return options.addDirectSymbolDiagnostic === false
    ? attributed
    : markDirectSymbolInspection(attributed);
}

function attributeSymbolFailure(
  report: TypeGpuInspectionReport,
  requestedTargets: Array<{ label: string; kind: TypeGpuTargetReport['kind'] }>,
): TypeGpuInspectionReport {
  const only = report.targets.length === 1 ? report.targets[0] : undefined;
  const cause = report.causes?.[0];
  if (!only || only.label !== 'inspection' || !cause || requestedTargets.length === 0) {
    return report;
  }

  const targets = requestedTargets.map(({ label, kind }): TypeGpuTargetReport => {
    const target: TypeGpuTargetReport = {
      label,
      kind,
      ok: false,
      causeId: cause.id,
      error: cause.error,
      diagnostics: cause.diagnostics,
      compilationMessages: [],
      compilationSummary: {
        total: 0,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
        byType: {},
      },
      callIds: [],
    };
    target.outcome = inferTargetOutcome(target);
    return target;
  });
  return { ...report, targets };
}

async function cleanupTempDir(path: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(path, { force: true, recursive: true }).catch(() => undefined);
}

// TypeGPU's own "Found duplicate TypeGPU version." warning is deliberately
// NOT filtered: a second typegpu instance breaks slot identity (and therefore
// auto-binding), so the signal must reach reports.
function isHarnessConsoleNoise(text: string): boolean {
  return (
    text === '[vite] connecting...' ||
    text === '[vite] connected.'
  );
}

type ConsoleSummary = {
  total: number;
  warningCount: number;
  errorCount: number;
  infoCount: number;
  debugCount: number;
  byType: Record<string, number>;
};

function groupConsoleMessages(messages: TypeGpuInspectionReport['console']): {
  messages: TypeGpuInspectionReport['console'];
  summary: ConsoleSummary;
} {
  const grouped = new Map<string, { type: string; text: string; count: number }>();
  const summary: ConsoleSummary = {
    total: 0,
    warningCount: 0,
    errorCount: 0,
    infoCount: 0,
    debugCount: 0,
    byType: {},
  };

  for (const message of messages) {
    summary.total++;
    summary.byType[message.type] = (summary.byType[message.type] ?? 0) + 1;
    if (message.type === 'warning') {
      summary.warningCount++;
    } else if (message.type === 'error') {
      summary.errorCount++;
    } else if (message.type === 'info') {
      summary.infoCount++;
    } else if (message.type === 'debug') {
      summary.debugCount++;
    }

    const normalizedText = normalizeConsoleText(message.text);
    const key = `${message.type}:${normalizedText}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += message.count ?? 1;
    } else {
      grouped.set(key, {
        type: message.type,
        text: normalizedText,
        count: message.count ?? 1,
      });
    }
  }

  return {
    messages: [...grouped.values()].map((message) => ({
      type: message.type,
      text: message.text,
      count: message.count > 1 ? message.count : undefined,
    })),
    summary,
  };
}

function normalizeConsoleText(text: string): string {
  return text
    .replace(/\b\d+:\d+\b/g, '<line:col>')
    .replace(/\bline \d+\b/gi, 'line <n>')
    .replace(/\bcolumn \d+\b/gi, 'column <n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function addConsoleStats(stats: InspectionStats, summary: ConsoleSummary): InspectionStats {
  return {
    ...stats,
    consoleMessageCount: summary.total,
    consoleWarningCount: summary.warningCount,
    consoleErrorCount: summary.errorCount,
    consoleInfoCount: summary.infoCount,
    consoleDebugCount: summary.debugCount,
    consoleMessages: {
      total: summary.total,
      errorCount: summary.errorCount,
      warningCount: summary.warningCount,
      infoCount: summary.infoCount,
      byType: summary.byType,
    },
  };
}

function addInspectionTimings(
  stats: InspectionStats,
  timings: Partial<InspectionTimings>,
  startedAt: number,
): InspectionStats {
  return {
    ...stats,
    timings: completeInspectionTimings(timings, startedAt),
  };
}

function completeInspectionTimings(
  timings: Partial<InspectionTimings>,
  startedAt: number,
): InspectionTimings {
  return {
    ...timings,
    totalMs: roundTiming(performance.now() - startedAt),
  };
}

async function measureInspectionStep<T>(
  timings: Partial<InspectionTimings>,
  key: Exclude<keyof InspectionTimings, 'totalMs' | 'sessionReused'>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timings[key] = roundTiming(performance.now() - startedAt);
  }
}

function roundTiming(value: number): number {
  return Math.round(value * 10) / 10;
}

function markDirectSymbolInspection(
  report: TypeGpuInspectionReport,
): TypeGpuInspectionReport {
  const directSymbolDiagnostic: TargetDiagnostic = {
    code: 'direct-symbol-inspection',
    severity: 'note',
    message:
      'Direct symbol inspection imports the target module directly, so module-level side effects can run.',
    hint:
      'For release-critical probes or modules with app startup side effects, prefer inspect_typegpu with target.kind="probe" or target.kind="module".',
  };

  return {
    ...report,
    targets: report.targets.map((target) => {
      if (target.diagnostics?.some((diagnostic) => diagnostic.code === directSymbolDiagnostic.code)) {
        return target;
      }
      return {
        ...target,
        diagnostics: [...(target.diagnostics ?? []), directSymbolDiagnostic],
      };
    }),
  };
}

/**
 * Inspection budget bookkeeping. `timeoutMs` is the budget the caller asked for
 * and only covers the inspection itself; time spent establishing a session
 * (cold Vite boot, Chromium launch, dependency optimization) is granted back on
 * top of it, bounded so the whole run still fits inside `totalBudgetMs`.
 */
type InspectionDeadline = {
  startedAtMs: number;
  timeoutMs: number;
  totalBudgetMs: number;
  establishmentMs: number;
};

function createInspectionDeadline(timeoutMs: number): InspectionDeadline {
  return {
    startedAtMs: performance.now(),
    timeoutMs,
    totalBudgetMs: timeoutMs + MAX_SESSION_ESTABLISHMENT_MS,
    establishmentMs: 0,
  };
}

function getElapsedDeadlineMs(deadline: InspectionDeadline): number {
  return performance.now() - deadline.startedAtMs;
}

function getDeadlineBudgetMs(deadline: InspectionDeadline): number {
  const grantedMs = Math.min(
    deadline.establishmentMs,
    deadline.totalBudgetMs - deadline.timeoutMs,
  );
  return deadline.timeoutMs + grantedMs;
}

function hasRemainingDeadlineMs(deadline: InspectionDeadline): boolean {
  return getDeadlineBudgetMs(deadline) - getElapsedDeadlineMs(deadline) > 0;
}

function getRemainingDeadlineMs(deadline: InspectionDeadline): number {
  const remainingMs = Math.ceil(getDeadlineBudgetMs(deadline) - getElapsedDeadlineMs(deadline));
  if (remainingMs <= 0) {
    throw new Error(`TypeGPU inspection timed out after ${deadline.timeoutMs}ms.`);
  }
  return remainingMs;
}

function getRemainingEstablishmentMs(deadline: InspectionDeadline): number {
  const remainingMs = Math.ceil(deadline.totalBudgetMs - getElapsedDeadlineMs(deadline));
  if (remainingMs <= 0) {
    throw new Error(
      `TypeGPU inspection timed out after ${deadline.totalBudgetMs}ms while establishing an inspector session.`,
    );
  }
  return remainingMs;
}

async function withDeadline<T>(
  promise: Promise<T>,
  run: InspectionRun,
  step: string,
  options: { establishment?: boolean } = {},
): Promise<T> {
  const { deadline, signal } = run;
  if (!options.establishment) {
    return withTimeout(
      promise,
      getRemainingDeadlineMs(deadline),
      `TypeGPU inspection timed out after ${deadline.timeoutMs}ms while ${step}.`,
      signal,
    );
  }

  const startedAt = performance.now();
  try {
    return await withTimeout(
      promise,
      getRemainingEstablishmentMs(deadline),
      `TypeGPU inspection timed out after ${deadline.totalBudgetMs}ms while ${step}.`,
      signal,
    );
  } finally {
    deadline.establishmentMs += performance.now() - startedAt;
  }
}

/**
 * Disposes a resource whose creation only finished after its deadline expired,
 * so a timed-out or cancelled run never leaks a session reservation, a Vite
 * server, a Chromium process, or a page.
 */
async function keepOrDispose<T>(
  created: Promise<T>,
  waited: Promise<T>,
  dispose: (value: T) => unknown,
): Promise<T> {
  try {
    return await waited;
  } catch (error) {
    void created.then(
      (value) => Promise.resolve(dispose(value)).catch(() => undefined),
      () => undefined,
    );
    throw error;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal | undefined,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          reject(createAbortError());
          return;
        }
        onAbort = () => reject(createAbortError());
        signal.addEventListener('abort', onAbort);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

async function readPackageVersionFrom(
  cwd: string,
  packageName: string,
  dependencyResolution?: PreparedInput['dependencyResolution'],
): Promise<string | undefined> {
  try {
    const packageJsonPath = resolvePackagePathFrom(
      cwd,
      `${packageName}/package.json`,
      dependencyResolution,
    );
    const packageJson = await readPackageJSON(packageJsonPath);
    return typeof packageJson.version === 'string' ? packageJson.version : undefined;
  } catch {
    return undefined;
  }
}

function createFailureReport(
  error: unknown,
  options: {
    browserVersion?: string | undefined;
    requestedFeatures: string[];
    consoleMessages: TypeGpuInspectionReport['console'];
    pageErrors: string[];
    timings: InspectionTimings;
  },
): TypeGpuInspectionReport {
  const groupedConsole = groupConsoleMessages(options.consoleMessages);
  const diagnostics = diagnoseInspectionFailure(error);
  const serializedError = serializeFailureError(error)!;
  const firstDiagnostic = diagnostics[0];
  const environmentFailure = firstDiagnostic?.code === 'canvas-dom-setup-required' ||
    firstDiagnostic?.code === 'browser-capability-unavailable' ||
    readFailureEnvironmentLedger(error)?.some((entry) =>
      entry.tier === 'environment' && entry.status === 'unsatisfied'
    ) === true;
  const environmentLedger = readFailureEnvironmentLedger(error);
  const effectiveDiagnostics = diagnostics.length > 0
    ? diagnostics
    : environmentFailure
    ? [{
        code: 'browser-capability-unavailable',
        message: 'A browser capability required during module import was unavailable.',
        hint: serializedError.message,
      }]
    : [];
  const effectiveFirstDiagnostic = effectiveDiagnostics[0];
  const cause: InspectionCause = {
    id: 'inspection-cause-1',
    tier: environmentFailure ? 'environment' as const : 'module' as const,
    code: effectiveFirstDiagnostic?.code ?? 'module-load-failed',
    message: effectiveFirstDiagnostic?.message ?? serializedError.message,
    error: serializedError,
    diagnostics: effectiveDiagnostics.length > 0 ? effectiveDiagnostics : undefined,
    ledger: [{
      tier: environmentFailure ? 'environment' as const : 'module' as const,
      kind: environmentFailure ? 'dom-setup' as const : 'module-load' as const,
      key: environmentFailure ? 'environment:browser-capability' : 'module:load',
      status: 'unsatisfied' as const,
      discoveredBy: 'failure' as const,
      detail: { message: serializedError.message },
    }],
  };
  if (environmentLedger?.length) {
    cause.ledger = [...environmentLedger, ...(cause.ledger ?? [])];
  }
  const inspectionTarget: TypeGpuTargetReport = {
    label: 'inspection',
    kind: 'resolvable',
    ok: false,
    causeId: cause.id,
    error: serializedError,
    diagnostics: effectiveDiagnostics.length > 0 ? effectiveDiagnostics : undefined,
    compilationMessages: [],
    compilationSummary: {
      total: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      byType: {},
    },
    callIds: [],
  };
  inspectionTarget.outcome = inferTargetOutcome(inspectionTarget);
  return {
    ok: false,
    causes: [cause],
    ledger: environmentLedger,
    environment: {
      browserVersion: options.browserVersion,
      requestedFeatures: options.requestedFeatures,
      enabledFeatures: [],
    },
    targets: [inspectionTarget],
    stats: {
      ...addConsoleStats(emptyStats(), groupedConsole.summary),
      timings: options.timings,
    },
    calls: [],
    console: groupedConsole.messages,
    pageErrors: options.pageErrors,
  };
}

function serializeFailureError(error: unknown): TypeGpuInspectionReport['targets'][number]['error'] {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: getErrorMessage(error) };
}

function deserializeBrowserError(error: {
  name?: string | undefined;
  message: string;
  stack?: string | undefined;
  environmentLedger?: TypeGpuInspectionReport['ledger'];
}): Error {
  const deserialized = new Error(error.message);
  deserialized.name = error.name ?? 'Error';
  if (error.stack) {
    deserialized.stack = error.stack;
  }
  if (error.environmentLedger) {
    (deserialized as Error & { environmentLedger?: TypeGpuInspectionReport['ledger'] })
      .environmentLedger = error.environmentLedger;
  }
  return deserialized;
}

function readFailureEnvironmentLedger(
  error: unknown,
): TypeGpuInspectionReport['ledger'] | undefined {
  if (!error || typeof error !== 'object' || !('environmentLedger' in error)) {
    return undefined;
  }
  const ledger = (error as { environmentLedger?: unknown }).environmentLedger;
  return Array.isArray(ledger) ? ledger as TypeGpuInspectionReport['ledger'] : undefined;
}

function shouldInvalidateSession(error: unknown): boolean {
  return !(error instanceof SessionInfrastructureError) || error.invalidateSession;
}

function isReusableSessionInfrastructureError(error: unknown): boolean {
  if (error instanceof SessionInfrastructureError) {
    return true;
  }

  // Fallback for Playwright/Vite failures this package does not construct.
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('reusable typegpu inspector session is closed') ||
    message.includes('target page, context or browser has been closed') ||
    message.includes('browser has been closed') ||
    message.includes('page has been closed') ||
    message.includes('context has been closed') ||
    message.includes('net::err_connection_refused') ||
    message.includes('typegpu inspector harness did not initialize')
  );
}

function emptyStats(): InspectionStats {
  return {
    shaderModuleCount: 0,
    computePipelineCount: 0,
    renderPipelineCount: 0,
    pipelineCount: 0,
    bindGroupLayoutCount: 0,
    explicitBindGroupLayoutCount: 0,
    inferredCatchallBindGroupLayoutCount: 0,
    bindingCounts: {
      total: 0,
      byResourceType: {},
      byVisibility: {},
    },
    compilationMessageCount: 0,
    compilationErrorCount: 0,
    compilationWarningCount: 0,
    compilationInfoCount: 0,
    compilationMessages: {
      total: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      byType: {},
    },
    consoleMessageCount: 0,
    consoleWarningCount: 0,
    consoleErrorCount: 0,
    consoleInfoCount: 0,
    consoleDebugCount: 0,
    consoleMessages: {
      total: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      byType: {},
    },
  };
}
