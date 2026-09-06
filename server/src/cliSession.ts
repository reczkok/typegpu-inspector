import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import chokidar from 'chokidar';
import type { CliSeverity, GlobalOptions, RuntimeOptions } from './cliArgs.js';
import {
  collectSourceFiles,
  isIgnoredUnder,
  isSourceFile,
  type CollectedFiles,
  type CollectOptions,
} from './cliFiles.js';
import type { InteractiveUi } from './cliInteractive.js';
import {
  displayPath,
  filterBySeverity,
  foldModuleFailures,
  plural,
  summarizeCheck,
  toCliDiagnostics,
  type CheckResult,
  type CliConsoleMessage,
  type CliDiagnostic,
  type CliFileResult,
  type CliTargetStatus,
  type TextStyle,
} from './cliOutput.js';
import { discoverTypeGpuModule, type DiscoveredModule, type InspectionTarget } from './discovery.js';
import { describeTargets } from './editorRequests.js';
import { collectImportedShaderSymbols, resolveImport } from './moduleGraph.js';
import { defaultSettings, type InspectorOutput, type InspectorSettings } from './protocol.js';
import { mergeSettings, type SettingsWarning } from './settings.js';
import {
  createDiagnostics,
  defaultSurfaceOptions,
  failedTargetInspection,
  materializeInspection,
  type DocumentInspection,
  type SurfaceOptions,
} from './surface.js';

export type RuntimeLike = {
  inspect(modulePath: string, targets: InspectionTarget[], signal?: AbortSignal): Promise<InspectorOutput>;
  /** Imports the module without targets and reports what happened. */
  evaluate(modulePath: string, signal?: AbortSignal): Promise<InspectorOutput>;
  close(): Promise<void>;
};

export type FileChangeListener = (changedPaths: string[]) => void;

/** A progress indicator on stderr; the default is a spinner on a terminal. */
export type ProgressReporter = {
  update(text: string): void;
  stop(): void;
};

export type CliIo = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  createRuntime(workspaceRoot: string, settings: () => InspectorSettings): RuntimeLike;
  createProgress?: () => ProgressReporter;
  /** The prompts an interactive session talks through; absent when none can be shown. */
  createInteractiveUi?: () => Promise<InteractiveUi>;
  /** Fires on Ctrl-C; absent when nothing can interrupt the run. */
  onInterrupt?: (listener: () => void) => () => void;
  /** Subscribes to changes under the given files and directories; returns an unsubscribe. */
  watch?: (
    files: readonly string[],
    directories: readonly string[],
    listener: FileChangeListener,
  ) => () => void;
};

// --- session ----------------------------------------------------------------

export type Session = {
  io: CliIo;
  root: string;
  settings: InspectorSettings;
  surface: SurfaceOptions;
  runtime: RuntimeLike;
  abort: AbortController;
  interrupted: boolean;
  warmed: boolean;
  /** Progress on stderr, silent when quiet. */
  progress(message: string): void;
  /** Clears the progress indicator before something else is written. */
  settle(): void;
  /** Stderr unless quiet. */
  note(message: string): void;
  close(): Promise<void>;
};

export type SessionOptions = GlobalOptions & { runtime: RuntimeOptions };

