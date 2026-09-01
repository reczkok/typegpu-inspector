import yoctoSpinner from 'yocto-spinner';
import {
  parseCliArgs,
  type CheckCommand,
  type InteractiveCommand,
  type ReportCommand,
  type TargetsCommand,
  type WgslCommand,
} from './cliArgs.js';
import type { CollectedFiles } from './cliFiles.js';
import { clackUi, runInteractive } from './cliInteractive.js';
import {
  colors,
  displayPath,
  formatCheckGithub,
  formatCheckJson,
  formatCheckText,
  plural,
  type CheckResult,
} from './cliOutput.js';
import {
  checkModules,
  collectOrExplain,
  createSession,
  describeWatchScope,
  discoverModule,
  discoverTargets,
  errorMessage,
  inspectModule,
  modulesToEvaluate,
  selectTargets,
  textStyle,
  watchModules,
  watchWithChokidar,
  type CliIo,
  type InspectedModule,
  type Session,
} from './cliSession.js';
import type { DiscoveredModule, InspectionTarget } from './discovery.js';
import { generatedWgsl, targetReport } from './editorRequests.js';
import { RuntimeInspectorClient } from './mcpInspector.js';

export type { CliIo, FileChangeListener, ProgressReporter, RuntimeLike } from './cliSession.js';

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
    stdinIsTTY: process.stdin.isTTY === true,
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
      // Ctrl-C reaches the session's handler, which closes the runtime before exiting.
      const spinner = yoctoSpinner({ stream: process.stderr, handleSignals: false });
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
    createInteractiveUi: clackUi,
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
  // A person at a terminal gets the session; a script or a pipe gets usage.
  const effective = argv.length === 0 && io.stdinIsTTY && io.stdoutIsTTY ? ['interactive'] : argv;
  const parsed = await parseCliArgs(effective, io, __TYPEGPU_SERVER_VERSION__);
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
    case 'interactive':
      return runInteractiveCommand(command, io);
  }
}

// --- targets ----------------------------------------------------------------

async function runTargets(command: TargetsCommand, io: CliIo): Promise<number> {
  const collected = await collectOrExplain(command.paths, io, command.quiet, command.files);
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
  const collected = await collectOrExplain(command.paths, io, command.quiet, command.files);
  if (!collected) return EXIT_USAGE;
  const session = createSession(command, io);
  try {
    const modules = await discoverTargets(collected.files);
    // Named targets narrow the run; a module without any has none to name.
    const evaluate = command.evaluate && command.targets.length === 0
      ? await modulesToEvaluate(collected.files, modules)
      : [];
    if (modules.size === 0 && evaluate.length === 0) {
      session.note(
        `No TypeGPU targets in ${plural(collected.files.length, 'source file')} under ${command.paths.join(', ')}.` +
          (command.evaluate ? '' : ' A module that only calls TypeGPU runs with --evaluate.'),
      );
    }
    const { selected, unmatched } = selectTargets([...modules.entries()], command.targets);
    session.settle();
    for (const name of unmatched) io.stderr(`No target named ${JSON.stringify(name)}.\n`);
    const result = await checkModules(session, selected, command, evaluate);
    if (session.interrupted) return EXIT_INTERRUPTED;
    emitCheck(session, result, command);
    if (!command.watch) return result.ok && unmatched.length === 0 ? EXIT_OK : EXIT_FINDINGS;
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

async function watchLoop(
  session: Session,
  command: CheckCommand,
  collected: CollectedFiles,
  modules: Map<string, DiscoveredModule>,
): Promise<void> {
  const io = session.io;
  const c = colors(textStyle(command, io).color);
  session.note(`Watching ${describeWatchScope(command.paths)}. Press Ctrl-C to stop.`);
  await watchModules(session, {
    paths: command.paths,
    files: command.files,
    collected,
    modules,
    signal: session.abort.signal,
    onAffected: async (affected, changedNames) => {
      const { selected } = selectTargets(affected, command.targets);
      if (selected.length === 0) return;
      const shown = changedNames.slice(0, 4).join(', ') + (changedNames.length > 4 ? ', …' : '');
      session.settle();
      io.stdout(`\n${c.dim(`— ${new Date().toLocaleTimeString()} ${shown}`)}\n`);
      const result = await checkModules(session, selected, command);
      if (session.interrupted) return;
      emitCheck(session, result, command);
    },
    onError: (message) => session.note(message),
  });
}

// --- interactive ------------------------------------------------------------

async function runInteractiveCommand(command: InteractiveCommand, io: CliIo): Promise<number> {
  if (!io.stdinIsTTY || !io.stdoutIsTTY || !io.createInteractiveUi) {
    io.stderr('The interactive session needs a terminal; run `typegpu-inspector check` instead.\n');
    return EXIT_USAGE;
  }
  return runInteractive(command, io, await io.createInteractiveUi());
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
