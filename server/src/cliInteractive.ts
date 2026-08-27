import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { styleText } from 'node:util';
import { fileURLToPath } from 'node:url';
import { wrapAnsi } from 'fast-wrap-ansi';
import yoctoSpinner from 'yocto-spinner';
import type { InteractiveCommand } from './cliArgs.js';
import type { CollectedFiles } from './cliFiles.js';
import { renderMarkdown } from './cliMarkdown.js';
import {
  colors,
  displayPath,
  formatDiagnosticLines,
  formatSummaryLine,
  plural,
  summarizeCheck,
  type CheckResult,
  type CliFileResult,
  type TextStyle,
} from './cliOutput.js';
import {
  collectOrExplain,
  createSession,
  describeWatchScope,
  discoverTargets,
  errorMessage,
  fileResult,
  inspectModule,
  textStyle,
  watchModules,
  type CliIo,
  type InspectedModule,
  type ModuleEntry,
  type ProgressReporter,
  type Session,
} from './cliSession.js';
import { discoverTypeGpuModule, type DiscoveredModule, type InspectionTarget } from './discovery.js';
import { generatedWgsl, targetReport } from './editorRequests.js';

// --- the prompts an interactive session talks through -----------------------

export const CANCELLED: unique symbol = Symbol('cancelled');
export type Cancelled = typeof CANCELLED;

export type UiOption = {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
};

export type UiSpinner = {
  start(text: string): void;
  message(text: string): void;
  /** Ends the spinner with a final line, styled as a success or a failure. */
  stop(text: string, ok?: boolean): void;
  /** Ends the spinner leaving nothing behind. */
  clear(): void;
};

export type UiMessageKind = 'plain' | 'info' | 'success' | 'warn' | 'error';

/** Terminal prompts, so the flow can run against a scripted fake in tests. */
export type InteractiveUi = {
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  select(message: string, options: readonly UiOption[]): Promise<string | Cancelled>;
  /** A searchable list; typing filters by label and hint. */
  autocomplete(
    message: string,
    options: readonly UiOption[],
    placeholder: string,
    initialInput?: string,
  ): Promise<string | Cancelled>;
  spinner(): UiSpinner;
  message(text: string | readonly string[], kind?: UiMessageKind): void;
  /** Resolves on the next key press; `interrupt` for Ctrl-C. */
  waitForKey(): Promise<'key' | 'interrupt'>;
  /** The editor command from `$VISUAL` or `$EDITOR`, when one is set. */
  editor?: string;
  openInEditor(path: string): Promise<void>;
};

const CLACK_GUIDE_COLUMNS = 3;

/**
 * Wraps at spaces before Clack adds its guide so continuations keep the `│`;
 * a path or a long token never breaks in the middle.
 */
export function wrapInteractiveMessage(text: string, terminalColumns: number): string {
  const columns = Math.max(1, Math.floor(terminalColumns) - CLACK_GUIDE_COLUMNS);
  return wrapAnsi(text, columns, { hard: false, trim: false });
}

// --- the session ------------------------------------------------------------

type Workspace = {
  collected: CollectedFiles;
  modules: Map<string, DiscoveredModule>;
};

/** The last inspection of a module, valid while its source is unchanged. */
type CachedModule = {
  source: string;
  module: InspectedModule;
};

type PickedTarget = {
  path: string;
  discovered: DiscoveredModule;
  target: InspectionTarget;
};

type Flow = {
  command: InteractiveCommand;
  io: CliIo;
  ui: InteractiveUi;
  session: Session;
  style: TextStyle;
  progress: SpinnerProgress;
  workspace: Workspace;
  cache: Map<string, CachedModule>;
};

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