export function createSession(options: SessionOptions, io: CliIo): Session {
  const warnings: SettingsWarning[] = [];
  const root = options.runtime.projectRoot !== undefined
    ? resolve(io.cwd, options.runtime.projectRoot)
    : io.cwd;
  const settings = mergeSettings(
    {
      inspectOn: 'save',
      warmUpOnOpen: false,
      projectRoot: root,
      features: options.runtime.features,
      strictNames: options.runtime.strictNames,
      sourceMapping: options.runtime.sourceMapping,
      ...(options.runtime.timeoutMs !== undefined ? { timeoutMs: options.runtime.timeoutMs } : {}),
      ...(options.runtime.inspectorPackage !== undefined
        ? { inspectorPackage: options.runtime.inspectorPackage }
        : {}),
    },
    defaultSettings,
    warnings,
  );
  const reporter = options.quiet ? undefined : io.createProgress?.();
  const settle = () => reporter?.stop();
  const note = (message: string) => {
    if (options.quiet) return;
    settle();
    io.stderr(`${message}\n`);
  };
  for (const warning of warnings) {
    note(`Ignoring invalid setting "${warning.key}": ${warning.detail}`);
  }
  const runtime = io.createRuntime(root, () => settings);
  const abort = new AbortController();
  let stopInterrupt: (() => void) | undefined;
  const session: Session = {
    io,
    root,
    settings,
    surface: {
      ...defaultSurfaceOptions,
      sourceMapping: settings.sourceMapping,
      schemaLayoutHealth: settings.schemaLayoutHealth,
      schemaPackingSuggestions: settings.schemaPackingSuggestions,
      saveAffordance: false,
      presentation: 'zed',
    },
    runtime,
    abort,
    interrupted: false,
    warmed: false,
    progress: (message) => reporter?.update(message),
    settle,
    note,
    close: async () => {
      settle();
      stopInterrupt?.();
      // Bounded: a wedged runtime child must not keep the shell waiting.
      await Promise.race([
        runtime.close().catch(() => undefined),
        new Promise((done) => setTimeout(done, 2_000)),
      ]);
    },
  };
  stopInterrupt = io.onInterrupt?.(() => {
    session.interrupted = true;
    abort.abort();
  });
  return session;
}

// --- inspection -------------------------------------------------------------

export type InspectedModule = {
  path: string;
  discovered: DiscoveredModule;
  /** The targets this inspection covered; a subset when the run was narrowed. */
  targetIds: string[];
  inspection: DocumentInspection;
  /** What the module wrote to the console; the materialized inspection drops it. */
  console: CliConsoleMessage[];
  elapsedMs: number;
};

export async function discoverModule(path: string): Promise<DiscoveredModule> {
  return discoverTypeGpuModule(path, await readFile(path, 'utf8'));
}

export async function inspectModule(
  session: Session,
  path: string,
  discovered: DiscoveredModule,
  targets: InspectionTarget[] = discovered.targets,
): Promise<InspectedModule> {
  const startedAt = Date.now();
  const targetIds = targets.map((target) => target.id);
  const shown = displayPath(path, session.io.cwd);
  session.progress(
    session.warmed
      ? `Inspecting ${shown} (${plural(targets.length, 'target')})`
      : `Starting the runtime inspector for ${shown}. A first run on this machine downloads Chromium (about 170 MB).`,
  );
  let inspection: DocumentInspection;
  let console: CliConsoleMessage[] = [];
  try {
    const output = await interruptible(
      session.runtime.inspect(path, targets, session.abort.signal),
      session.abort.signal,
    );
    session.warmed = true;
    console = consoleMessages(output.console);
    inspection = await materializeInspection(session.root, path, 1, discovered, output, targetIds);
  } catch (error) {
    if (session.interrupted) throw error;
    // The module never ran, so the account belongs to the module, once; the
    // targets still read as failed.
    const message = errorMessage(error);
    inspection = { ...failedTargetInspection(1, targetIds, message), failure: message };
  }
  return { path, discovered, targetIds, inspection, console, elapsedMs: Date.now() - startedAt };
}

export type CheckOptions = {
  minSeverity: CliSeverity;
  warningsAsErrors: boolean;
  requireConcrete?: boolean;
};

