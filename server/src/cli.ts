import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import chokidar from 'chokidar';
import yoctoSpinner from 'yocto-spinner';
import {
  parseCliArgs,
  type CheckCommand,
  type GlobalOptions,
  type ReportCommand,
  type RuntimeOptions,
  type TargetsCommand,
  type WgslCommand,
} from './cliArgs.js';
import { collectSourceFiles, isIgnoredUnder, isSourceFile, type CollectedFiles } from './cliFiles.js';
import {
  colors,
  displayPath,
  filterBySeverity,
  formatCheckGithub,
  formatCheckJson,
  formatCheckText,
  plural,
  summarizeCheck,
  toCliDiagnostics,
  type CheckResult,
  type CliFileResult,
  type CliTargetStatus,
  type TextStyle,
} from './cliOutput.js';
import { discoverTypeGpuModule, type DiscoveredModule, type InspectionTarget } from './discovery.js';
import { describeTargets, generatedWgsl, targetReport } from './editorRequests.js';
import { RuntimeInspectorClient } from './mcpInspector.js';
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
  stdoutIsTTY: boolean;
  createRuntime(workspaceRoot: string, settings: () => InspectorSettings): RuntimeLike;
  createProgress?: () => ProgressReporter;
  /** Fires on Ctrl-C; absent when nothing can interrupt the run. */
  onInterrupt?: (listener: () => void) => () => void;
  /** Subscribes to changes under the given files and directories; returns an unsubscribe. */
  watch?: (
    files: readonly string[],
    directories: readonly string[],
    listener: FileChangeListener,
  ) => () => void;
};

export function defaultCliIo(): CliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdoutIsTTY: process.stdout.isTTY === true,
    createRuntime: (workspaceRoot, settings) => new RuntimeInspectorClient(workspaceRoot, settings),
    createProgress: () => {
      if (!process.stderr.isTTY) {
        // A log or an agent gets one plain line per step, never a redraw.
        let last: string | undefined;
        return {
          update: (text) => {
            if (text === last) return;
            last = text;
            process.stderr.write(`${text}\n`);
          },
          stop: () => undefined,
        };
      }
      const spinner = yoctoSpinner({ stream: process.stderr });
      return {
        update: (text) => {
          spinner.text = text;
          if (!spinner.isSpinning) spinner.start();
        },
        stop: () => {
          if (spinner.isSpinning) spinner.stop();
        },
      };
    },
    onInterrupt: (listener) => {
      process.on('SIGINT', listener);
      process.on('SIGTERM', listener);
      return () => {
        process.off('SIGINT', listener);
        process.off('SIGTERM', listener);
      };
    },
    watch: watchWithChokidar,
  };
}

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

export async function runCli(argv: readonly string[], io: CliIo = defaultCliIo()): Promise<number> {
  const parsed = await parseCliArgs(argv, io, __TYPEGPU_SERVER_VERSION__);
  if (!parsed.ok) return parsed.exitCode;
  const { command } = parsed;
  switch (command.command) {
    case 'targets':
      return runTargets(command, io);
    case 'check':
      return runCheck(command, io);
    case 'wgsl':
      return runWgsl(command, io);
    case 'report':
      return runReport(command, io);
  }
}

// --- session ----------------------------------------------------------------