export async function runInteractive(
  command: InteractiveCommand,
  io: CliIo,
  ui: InteractiveUi,
): Promise<number> {
  // Prompt colors come from the terminal; the flags decide for both.
  if (command.color === false) io.env.NO_COLOR = '1';
  else if (command.color === true) io.env.FORCE_COLOR = '1';

  ui.intro(`TypeGPU Inspector ${__TYPEGPU_SERVER_VERSION__}`);
  const progress = new SpinnerProgress(ui);
  const sessionIo: CliIo = {
    ...io,
    stderr: (text) => ui.message(text.trimEnd(), 'warn'),
    createProgress: () => progress,
  };
  const session = createSession({ ...command, quiet: false }, sessionIo);
  const flow: Flow = {
    command,
    io,
    ui,
    session,
    style: textStyle(command, io),
    progress,
    workspace: { collected: { files: [], missing: [], directories: [] }, modules: new Map() },
    cache: new Map(),
  };
  try {
    await scan(flow);
    const outcome = await mainMenu(flow);
    if (outcome === 'interrupt') {
      ui.cancel('Interrupted.');
      return EXIT_INTERRUPTED;
    }
    ui.outro('Done.');
    return EXIT_OK;
  } catch (error) {
    progress.clear();
    if (session.interrupted) {
      ui.cancel('Interrupted.');
      return EXIT_INTERRUPTED;
    }
    ui.cancel(errorMessage(error));
    return EXIT_USAGE;
  } finally {
    await session.close();
  }
}

async function scan(flow: Flow): Promise<void> {
  const { ui, command } = flow;
  const spinner = ui.spinner();
  spinner.start(`Scanning ${describeWatchScope(command.paths)}`);
  const collected = await collectOrExplain(command.paths, flow.session.io, true, command.files);
  const modules = collected ? await discoverTargets(collected.files) : new Map<string, DiscoveredModule>();
  flow.workspace = {
    collected: collected ?? { files: [], missing: [], directories: [] },
    modules,
  };
  const targets = countTargets(modules);
  const rest = (collected?.files.length ?? 0) - modules.size;
  if (targets === 0) {
    spinner.stop(
      collected
        ? `No TypeGPU targets in ${plural(collected.files.length, 'source file')}`
        : `No source files under ${describeWatchScope(command.paths)}`,
      false,
    );
    return;
  }
  spinner.stop(
    `${plural(targets, 'target')} in ${plural(modules.size, 'module')}` +
      (rest > 0 ? ` · ${plural(rest, 'other source file')} without any` : ''),
  );
}

async function mainMenu(flow: Flow): Promise<'quit' | 'interrupt'> {
  const { ui } = flow;
  for (;;) {
    const targets = countTargets(flow.workspace.modules);
    const none = targets === 0;
    const failed = countFailed(flow);
    const action = await ui.select('What next?', [
      {
        value: 'check',
        label: 'Check everything',
        hint: none ? 'nothing to check' : `${plural(targets, 'target')} in ${plural(flow.workspace.modules.size, 'module')}`,
        disabled: none,
      },
      ...(failed > 0
        ? [{ value: 'failed', label: `Review ${plural(failed, 'failed target')}`, hint: 'from the last run' }]
        : []),
      {
        value: 'target',
        label: 'Pick a target',
        hint: none ? 'nothing to pick' : 'check it, read its WGSL or report',
        disabled: none,
      },
      {
        value: 'watch',
        label: 'Watch for changes',
        hint: flow.io.watch ? 're-check a module and its importers on save' : 'not available here',
        disabled: !flow.io.watch,
      },
      { value: 'rescan', label: 'Rescan', hint: describeWatchScope(flow.command.paths) },
      { value: 'quit', label: 'Quit' },
    ]);
    if (action === CANCELLED) return 'interrupt';
    if (action === 'quit') return 'quit';
    switch (action) {
      case 'check':
        await checkEverything(flow);
        break;
      case 'target':
      case 'failed': {
        const picked = await pickTarget(flow, action === 'failed' ? 'failed' : undefined);
        if (picked === CANCELLED) return 'interrupt';
        const outcome = await targetMenu(flow, picked);
        if (outcome === 'interrupt') return 'interrupt';
        break;
      }
      case 'watch': {
        const outcome = await watch(flow);
        if (outcome === 'interrupt') return 'interrupt';
        break;
      }
      case 'rescan':
        await scan(flow);
        break;
    }
  }
}