export function fileResult(session: Session, module: InspectedModule, minSeverity: CliSeverity): CliFileResult {
  const { path, discovered, inspection } = module;
  const externalSymbols = session.settings.sourceMapping && discovered.imports.length > 0
    ? collectImportedShaderSymbols(path, discovered)
    : [];
  const diagnostics = createDiagnostics(
    pathToFileURL(path).href,
    discovered,
    inspection,
    session.surface,
    externalSymbols,
  );
  const covered = new Set(module.targetIds);
  const described = describeTargets(1, discovered, inspection, new Set());
  const targets: CliTargetStatus[] = described.targets.filter((target) => covered.has(target.id)).map((target) => {
    const materialized = inspection.targets.get(target.id);
    const generatedUri = materialized?.generatedUri;
    // Older/custom runtimes without confidence metadata cannot certify a
    // concrete pass. Keep their successful result explicitly qualified.
    const outcome = materialized?.report.outcome ??
      (materialized?.report.ok ? 'passed-with-assumptions' : undefined);
    const notes = outcome === 'blocked' || outcome === 'unsupported'
      ? materialized?.report.diagnostics?.filter((diagnostic) => diagnostic.severity !== 'note').map((diagnostic) => ({
        code: diagnostic.code,
        message: [diagnostic.message, diagnostic.hint].filter(Boolean).join(' '),
      }))
      : undefined;
    return {
      id: target.id,
      label: target.label,
      ...(target.kind !== undefined ? { kind: target.kind } : {}),
      status: outcome === 'blocked' || outcome === 'unsupported'
        ? outcome
        : target.status === 'ok' ? 'ok' : target.status === 'failed' ? 'failed' : 'not-inspected',
      ...(outcome ? { outcome } : {}),
      ...(notes?.length ? { notes } : {}),
      ...(target.wgslLines !== undefined ? { wgslLines: target.wgslLines } : {}),
      ...(generatedUri ? { generatedWgsl: displayPath(generatedUri, session.io.cwd) } : {}),
    };
  });
  const output = module.console;
  return {
    path: displayPath(path, session.io.cwd),
    targets,
    diagnostics: filterBySeverity(
      foldModuleFailures(
        toCliDiagnostics(path, diagnostics.filter((diagnostic) => coversTarget(diagnostic, covered)), session.io.cwd),
        module.targetIds.length,
      ),
      minSeverity,
    ),
    ...(output.length > 0 ? { console: output } : {}),
    elapsedMs: module.elapsedMs,
  };
}

function consoleMessages(entries: InspectorOutput['console']): CliConsoleMessage[] {
  return (entries ?? []).flatMap((entry) => {
    if (typeof entry.text !== 'string') return [];
    return [{
      type: entry.type ?? 'log',
      text: entry.text,
      ...(typeof entry.count === 'number' && entry.count > 1 ? { count: entry.count } : {}),
    }];
  });
}

/** A module to inspect, optionally narrowed to some of its targets. */
export type ModuleEntry = readonly [string, DiscoveredModule, InspectionTarget[]?];

/** A diagnostic about a target outside the narrowed run says nothing about it. */
function coversTarget(diagnostic: { data?: unknown }, covered: ReadonlySet<string>): boolean {
  const data = diagnostic.data;
  if (typeof data !== 'object' || data === null) return true;
  const targetId = (data as { targetId?: unknown }).targetId;
  return typeof targetId !== 'string' || covered.has(targetId);
}

/**
 * Narrows modules to the targets named by label or symbol name; modules
 * without a match drop out. Names that match nothing come back separately.
 */
export function selectTargets(
  modules: ReadonlyArray<ModuleEntry>,
  names: readonly string[],
): { selected: ModuleEntry[]; unmatched: string[] } {
  if (names.length === 0) return { selected: [...modules], unmatched: [] };
  const matched = new Set<string>();
  const selected: ModuleEntry[] = [];
  for (const [path, discovered] of modules) {
    const targets = discovered.targets.filter((target) => {
      const hits = names.filter((name) => name === target.label || target.symbolNames.includes(name));
      for (const hit of hits) matched.add(hit);
      return hits.length > 0;
    });
    if (targets.length > 0) selected.push([path, discovered, targets]);
  }
  return { selected, unmatched: names.filter((name) => !matched.has(name)) };
}

export async function checkModules(
  session: Session,
  modules: ReadonlyArray<ModuleEntry>,
  options: CheckOptions,
  evaluate: readonly string[] = [],
): Promise<CheckResult> {
  const startedAt = Date.now();
  const files: CliFileResult[] = [];
  for (const [path, discovered, targets] of modules) {
    if (session.interrupted) break;
    const module = await inspectModule(session, path, discovered, targets);
    files.push(fileResult(session, module, 'hint'));
  }
  for (const path of evaluate) {
    if (session.interrupted) break;
    files.push(await evaluateModule(session, path, 'hint'));
  }
  const result = summarizeCheck(files, Date.now() - startedAt, options.warningsAsErrors);
  if (options.requireConcrete) {
    result.requireConcrete = true;
    if (result.summary.assumed > 0 || result.summary.targets === 0) result.ok = false;
  }
  return {
    ...result,
    files: result.files.map((file) => ({
      ...file,
      diagnostics: filterBySeverity(file.diagnostics, options.minSeverity),
    })),
  };
}

