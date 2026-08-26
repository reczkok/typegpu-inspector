import * as path from 'node:path';
import {
  ConfigurationTarget,
  StatusBarAlignment,
  Uri,
  commands,
  env,
  languages,
  window,
  workspace,
  type ExtensionContext,
  type StatusBarItem,
  type TextDocument,
} from 'vscode';
import {
  DidChangeConfigurationNotification,
  HoverRequest,
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { WgslPreview, isTargetRef } from './wgslPreview.js';

let client: LanguageClient | undefined;
let preview: WgslPreview | undefined;
let clientStarting: Promise<void> | undefined;
let statusItem: StatusBarItem | undefined;

/** "Not now" on the runtime notice: forces `inspectOn: off` for this window without touching settings. */
let runtimeDeclinedForSession = false;

const RUNTIME_CONSENT_KEY = 'typegpuInspector.runtimeConsent';
const RUNTIME_NOTICE_URL =
  'https://github.com/reczkok/typegpu-inspector#what-it-downloads-and-runs';

type InspectionStatus = {
  state: 'inspecting' | 'done' | 'failed' | 'idle';
  uri: string;
  targetCount?: number;
  passedTargetCount?: number;
  failedTargetCount?: number;
  elapsedMs?: number;
  message?: string;
  coldStart?: boolean;
};

function renderStatus(item: StatusBarItem, status: InspectionStatus): void {
  const file = path.basename(status.uri);
  switch (status.state) {
    case 'inspecting':
      if (status.coldStart) {
        item.text = '$(sync~spin) TypeGPU warming up';
        item.tooltip =
          `Inspecting ${file}: the first inspection sets up a headless browser and bundler session, which can take a few minutes. Later inspections reuse it and take seconds.`;
        break;
      }
      item.text = `$(sync~spin) TypeGPU ${status.targetCount ?? ''}`.trimEnd();
      item.tooltip = `Inspecting ${status.targetCount} target(s) in ${file}…`;
      break;
    case 'done': {
      const total = status.targetCount ?? 0;
      const failed = status.failedTargetCount ?? 0;
      const passed = status.passedTargetCount ?? total - failed;
      const seconds = ((status.elapsedMs ?? 0) / 1000).toFixed(1);
      item.text = `${failed > 0 ? '$(warning)' : '$(check)'} TypeGPU ${passed}/${total} · ${seconds}s`;
      item.tooltip = failed > 0
        ? `${file}: ${failed} of ${total} targets failed inspection — hover them for details.`
        : `${file}: all ${total} targets inspected in ${seconds}s.`;
      break;
    }
    case 'failed':
      item.text = '$(error) TypeGPU';
      item.tooltip = `Inspection of ${file} failed: ${status.message ?? 'unknown error'}`;
      break;
    case 'idle':
      item.text = '$(beaker) TypeGPU';
      item.tooltip = 'Save a TypeGPU file to inspect it.';
      break;
  }
}

function renderRestrictedStatus(item: StatusBarItem): void {
  item.text = '$(shield) TypeGPU restricted';
  item.tooltip =
    'Restricted Mode: TypeGPU Inspector is not running. It executes this workspace\'s TypeGPU modules in a headless browser, so it stays off until you trust the folder.';
  item.command = 'workbench.trust.manage';
}

function renderWaitingStatus(item: StatusBarItem): void {
  item.text = '$(beaker) TypeGPU';
  item.tooltip =
    'Waiting for a file that imports typegpu. The language server starts on the first one.';
  item.command = 'typegpuInspector.statusMenu';
}

const SETTING_KEYS = [
  'inspectOn',
  'warmUpOnOpen',
  'detailLevel',
  'hoverDetailLevel',
  'inlayDetailLevel',
  'hoverPresentation',
  'timeoutMs',
  'maxWgslBytes',
  'strictNames',
  'hover',
  'inlayHints',
  'diagnostics',
  'documentLinks',
  'sourceMapping',
  'schemaLayoutHealth',
  'schemaPackingSuggestions',
  'inspectorPackage',
  'projectRoot',
] as const;

function serverModule(context: ExtensionContext): string {
  const configured = workspace
    .getConfiguration('typegpuInspector')
    .get<string>('serverPath');
  if (configured && configured.trim() !== '') {
    return configured;
  }
  return context.asAbsolutePath(path.join('dist', 'server.cjs'));
}

function initializationOptions(): Record<string, unknown> {
  const config = workspace.getConfiguration('typegpuInspector');
  const options: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const value = config.get(key);
    if (value !== undefined && value !== null && value !== '') {
      options[key] = value;
    }
  }
  if (runtimeDeclinedForSession) {
    options.inspectOn = 'off';
  }
  return options;
}