// --- check ------------------------------------------------------------------

async function checkEverything(flow: Flow): Promise<void> {
  const startedAt = Date.now();
  const files: CliFileResult[] = [];
  for (const [path, discovered] of flow.workspace.modules) {
    const module = await inspectFresh(flow, path, discovered);
    files.push(fileResult(flow.session, module, 'hint'));
  }
  showCheck(flow, summarizeCheck(files, Date.now() - startedAt, false));
}

/** Inspects the module now and remembers the result for its current source. */
async function inspectFresh(flow: Flow, path: string, discovered: DiscoveredModule): Promise<InspectedModule> {
  const source = await readFile(path, 'utf8');
  const module = await inspectModule(flow.session, path, discovered);
  flow.cache.set(path, { source, module });
  return module;
}

/** The last inspection while the source is unchanged, otherwise a fresh one. */
async function inspectCached(
  flow: Flow,
  path: string,
  discovered: DiscoveredModule,
): Promise<{ module: InspectedModule; fromCache: boolean }> {
  const source = await readFile(path, 'utf8');
  const hit = flow.cache.get(path);
  if (hit && hit.source === source) return { module: hit.module, fromCache: true };
  const current = hit ? discoverTypeGpuModule(path, source) : discovered;
  if (current !== discovered) flow.workspace.modules.set(path, current);
  const module = await inspectModule(flow.session, path, current);
  flow.cache.set(path, { source, module });
  return { module, fromCache: false };
}

function showCheck(flow: Flow, result: CheckResult): void {
  const summary = formatSummaryLine(result, flow.style, { mark: false });
  if (flow.progress.active) flow.progress.stop(summary, result.ok);
  else flow.ui.message(summary, result.ok ? 'success' : 'error');
  const lines = result.files.flatMap((file) =>
    file.diagnostics.flatMap((diagnostic) => formatDiagnosticLines(diagnostic, flow.style))
  );
  if (lines.length > 0) flow.ui.message(lines);
}

// --- one target -------------------------------------------------------------

async function pickTarget(flow: Flow, initialInput?: string): Promise<PickedTarget | Cancelled> {
  const { ui, io } = flow;
  const c = colors(flow.style.color);
  const choices = new Map<string, PickedTarget>();
  const options: UiOption[] = [];
  const entries = [...flow.workspace.modules.entries()]
    .sort(([a], [b]) => displayPath(a, io.cwd).localeCompare(displayPath(b, io.cwd)));
  for (const [path, discovered] of entries) {
    const cached = flow.cache.get(path);
    for (const target of discovered.targets) {
      const key = `${path} ${target.id}`;
      choices.set(key, { path, discovered, target });
      const status = cached?.module.inspection.targets.get(target.id)?.report.ok;
      const mark = status === undefined ? '' : status ? ` · ${c.green('ok')}` : ` · ${c.red('failed')}`;
      options.push({
        value: key,
        label: `${target.label}  ${c.dim(`${displayPath(path, io.cwd)}:${targetLine(discovered, target)}`)}`,
        hint: `${target.selector.kind}${mark}`,
      });
    }
  }
  const key = await ui.autocomplete('Which target?', options, 'type to search by name or file', initialInput);
  if (key === CANCELLED) return CANCELLED;
  return choices.get(key) ?? CANCELLED;
}

function targetLine(discovered: DiscoveredModule, target: InspectionTarget): number {
  const symbol = discovered.symbols.find((candidate) => candidate.targetIds.includes(target.id));
  return (symbol?.range.start.line ?? 0) + 1;
}