type Session = {
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

function createSession(options: GlobalOptions & { runtime: RuntimeOptions }, io: CliIo): Session {
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

type InspectedModule = {
  path: string;
  discovered: DiscoveredModule;
  inspection: DocumentInspection;
  elapsedMs: number;
};

async function discoverModule(path: string): Promise<DiscoveredModule> {
  return discoverTypeGpuModule(path, await readFile(path, 'utf8'));
}

async function inspectModule(
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
  try {
    const output = await session.runtime.inspect(path, targets, session.abort.signal);
    session.warmed = true;
    inspection = await materializeInspection(session.root, path, 1, discovered, output, targetIds);
  } catch (error) {
    if (session.interrupted) throw error;
    inspection = failedTargetInspection(1, targetIds, errorMessage(error));
  }
  return { path, discovered, inspection, elapsedMs: Date.now() - startedAt };
}

function fileResult(session: Session, module: InspectedModule, command: CheckCommand): CliFileResult {
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
  const described = describeTargets(1, discovered, inspection, new Set());
  const targets: CliTargetStatus[] = described.targets.map((target) => {
    const generatedUri = inspection.targets.get(target.id)?.generatedUri;
    return {
      id: target.id,
      label: target.label,
      ...(target.kind !== undefined ? { kind: target.kind } : {}),
      status: target.status === 'ok' ? 'ok' : target.status === 'failed' ? 'failed' : 'not-inspected',
      ...(target.wgslLines !== undefined ? { wgslLines: target.wgslLines } : {}),
      ...(generatedUri ? { generatedWgsl: displayPath(generatedUri, session.io.cwd) } : {}),
    };
  });
  return {
    path: displayPath(path, session.io.cwd),
    targets,
    diagnostics: filterBySeverity(
      toCliDiagnostics(path, diagnostics, session.io.cwd),
      command.minSeverity,
    ),
    elapsedMs: module.elapsedMs,
  };
}

function textStyle(options: GlobalOptions & { verbose?: boolean }, io: CliIo): TextStyle {
  const color = options.color ??
    (io.stdoutIsTTY && !io.env.NO_COLOR && io.env.TERM !== 'dumb');
  return { color, verbose: options.verbose ?? false };
}

async function collectOrExplain(
  paths: readonly string[],
  io: CliIo,
  quiet: boolean,
): Promise<CollectedFiles | undefined> {
  const collected = await collectSourceFiles(paths, io.cwd);
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
async function discoverTargets(files: readonly string[]): Promise<Map<string, DiscoveredModule>> {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- targets ----------------------------------------------------------------

async function runTargets(command: TargetsCommand, io: CliIo): Promise<number> {
  const collected = await collectOrExplain(command.paths, io, command.quiet);
  if (!collected) return EXIT_USAGE;
  const modules = await discoverTargets(collected.files);
  const rows: Array<{
    path: string;
    line: number;
    column: number;
    id: string;
    label: string;
    kind: string;
    symbols: string[];
  }> = [];
  for (const [path, discovered] of modules) {
    for (const target of discovered.targets) {
      const symbol = discovered.symbols.find((candidate) => candidate.targetIds.includes(target.id));
      rows.push({
        path: displayPath(path, io.cwd),
        line: (symbol?.range.start.line ?? 0) + 1,
        column: (symbol?.range.start.character ?? 0) + 1,
        id: target.id,
        label: target.label,
        kind: target.selector.kind,
        symbols: target.symbolNames,
      });
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  if (command.json) {
    io.stdout(`${JSON.stringify({ files: modules.size, targets: rows }, null, 2)}\n`);
    return EXIT_OK;
  }
  const c = colors(textStyle(command, io).color);
  const labelWidth = Math.max(0, ...rows.map((row) => row.label.length));
  const lines = rows.map((row) => {
    const symbols = row.symbols.filter((name) => name !== row.label);
    const via = symbols.length > 0 ? c.dim(`  (${symbols.join(', ')})`) : '';
    return `${c.bold(`${row.path}:${row.line}`)}: ${row.label.padEnd(labelWidth)}  ${row.kind}${via}`;
  });
  if (lines.length > 0) lines.push('');
  const rest = collected.files.length - modules.size;
  lines.push(
    `${plural(rows.length, 'target')} in ${plural(modules.size, 'module')}` +
      (rest > 0 ? `; ${plural(rest, 'other source file')} without any` : ''),
  );
  io.stdout(`${lines.join('\n')}\n`);
  return EXIT_OK;
}

// --- check ------------------------------------------------------------------

async function runCheck(command: CheckCommand, io: CliIo): Promise<number> {
  const collected = await collectOrExplain(command.paths, io, command.quiet);
  if (!collected) return EXIT_USAGE;
  const session = createSession(command, io);
  try {
    const modules = await discoverTargets(collected.files);
    if (modules.size === 0) {
      session.note(
        `No TypeGPU targets in ${plural(collected.files.length, 'source file')} under ${command.paths.join(', ')}.`,
      );
    }
    const result = await checkModules(session, command, [...modules.entries()]);
    if (session.interrupted) return EXIT_INTERRUPTED;
    emitCheck(session, result, command);
    if (!command.watch) return result.ok ? EXIT_OK : EXIT_FINDINGS;
    if (!io.watch) {
      io.stderr('Watching is not available here.\n');
      return EXIT_USAGE;
    }
    await watchLoop(session, command, collected, modules);
    return EXIT_INTERRUPTED;
  } catch (error) {
    if (session.interrupted) return EXIT_INTERRUPTED;
    session.settle();
    io.stderr(`${errorMessage(error)}\n`);
    return EXIT_USAGE;
  } finally {
    await session.close();
  }
}

async function checkModules(
  session: Session,
  command: CheckCommand,
  modules: ReadonlyArray<readonly [string, DiscoveredModule]>,
): Promise<CheckResult> {
  const startedAt = Date.now();
  const files: CliFileResult[] = [];
  for (const [path, discovered] of modules) {
    if (session.interrupted) break;
    const module = await inspectModule(session, path, discovered);
    files.push(fileResult(session, module, command));
  }
  return summarizeCheck(files, Date.now() - startedAt, command.warningsAsErrors);
}

function emitCheck(session: Session, result: CheckResult, command: CheckCommand): void {
  session.settle();
  const io = session.io;
  const style = textStyle(command, io);
  switch (command.format) {
    case 'json':
      io.stdout(formatCheckJson(result));
      return;
    case 'github':
      io.stdout(formatCheckGithub(result, style));
      return;
    default:
      io.stdout(formatCheckText(result, style));
  }
}

// --- watch ------------------------------------------------------------------

const WATCH_DEBOUNCE_MS = 250;
const DEPENDENCY_DEPTH = 4;

/**
 * Re-checks a module when it or a file it imports changes. A file that only
 * exports helpers is never inspected on its own; editing it re-checks the
 * modules that inline those helpers.
 */
async function watchLoop(
  session: Session,
  command: CheckCommand,
  collected: CollectedFiles,
  modules: Map<string, DiscoveredModule>,
): Promise<void> {
  const io = session.io;
  const c = colors(textStyle(command, io).color);
  let dependents = await dependentsOf(modules);
  let known = new Set(collected.files);
  let running = Promise.resolve();
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  session.note(`Watching ${describeWatchScope(command.paths)}. Press Ctrl-C to stop.`);

  const handleChanges = async (changed: string[]): Promise<void> => {
    if (session.interrupted) return;
    const fresh = await collectSourceFiles(command.paths, io.cwd);
    const added = fresh.files.filter((file) => !known.has(file));
    known = new Set(fresh.files);
    const candidates = new Set<string>();
    for (const path of [...changed, ...added]) {
      if (known.has(path)) candidates.add(path);
      for (const dependent of dependents.get(path) ?? []) candidates.add(dependent);
    }
    const affected: Array<readonly [string, DiscoveredModule]> = [];
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
    if (affected.length === 0) return;
    const names = changed.map((path) => basename(path));
    const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ', …' : '');
    session.settle();
    io.stdout(`\n${c.dim(`— ${new Date().toLocaleTimeString()} ${shown}`)}\n`);
    const result = await checkModules(session, command, affected);
    if (session.interrupted) return;
    emitCheck(session, result, command);
  };

  const flush = () => {
    const changed = [...pending];
    pending = new Set();
    running = running
      .then(() => handleChanges(changed))
      .catch((error: unknown) => {
        if (!session.interrupted) session.note(errorMessage(error));
      });
  };

  const unsubscribe = io.watch!(collected.files, collected.directories, (paths) => {
    for (const path of paths) {
      if (isSourceFile(path)) pending.add(path);
    }
    if (pending.size === 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  });

  await new Promise<void>((done) => {
    if (session.abort.signal.aborted) {
      done();
      return;
    }
    session.abort.signal.addEventListener('abort', () => done(), { once: true });
  });
  if (timer) clearTimeout(timer);
  unsubscribe();
  await running.catch(() => undefined);
}

function describeWatchScope(paths: readonly string[]): string {
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

function watchWithChokidar(
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

// --- wgsl and report --------------------------------------------------------

type SelectedTarget = { module: InspectedModule; target: InspectionTarget };

async function inspectSelected(
  session: Session,
  paths: readonly string[],
  requested: readonly string[],
): Promise<{ selected: SelectedTarget[]; unmatched: string[] } | undefined> {
  const collected = await collectOrExplain(paths, session.io, false);
  if (!collected) return undefined;
  const selected: SelectedTarget[] = [];
  const matched = new Set<string>();
  for (const path of collected.files) {
    const discovered = await discoverModule(path);
    const targets = discovered.targets.filter((target) => {
      if (requested.length === 0) return true;
      const hit = requested.find((name) => name === target.label || target.symbolNames.includes(name));
      if (hit !== undefined) matched.add(hit);
      return hit !== undefined;
    });
    if (targets.length === 0) continue;
    const module = await inspectModule(session, path, discovered, targets);
    for (const target of targets) selected.push({ module, target });
  }
  return { selected, unmatched: requested.filter((name) => !matched.has(name)) };
}

type WgslEntry = {
  path: string;
  label: string;
  kind?: string;
} & (
  | {
    ok: true;
    wgsl: string;
    messages: Array<{ type: string; message: string; line?: number; column?: number }>;
  }
  | { ok: false; reason: string }
);

async function runWgsl(command: WgslCommand, io: CliIo): Promise<number> {
  const session = createSession(command, io);
  try {
    const picked = await inspectSelected(session, command.paths, command.targets);
    if (!picked) return EXIT_USAGE;
    session.settle();
    for (const name of picked.unmatched) io.stderr(`No target named ${JSON.stringify(name)}.\n`);
    if (picked.selected.length === 0) {
      session.note('No targets to show.');
      return EXIT_USAGE;
    }
    let failures = picked.unmatched.length;
    const entries = picked.selected.map(({ module, target }): WgslEntry => {
      const response = generatedWgsl(1, module.discovered, module.inspection, target.id, new Set());
      const kind = module.inspection.targets.get(target.id)?.report.kind;
      const head = { path: displayPath(module.path, io.cwd), label: target.label, ...(kind ? { kind } : {}) };
      if (!response.ok) {
        failures += 1;
        return { ...head, ok: false, reason: response.reason };
      }
      return {
        ...head,
        ok: true,
        wgsl: response.wgsl,
        messages: response.messages.map((message) => ({
          type: message.type,
          message: message.message,
          ...(message.range
            ? { line: message.range.start.line + 1, column: message.range.start.character + 1 }
            : {}),
        })),
      };
    });
    if (command.json) {
      io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
    } else {
      const chunks = entries.map((entry) => {
        const header = `// ${entry.path}: ${entry.label}${entry.kind ? ` (${entry.kind})` : ''}`;
        if (!entry.ok) return `${header}\n// ${entry.reason}\n`;
        const messages = entry.messages.map((message) =>
          `// ${message.type}${message.line !== undefined ? ` at ${message.line}:${message.column}` : ''}: ${message.message}`
        );
        return `${header}\n${entry.wgsl.trimEnd()}\n${messages.length > 0 ? `${messages.join('\n')}\n` : ''}`;
      });
      io.stdout(chunks.join('\n'));
    }
    return failures > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (error) {
    if (session.interrupted) return EXIT_INTERRUPTED;
    session.settle();
    io.stderr(`${errorMessage(error)}\n`);
    return EXIT_USAGE;
  } finally {
    await session.close();
  }
}

type ReportEntry = {
  path: string;
  label: string;
  status: 'ok' | 'failed';
  markdown?: string;
  reason?: string;
};

async function runReport(command: ReportCommand, io: CliIo): Promise<number> {
  const session = createSession(command, io);
  try {
    const picked = await inspectSelected(session, command.paths, command.targets);
    if (!picked) return EXIT_USAGE;
    session.settle();
    for (const name of picked.unmatched) io.stderr(`No target named ${JSON.stringify(name)}.\n`);
    if (picked.selected.length === 0) {
      session.note('No targets to report.');
      return EXIT_USAGE;
    }
    let failures = picked.unmatched.length;
    const entries = picked.selected.map(({ module, target }): ReportEntry => {
      const response = targetReport(
        1,
        module.discovered,
        module.inspection,
        target.id,
        new Set(),
        session.surface,
      );
      const materialized = module.inspection.targets.get(target.id);
      const status: ReportEntry['status'] = materialized?.report.ok ? 'ok' : 'failed';
      if (!response.ok || status === 'failed') failures += 1;
      return {
        path: displayPath(module.path, io.cwd),
        label: target.label,
        status,
        ...(response.ok ? { markdown: response.markdown } : { reason: response.reason }),
      };
    });
    if (command.json) {
      io.stdout(`${JSON.stringify(entries, null, 2)}\n`);
    } else {
      const chunks = entries.map((entry) =>
        `## ${entry.path}: ${entry.label}\n\n${entry.markdown ?? entry.reason ?? ''}`.trimEnd()
      );
      io.stdout(`${chunks.join('\n\n---\n\n')}\n`);
    }
    return failures > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (error) {
    if (session.interrupted) return EXIT_INTERRUPTED;
    session.settle();
    io.stderr(`${errorMessage(error)}\n`);
    return EXIT_USAGE;
  } finally {
    await session.close();
  }
}