const TYPEGPU_LANGUAGES = new Set([
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
]);

/** Textual probe deciding whether the server is worth spawning; discovery proper happens server-side. */
const TYPEGPU_IMPORT_PATTERN =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](?:typegpu|@typegpu\/[^'"]+)(?:\/[^'"]*)?['"]/;

function importsTypeGpu(document: TextDocument): boolean {
  if (document.uri.scheme !== 'file') return false;
  if (!TYPEGPU_LANGUAGES.has(document.languageId)) return false;
  return TYPEGPU_IMPORT_PATTERN.test(document.getText());
}

/** Shown once per installation, before anything is downloaded or executed. */
async function ensureRuntimeConsent(context: ExtensionContext): Promise<boolean> {
  if (runtimeDeclinedForSession) return false;
  if (context.globalState.get<boolean>(RUNTIME_CONSENT_KEY) === true) return true;

  for (;;) {
    const picked = await window.showInformationMessage(
      'TypeGPU Inspector runs your shaders for real',
      {
        modal: true,
        detail: [
          'To report exact pipelines, layouts, and generated WGSL, this extension:',
          '',
          `• downloads the typegpu-runtime-inspector-mcp package and a Playwright Chromium (about 170 MB to download, 550 MB on disk) into ${context.globalStorageUri.fsPath};`,
          '• executes this project\'s top-level TypeGPU module code inside that headless browser whenever you save or hover.',
          '',
          'Nothing is sent anywhere and no telemetry is collected. You can delete the download at any time.',
        ].join('\n'),
      },
      'Continue',
      'Learn more',
      'Not now',
    );
    if (picked === 'Learn more') {
      await env.openExternal(Uri.parse(RUNTIME_NOTICE_URL));
      continue;
    }
    if (picked === 'Continue') {
      await context.globalState.update(RUNTIME_CONSENT_KEY, true);
      return true;
    }
    runtimeDeclinedForSession = true;
    return false;
  }
}

function createClient(context: ExtensionContext): LanguageClient {
  const module = serverModule(context);
  const serverEnv = {
    ...process.env,
    TYPEGPU_INSPECTOR_RUNTIME_DIR: path.join(
      context.globalStorageUri.fsPath,
      'runtime',
    ),
  };
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.stdio, options: { env: serverEnv } },
    debug: { module, transport: TransportKind.stdio, options: { env: serverEnv } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'typescriptreact' },
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'javascriptreact' },
    ],
    initializationOptions: initializationOptions(),
    // Hovers are served by registerTypeGpuHover instead, so the TypeScript
    // quick info renders above ours in the merged hover.
    middleware: { provideHover: () => null },
    // Hover action links (open/peek WGSL, switch detail) are command URIs.
    markdown: {
      isTrusted: {
        enabledCommands: [
          'typegpuInspector.openWgsl',
          'typegpuInspector.peekWgsl',
        ],
      },
    },
  };
  return new LanguageClient(
    'typegpuInspector',
    'TypeGPU Inspector',
    serverOptions,
    clientOptions,
  );
}

/**
 * VS Code concatenates every hover provider into one widget, ordered by
 * selector score and then with built-in providers last. A language-specific
 * selector would always place us above TypeScript's quick info; the wildcard
 * selector scores lower, so the type shows first and the datasheet follows.
 */
function registerTypeGpuHover(context: ExtensionContext, started: LanguageClient): void {
  context.subscriptions.push(
    languages.registerHoverProvider({ language: '*' }, {
      async provideHover(document, position, token) {
        if (document.uri.scheme !== 'file' || !TYPEGPU_LANGUAGES.has(document.languageId)) {
          return null;
        }
        const result = await started.sendRequest(
          HoverRequest.type,
          started.code2ProtocolConverter.asTextDocumentPositionParams(document, position),
          token,
        );
        return started.protocol2CodeConverter.asHover(result);
      },
    }),
  );
}

async function startClient(context: ExtensionContext): Promise<void> {
  if (client) return;
  if (clientStarting) return clientStarting;
  clientStarting = (async () => {
    const started = createClient(context);
    await started.start();
    client = started;
    registerTypeGpuHover(context, started);
    started.onNotification(
      'typegpu/inspectionStatus',
      (payload: InspectionStatus) => {
        if (statusItem) renderStatus(statusItem, payload);
        if (payload.state === 'done' || payload.state === 'failed') {
          preview?.refresh(payload.uri);
        }
        if (payload.state === 'failed') {
          void notifyInspectionFailure(payload);
        }
      },
    );
    if (statusItem) {
      statusItem.command = 'typegpuInspector.statusMenu';
      renderStatus(statusItem, { state: 'idle', uri: '' });
    }
  })();
  try {
    await clientStarting;
  } finally {
    clientStarting = undefined;
  }
}