async function targetMenu(flow: Flow, picked: PickedTarget): Promise<'back' | 'interrupt'> {
  const { ui, io } = flow;
  const shown = displayPath(picked.path, io.cwd);
  const title = `${picked.target.label} · ${shown}:${targetLine(picked.discovered, picked.target)}`;
  for (;;) {
    const cached = await cachedResult(flow, picked.path);
    const generated = cached?.inspection.targets.get(picked.target.id)?.generatedUri;
    const editor = ui.editor;
    const action = await ui.select(title, [
      {
        value: 'check',
        label: 'Check',
        hint: cached ? `diagnostics for ${shown}, from the last run` : `inspect ${shown}`,
      },
      {
        value: 'wgsl',
        label: 'Show generated WGSL',
        ...(!cached ? { hint: 'inspects first' } : {}),
      },
      {
        value: 'open',
        label: `Open generated WGSL in ${editorName(editor)}`,
        ...(!editor
          ? { hint: 'set $VISUAL or $EDITOR' }
          : !generated
          ? { hint: 'inspects first' }
          : {}),
        disabled: !editor,
      },
      { value: 'report', label: 'Show report', hint: 'entry points, bindings, layout, provenance' },
      ...(cached ? [{ value: 'again', label: 'Inspect again', hint: 'drop the remembered result' }] : []),
      { value: 'back', label: 'Back' },
    ]);
    if (action === CANCELLED) return 'interrupt';
    if (action === 'back') return 'back';
    switch (action) {
      case 'check': {
        const startedAt = Date.now();
        const { module, fromCache } = await inspectCached(flow, picked.path, picked.discovered);
        const result = summarizeCheck(
          [fileResult(flow.session, module, 'hint')],
          fromCache ? module.elapsedMs : Date.now() - startedAt,
          false,
        );
        showCheck(flow, result);
        break;
      }
      case 'wgsl':
        await showWgsl(flow, picked);
        break;
      case 'open':
        await openGenerated(flow, picked);
        break;
      case 'report':
        await showReport(flow, picked);
        break;
      case 'again':
        await inspectFresh(flow, picked.path, picked.discovered);
        flow.progress.stop(`Inspected ${shown}`, true);
        break;
    }
    if (flow.session.interrupted) return 'interrupt';
  }
}

async function cachedResult(flow: Flow, path: string): Promise<InspectedModule | undefined> {
  const hit = flow.cache.get(path);
  if (!hit) return undefined;
  try {
    return (await readFile(path, 'utf8')) === hit.source ? hit.module : undefined;
  } catch {
    return undefined;
  }
}

async function showWgsl(flow: Flow, picked: PickedTarget): Promise<void> {
  const { ui, io } = flow;
  const c = colors(flow.style.color);
  const { module } = await inspectCached(flow, picked.path, picked.discovered);
  flow.progress.settle();
  const response = generatedWgsl(1, module.discovered, module.inspection, picked.target.id, new Set());
  if (!response.ok) {
    ui.message(`${picked.target.label}: ${response.reason}`, 'warn');
    return;
  }
  const kind = module.inspection.targets.get(picked.target.id)?.report.kind;
  const lines = [
    c.dim(`// ${displayPath(picked.path, io.cwd)}: ${picked.target.label}${kind ? ` (${kind})` : ''}`),
    ...response.wgsl.trimEnd().split('\n'),
  ];
  for (const message of response.messages) {
    const where = message.range ? ` at ${message.range.start.line + 1}:${message.range.start.character + 1}` : '';
    lines.push(c.red(`// ${message.type}${where}: ${message.message}`));
  }
  const generated = module.inspection.targets.get(picked.target.id)?.generatedUri;
  if (generated) lines.push(c.dim(`// ${displayPath(generated, io.cwd)}`));
  ui.message(lines);
}