const TYPEGPU_SPECIFIER = /^(typegpu|@typegpu\/)/;

/**
 * Files that use TypeGPU without declaring a target: a module whose pipelines
 * are built inside a factory, say. Discovery skips them; `--evaluate` runs
 * them.
 */
export async function modulesToEvaluate(
  files: readonly string[],
  modules: ReadonlyMap<string, DiscoveredModule>,
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    if (modules.has(file)) continue;
    let discovered: DiscoveredModule;
    try {
      discovered = await discoverModule(file);
    } catch {
      continue;
    }
    if (discovered.imports.some((edge) => TYPEGPU_SPECIFIER.test(edge.specifier))) paths.push(file);
  }
  return paths;
}

/**
 * Imports the module and reports whether it threw, what its GPU calls came
 * back with, and what it wrote to the console. Mapped initialization failures
 * retain their authored source; otherwise the module's first line is the fallback.
 */
export async function evaluateModule(
  session: Session,
  path: string,
  minSeverity: CliSeverity,
): Promise<CliFileResult> {
  const startedAt = Date.now();
  const shown = displayPath(path, session.io.cwd);
  session.progress(
    session.warmed
      ? `Evaluating ${shown}`
      : `Starting the runtime inspector for ${shown}. A first run on this machine downloads Chromium (about 170 MB).`,
  );
  let output: InspectorOutput | undefined;
  let failure: string | undefined;
  try {
    output = await interruptible(session.runtime.evaluate(path, session.abort.signal), session.abort.signal);
    session.warmed = true;
  } catch (error) {
    if (session.interrupted) throw error;
    failure = errorMessage(error);
  }

  const diagnostics: CliDiagnostic[] = [];
  const seen = new Set<string>();
  const report = (severity: CliSeverity, code: string, message: string, error?: unknown) => {
    const key = `${severity}|${code}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const source = failureSourceLocation(error, session.io.cwd);
    diagnostics.push({ path: shown, line: 1, column: 1, endLine: 1, endColumn: 1, severity, code, message, related: [],
      ...(source ? { ...source, endLine: source.line, endColumn: source.column, affectedModules: [shown] } : {}) });
  };
  if (failure !== undefined) report('error', 'module-evaluation', failure);
  if (output) {
    const causeErrors = new Set<string>();
    for (const cause of output.causes ?? []) {
      const environment = cause.tier === 'environment';
      report(environment ? 'hint' : 'error', environment ? 'inspection-unavailable' : 'target-resolution', cause.message, cause.error);
      causeErrors.add(cause.message);
      const errorMessage = readMessage(cause.error);
      if (errorMessage) causeErrors.add(errorMessage);
      if (cause.error && typeof cause.error === 'object' && 'stack' in cause.error && typeof cause.error.stack === 'string') {
        causeErrors.add(cause.error.stack);
      }
    }
    for (const pageError of output.pageErrors ?? []) {
      const head = pageError.split('\n')[0]!.replace(/^[A-Za-z]*Error: /, '');
      if (!causeErrors.has(pageError) && !causeErrors.has(head)) report('error', 'module-evaluation', pageError);
    }
    for (const call of output.calls ?? []) {
      const name = call.name ?? 'GPU call';
      const callError = readMessage(call.error);
      if (call.ok === false && callError !== undefined) report('error', 'module-evaluation', `${name}: ${callError}`);
      for (const message of call.compilationMessages ?? []) {
        if (typeof message.message !== 'string') continue;
        const severity: CliSeverity = message.type === 'error' ? 'error' : message.type === 'warning' ? 'warning' : 'info';
        report(severity, 'wgsl-compilation', `${name}: ${message.message}`);
      }
    }
    if (!output.ok && diagnostics.length === 0) {
      report('error', 'module-evaluation', readMessage(output.error) ?? 'The module did not evaluate cleanly.');
    }
  }
  const failed = failure !== undefined || output?.ok === false ||
    diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const console = output ? consoleMessages(output.console) : [];
  return {
    path: shown,
    targets: [{ id: 'module', label: basename(path), kind: 'module',
      status: failed ? (output?.causes?.length ? 'blocked' : 'failed') : 'ok',
      outcome: failed ? (output?.causes?.length ? 'blocked' : 'failed') : 'passed-with-assumptions',
      notes: failed
        ? (output?.causes ?? []).map((cause) => ({ code: cause.code, message: cause.message }))
        : [{ code: 'module-evaluation', message: 'The module evaluated, but no requested shader or pipeline was validated.' }],
    }],
    diagnostics: filterBySeverity(diagnostics, minSeverity),
    ...(console.length > 0 ? { console } : {}),
    elapsedMs: Date.now() - startedAt,
  };
}

function failureSourceLocation(error: unknown, cwd: string): { path: string; line: number; column: number } | undefined {
  if (!error || typeof error !== 'object' || !('sourceLocation' in error)) return undefined;
  const source = error.sourceLocation;
  if (!source || typeof source !== 'object' || !('path' in source) || !('line' in source) || !('column' in source)) return undefined;
  if (typeof source.path !== 'string' || typeof source.line !== 'number' || typeof source.column !== 'number' ||
      !Number.isInteger(source.line) || !Number.isInteger(source.column) || source.line < 1 || source.column < 1) return undefined;
  return { path: displayPath(source.path, cwd), line: source.line, column: source.column };
}

function readMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

export function textStyle(
  options: GlobalOptions & { verbose?: boolean; console?: boolean },
  io: CliIo,
): TextStyle {
  const color = options.color ??
    (io.stdoutIsTTY && !io.env.NO_COLOR && io.env.TERM !== 'dumb');
  return { color, verbose: options.verbose ?? false, console: options.console ?? false };
}

export async function collectOrExplain(
  paths: readonly string[],
  io: CliIo,
  quiet: boolean,
  options: CollectOptions = {},
): Promise<CollectedFiles | undefined> {
  const collected = await collectSourceFiles(paths, io.cwd, options);
  for (const missing of collected.missing) {
    io.stderr(`No such file or directory: ${missing}\n`);
  }
  if (collected.files.length === 0) {
    if (collected.missing.length === 0 && !quiet) {
      io.stderr(`No source files match ${paths.map((path) => JSON.stringify(path)).join(', ')}.\n`);
    }
    return undefined;
  }
  return collected;
}

/** Modules with at least one inspectable target; discovery only, nothing runs. */
export async function discoverTargets(files: readonly string[]): Promise<Map<string, DiscoveredModule>> {
  const modules = new Map<string, DiscoveredModule>();
  for (const file of files) {
    let discovered: DiscoveredModule;
    try {
      discovered = await discoverModule(file);
    } catch {
      continue;
    }
    if (discovered.targets.length > 0) modules.set(file, discovered);
  }
  return modules;
}

/** Rejects on abort without waiting for the runtime to notice; close() tears it down. */
function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (!signal.aborted) {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error('Interrupted.'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
  return Promise.reject(signal.reason ?? new Error('Interrupted.'));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- watch ------------------------------------------------------------------

const WATCH_DEBOUNCE_MS = 250;
const DEPENDENCY_DEPTH = 4;

export type WatchOptions = {
  paths: readonly string[];
  files?: CollectOptions;
  collected: CollectedFiles;
  /** Kept current as files gain or lose targets. */
  modules: Map<string, DiscoveredModule>;
  /** Ends the watch. */
  signal: AbortSignal;
  /** Called with the modules a change reaches and the names of the changed files. */
  onAffected(affected: ReadonlyArray<ModuleEntry>, changedNames: readonly string[]): Promise<void>;
  onError?(message: string): void;
};

/**
 * Reports the modules to re-check when a file or something it imports
 * changes. A file that only exports helpers is never inspected on its own;
 * editing it reaches the modules that inline those helpers.
 */
export async function watchModules(session: Session, options: WatchOptions): Promise<void> {
  const io = session.io;
  const { modules } = options;
  let dependents = await dependentsOf(modules);
  let known = new Set(options.collected.files);
  let running = Promise.resolve();
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const handleChanges = async (changed: string[]): Promise<void> => {
    if (options.signal.aborted) return;
    const fresh = await collectSourceFiles(options.paths, io.cwd, options.files);
    const added = fresh.files.filter((file) => !known.has(file));
    known = new Set(fresh.files);
    const candidates = new Set<string>();
    for (const path of [...changed, ...added]) {
      if (known.has(path)) candidates.add(path);
      for (const dependent of dependents.get(path) ?? []) candidates.add(dependent);
    }
    const affected: ModuleEntry[] = [];
    for (const path of [...candidates].sort()) {
      let discovered: DiscoveredModule | undefined;
      if (known.has(path)) {
        try {
          discovered = await discoverModule(path);
        } catch {
          discovered = undefined;
        }
      }
      if (!discovered || discovered.targets.length === 0) {
        modules.delete(path);
        continue;
      }
      modules.set(path, discovered);
      affected.push([path, discovered]);
    }
    dependents = await dependentsOf(modules);
    if (affected.length === 0 || options.signal.aborted) return;
    await options.onAffected(affected, changed.map((path) => basename(path)));
  };

  const flush = () => {
    const changed = [...pending];
    pending = new Set();
    running = running
      .then(() => handleChanges(changed))
      .catch((error: unknown) => {
        if (!options.signal.aborted) options.onError?.(errorMessage(error));
      });
  };

  const unsubscribe = io.watch!(options.collected.files, options.collected.directories, (paths) => {
    for (const path of paths) {
      if (isSourceFile(path)) pending.add(path);
    }
    if (pending.size === 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  });

  await new Promise<void>((done) => {
    if (options.signal.aborted) {
      done();
      return;
    }
    options.signal.addEventListener('abort', () => done(), { once: true });
  });
  if (timer) clearTimeout(timer);
  unsubscribe();
  await running.catch(() => undefined);
}

export function describeWatchScope(paths: readonly string[]): string {
  return paths.map((path) => (path === '.' ? 'the current directory' : path)).join(', ');
}

/** Reverse import map: a file → the modules with targets whose imports reach it. */
async function dependentsOf(
  modules: ReadonlyMap<string, DiscoveredModule>,
): Promise<Map<string, Set<string>>> {
  const dependents = new Map<string, Set<string>>();
  const cache = new Map<string, DiscoveredModule | undefined>();
  const moduleAt = async (path: string): Promise<DiscoveredModule | undefined> => {
    if (cache.has(path)) return cache.get(path);
    let discovered: DiscoveredModule | undefined;
    try {
      discovered = modules.get(path) ?? await discoverModule(path);
    } catch {
      discovered = undefined;
    }
    cache.set(path, discovered);
    return discovered;
  };
  for (const [entry, discovered] of modules) {
    const queue: Array<{ path: string; module: DiscoveredModule; depth: number }> = [
      { path: entry, module: discovered, depth: 0 },
    ];
    const seen = new Set([entry]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= DEPENDENCY_DEPTH) continue;
      for (const edge of current.module.imports) {
        const resolved = resolveImport(edge.specifier, current.path);
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        let set = dependents.get(resolved);
        if (!set) dependents.set(resolved, set = new Set());
        set.add(entry);
        const module = await moduleAt(resolved);
        if (module) queue.push({ path: resolved, module, depth: current.depth + 1 });
      }
    }
  }
  return dependents;
}

export function watchWithChokidar(
  files: readonly string[],
  directories: readonly string[],
  listener: FileChangeListener,
): () => void {
  const watcher = chokidar.watch([...directories, ...files], {
    ignoreInitial: true,
    ignored: (path) => directories.some((directory) => isIgnoredUnder(directory, path)),
  });
  watcher.on('all', (event, path) => {
    if (event === 'add' || event === 'change' || event === 'unlink') listener([resolve(path)]);
  });
  watcher.on('error', () => undefined);
  return () => {
    void watcher.close();
  };
}