async function considerDocument(
  context: ExtensionContext,
  document: TextDocument,
): Promise<void> {
  if (client || clientStarting) return;
  if (!workspace.isTrusted) return;
  if (!importsTypeGpu(document)) return;
  await ensureRuntimeConsent(context);
  await startClient(context);
}

async function considerOpenDocuments(context: ExtensionContext): Promise<void> {
  for (const document of workspace.textDocuments) {
    await considerDocument(context, document);
    if (client || clientStarting) return;
  }
}

let lastNotifiedFailure: string | undefined;

/** One toast per distinct failure, with the fixes a user can actually apply. */
async function notifyInspectionFailure(status: InspectionStatus): Promise<void> {
  const message = status.message ?? 'Inspection failed.';
  if (message === lastNotifiedFailure) return;
  lastNotifiedFailure = message;

  const config = workspace.getConfiguration('typegpuInspector');
  const timeoutMs = config.get<number>('timeoutMs') ?? 45_000;
  const raisedMs = Math.min(timeoutMs * 2, 600_000);
  const raiseAction = `Raise timeout to ${Math.round(raisedMs / 1000)}s`;
  const offerRaise = /time(d)?[ -]?out|timeoutMs/i.test(message) &&
    raisedMs > timeoutMs;

  const actions = [
    ...(offerRaise ? [raiseAction] : []),
    'Run doctor',
    'Show log',
  ];
  const short = message.length > 300 ? `${message.slice(0, 300)}…` : message;
  const picked = await window.showErrorMessage(
    `TypeGPU inspection failed: ${short}`,
    ...actions,
  );
  if (picked === raiseAction) {
    await config.update('timeoutMs', raisedMs, ConfigurationTarget.Global);
    void window.showInformationMessage(
      `typegpuInspector.timeoutMs is now ${raisedMs} ms. Save the file to retry.`,
    );
  } else if (picked === 'Run doctor') {
    await commands.executeCommand('typegpuInspector.doctor');
  } else if (picked === 'Show log') {
    await commands.executeCommand('typegpuInspector.showOutput');
  }
}

/** Drives the editor-title "Open Generated WGSL" button. */
function updateFileContext(document: TextDocument | undefined): void {
  void commands.executeCommand(
    'setContext',
    'typegpuInspector.typegpuFile',
    document !== undefined && importsTypeGpu(document),
  );
}