async function openGenerated(flow: Flow, picked: PickedTarget): Promise<void> {
  const { ui, io } = flow;
  const { module } = await inspectCached(flow, picked.path, picked.discovered);
  flow.progress.settle();
  const generated = module.inspection.targets.get(picked.target.id)?.generatedUri;
  if (!generated) {
    const response = generatedWgsl(1, module.discovered, module.inspection, picked.target.id, new Set());
    ui.message(
      `${picked.target.label}: ${response.ok ? 'no generated file' : response.reason}`,
      'warn',
    );
    return;
  }
  const path = fileURLToPath(generated);
  ui.message(`Opening ${displayPath(path, io.cwd)} in ${editorName(ui.editor)}`, 'info');
  await ui.openInEditor(path);
}

async function showReport(flow: Flow, picked: PickedTarget): Promise<void> {
  const { ui, io } = flow;
  const { module } = await inspectCached(flow, picked.path, picked.discovered);
  flow.progress.settle();
  const response = targetReport(
    1,
    module.discovered,
    module.inspection,
    picked.target.id,
    new Set(),
    flow.session.surface,
  );
  if (!response.ok) {
    ui.message(`${picked.target.label}: ${response.reason}`, 'warn');
    return;
  }
  ui.message(renderMarkdown(response.markdown, colors(flow.style.color), io.cwd));
}

// --- watch ------------------------------------------------------------------

async function watch(flow: Flow): Promise<'stopped' | 'interrupt'> {
  const { ui, session, command } = flow;
  const c = colors(flow.style.color);
  ui.message(`Watching ${describeWatchScope(command.paths)}. Press any key to stop.`, 'info');
  const stop = new AbortController();
  const pressed = ui.waitForKey().then((key) => {
    stop.abort();
    return key;
  });
  await watchModules(session, {
    paths: command.paths,
    files: command.files,
    collected: flow.workspace.collected,
    modules: flow.workspace.modules,
    signal: stop.signal,
    onAffected: async (affected: ReadonlyArray<ModuleEntry>, changedNames) => {
      const shown = changedNames.slice(0, 4).join(', ') + (changedNames.length > 4 ? ', …' : '');
      ui.message(c.dim(`— ${new Date().toLocaleTimeString()} ${shown}`));
      const startedAt = Date.now();
      const files: CliFileResult[] = [];
      for (const [path, discovered] of affected) {
        if (stop.signal.aborted || session.interrupted) return;
        const module = await inspectFresh(flow, path, discovered);
        files.push(fileResult(session, module, 'hint'));
      }
      showCheck(flow, summarizeCheck(files, Date.now() - startedAt, false));
    },
    onError: (message) => ui.message(message, 'error'),
  });
  const key = await pressed;
  flow.progress.settle();
  if (key === 'interrupt' || session.interrupted) return 'interrupt';
  ui.message('Stopped watching.', 'info');
  return 'stopped';
}

// --- helpers ----------------------------------------------------------------

/** The editor command's own name: `code` for `code -w`. */
function editorName(editor: string | undefined): string {
  if (!editor) return '$EDITOR';
  return basename(editor.split(/\s+/)[0] ?? editor);
}

/** Targets the remembered inspections report as failed. */
function countFailed(flow: Flow): number {
  let count = 0;
  for (const [path, cached] of flow.cache) {
    if (!flow.workspace.modules.has(path)) continue;
    for (const target of cached.module.inspection.targets.values()) {
      if (!target.report.ok) count += 1;
    }
  }
  return count;
}

function countTargets(modules: ReadonlyMap<string, DiscoveredModule>): number {
  let count = 0;
  for (const discovered of modules.values()) count += discovered.targets.length;
  return count;
}

/** The session's progress reporter, drawn as the prompt spinner. */
class SpinnerProgress implements ProgressReporter {
  private spinner: UiSpinner | undefined;

  constructor(private readonly ui: InteractiveUi) {}

  get active(): boolean {
    return this.spinner !== undefined;
  }

  update(text: string): void {
    if (this.spinner) {
      this.spinner.message(text);
      return;
    }
    this.spinner = this.ui.spinner();
    this.spinner.start(text);
  }

  stop(text = 'Inspected', ok = true): void {
    if (!this.spinner) return;
    this.spinner.stop(text, ok);
    this.spinner = undefined;
  }

  /** Clears a spinner nobody summarized; ProgressReporter's stop. */
  settle(): void {
    this.stop('Inspected', true);
  }

  clear(): void {
    this.spinner?.clear();
    this.spinner = undefined;
  }
}

// --- the terminal implementation ---------------------------------------------

export async function clackUi(): Promise<InteractiveUi> {
  const p = await import('@clack/prompts');
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || undefined;
  const unwrap = (value: unknown): string | Cancelled =>
    p.isCancel(value) ? CANCELLED : String(value);
  return {
    intro: (title) => p.intro(title),
    outro: (message) => p.outro(message),
    cancel: (message) => p.cancel(message),
    select: async (message, options) => unwrap(await p.select({ message, options: [...options], maxItems: 12 })),
    autocomplete: async (message, options, placeholder, initialInput) =>
      unwrap(
        await p.autocomplete({
          message,
          options: [...options],
          placeholder,
          maxItems: 10,
          filter: matchesEveryWord,
          ...(initialInput !== undefined ? { initialUserInput: initialInput } : {}),
        }),
      ),
    // Clack's own spinner takes stdin raw and exits the process on Ctrl-C;
    // this one only draws, so Ctrl-C reaches the session as SIGINT.
    spinner: () => {
      const gray = (text: string) => styleText('gray', text);
      const spinner = yoctoSpinner({
        stream: process.stdout,
        handleSignals: false,
        color: 'magenta',
        spinner: { frames: p.unicode ? ['◒', '◐', '◓', '◑'] : ['•', 'o', 'O', '0'], interval: 80 },
      });
      return {
        start: (text) => {
          process.stdout.write(`${gray(p.S_BAR)}\n`);
          spinner.start(` ${text}`);
        },
        message: (text) => {
          spinner.text = ` ${text}`;
        },
        stop: (text, ok = true) => {
          spinner.stop();
          const symbol = ok ? styleText('green', p.S_STEP_SUBMIT) : styleText('red', p.S_STEP_ERROR);
          process.stdout.write(`${symbol}  ${text}\n`);
        },
        clear: () => {
          spinner.clear();
          spinner.stop();
        },
      };
    },
    message: (text, kind = 'plain') => {
      const joined = Array.isArray(text) ? text.join('\n') : String(text);
      const wrapped = wrapInteractiveMessage(joined, process.stdout.columns ?? 80);
      switch (kind) {
        case 'info':
          p.log.info(wrapped);
          return;
        case 'success':
          p.log.success(wrapped);
          return;
        case 'warn':
          p.log.warn(wrapped);
          return;
        case 'error':
          p.log.error(wrapped);
          return;
        default:
          p.log.message(wrapped);
      }
    },
    waitForKey: () =>
      new Promise((resolve) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        const onData = (data: Buffer) => {
          stdin.off('data', onData);
          stdin.setRawMode(wasRaw);
          stdin.pause();
          resolve(data.includes(0x03) ? 'interrupt' : 'key');
        };
        stdin.on('data', onData);
      }),
    ...(editor ? { editor } : {}),
    openInEditor: (path) =>
      new Promise((resolve) => {
        if (!editor) {
          resolve();
          return;
        }
        const child = spawn(`${editor} ${shellQuote(path)}`, { shell: true, stdio: 'inherit' });
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      }),
  };
}

/** Every whitespace-separated word of the search appears in the label or hint. */
function matchesEveryWord(search: string, option: { label?: string; hint?: string }): boolean {
  const haystack = `${option.label ?? ''} ${option.hint ?? ''}`.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