export async function activate(context: ExtensionContext): Promise<void> {
  preview = new WgslPreview(() => client);
  context.subscriptions.push(preview);
  updateFileContext(window.activeTextEditor?.document);
  const status = window.createStatusBarItem(StatusBarAlignment.Left, 50);
  statusItem = status;
  status.name = 'TypeGPU Inspector';
  status.command = 'typegpuInspector.statusMenu';
  renderWaitingStatus(status);
  status.show();

  context.subscriptions.push(
    status,
    commands.registerCommand('typegpuInspector.showOutput', () => {
      if (!client) {
        void window.showInformationMessage(
          'TypeGPU Inspector has not started yet — open a file that imports typegpu.',
        );
        return;
      }
      client.outputChannel.show(true);
    }),
    commands.registerCommand('typegpuInspector.doctor', () => {
      const terminal = window.createTerminal('TypeGPU Inspector doctor');
      terminal.show();
      // Same spec as the server's FALLBACK_INSPECTOR_SPEC; npx caches per spec string.
      terminal.sendText(
        `npx -y typegpu-runtime-inspector-mcp@${__TYPEGPU_INSPECTOR_VERSION__} doctor`,
      );
    }),
    commands.registerCommand('typegpuInspector.selectVerbosity', async () => {
      const config = workspace.getConfiguration('typegpuInspector');
      const current = config.get<string>('hoverDetailLevel') ?? 'standard';
      const levels = [
        { label: 'wgsl', description: 'Generated WGSL only for shaders and pipelines' },
        { label: 'compact', description: 'Complete core resource shape without secondary evidence' },
        { label: 'standard', description: 'Role-focused facts and a bounded generated WGSL excerpt' },
        { label: 'deep', description: 'Diagnostics, provenance, runtime metadata, and raw evidence' },
      ];
      const picked = await window.showQuickPick(
        levels.map((level) => ({
          ...level,
          description: level.label === current
            ? `${level.description} · current`
            : level.description,
        })),
        { placeHolder: 'How much detail should hovers show?' },
      );
      if (picked && picked.label !== current) {
        await config.update('hoverDetailLevel', picked.label, ConfigurationTarget.Global);
      }
    }),
    commands.registerCommand('typegpuInspector.openWgslPreview', async () => {
      if (!client) {
        const active = window.activeTextEditor?.document;
        if (active) await considerDocument(context, active);
      }
      if (!client) {
        void window.showInformationMessage(
          'TypeGPU Inspector has not started yet — open a file that imports typegpu.',
        );
        return;
      }
      await preview?.openLive();
    }),
    commands.registerCommand('typegpuInspector.openReportPreview', async () => {
      if (!client) {
        const active = window.activeTextEditor?.document;
        if (active) await considerDocument(context, active);
      }
      if (!client) {
        void window.showInformationMessage(
          'TypeGPU Inspector has not started yet — open a file that imports typegpu.',
        );
        return;
      }
      await preview?.openReport();
    }),
    commands.registerCommand('typegpuInspector.openWgsl', async (ref: unknown) => {
      if (isTargetRef(ref)) await preview?.openPinned(ref);
    }),
    commands.registerCommand('typegpuInspector.peekWgsl', async (ref: unknown) => {
      if (isTargetRef(ref)) await preview?.peek(ref);
    }),
    commands.registerCommand('typegpuInspector.revealSource', async (ref: unknown) => {
      if (isTargetRef(ref)) await preview?.revealSource(ref);
    }),
    commands.registerCommand('typegpuInspector.selectInlayDetail', async () => {
      const config = workspace.getConfiguration('typegpuInspector');
      const current = config.get<string>('inlayDetailLevel') ?? 'compact';
      const picked = await window.showQuickPick(
        [
          { label: 'compact', description: 'Status only' },
          { label: 'summary', description: 'Status plus one role-specific fact' },
          { label: 'detailed', description: 'Status plus up to two role-specific facts' },
        ].map((level) => ({
          ...level,
          description: level.label === current
            ? `${level.description} · current`
            : level.description,
        })),
        { placeHolder: 'How much detail should inlay hints show?' },
      );
      if (picked && picked.label !== current) {
        await config.update('inlayDetailLevel', picked.label, ConfigurationTarget.Global);
      }
    }),
    commands.registerCommand('typegpuInspector.statusMenu', async () => {
      const picked = await window.showQuickPick(
        [
          { label: '$(open-preview) Open generated WGSL to the side', action: 'typegpuInspector.openWgslPreview' },
          { label: '$(book) Open inspection report to the side', action: 'typegpuInspector.openReportPreview' },
          { label: '$(output) Show output log', action: 'typegpuInspector.showOutput' },
          { label: '$(list-selection) Select hover detail', action: 'typegpuInspector.selectVerbosity' },
          { label: '$(symbol-key) Select inlay detail', action: 'typegpuInspector.selectInlayDetail' },
          { label: '$(debug-restart) Restart server', action: 'typegpuInspector.restart' },
          { label: '$(pulse) Run environment doctor', action: 'typegpuInspector.doctor' },
        ],
        { placeHolder: 'TypeGPU Inspector' },
      );
      if (picked) await commands.executeCommand(picked.action);
    }),
    commands.registerCommand('typegpuInspector.restart', async () => {
      if (client) {
        await client.restart();
        return;
      }
      if (!workspace.isTrusted) {
        void window.showWarningMessage(
          'TypeGPU Inspector stays off in Restricted Mode because it executes workspace code. Trust this folder to enable it.',
        );
        return;
      }
      await ensureRuntimeConsent(context);
      await startClient(context);
    }),
    workspace.onDidOpenTextDocument((document) => {
      void considerDocument(context, document);
    }),
    window.onDidChangeActiveTextEditor((editor) => {
      updateFileContext(editor?.document);
    }),
    workspace.onDidSaveTextDocument((document) => {
      void considerDocument(context, document);
    }),
    workspace.onDidGrantWorkspaceTrust(() => {
      renderWaitingStatus(status);
      void considerOpenDocuments(context);
    }),
    workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('typegpuInspector')) return;
      // serverPath changes the spawned process itself, which only a full
      // restart can apply; everything else flows through didChangeConfiguration.
      if (event.affectsConfiguration('typegpuInspector.serverPath')) {
        await client?.restart();
        return;
      }
      // Manual sync keeps the session-level `inspectOn` override intact.
      await client?.sendNotification(DidChangeConfigurationNotification.type, {
        settings: initializationOptions(),
      });
    }),
  );

  if (!workspace.isTrusted) {
    // Restricted Mode: the server would execute workspace code.
    renderRestrictedStatus(status);
    return;
  }

  await considerOpenDocuments(context);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
  preview = undefined;
  statusItem = undefined;
}
