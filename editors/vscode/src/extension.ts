import * as path from 'node:path';
import {
  ConfigurationTarget,
  StatusBarAlignment,
  commands,
  window,
  workspace,
  type ExtensionContext,
  type StatusBarItem,
} from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

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
  return options;
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

export async function activate(context: ExtensionContext): Promise<void> {
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
    synchronize: { configurationSection: 'typegpuInspector' },
  };

  client = new LanguageClient(
    'typegpuInspector',
    'TypeGPU Inspector',
    serverOptions,
    clientOptions,
  );
  await client.start();

  const status = window.createStatusBarItem(StatusBarAlignment.Left, 50);
  status.name = 'TypeGPU Inspector';
  status.command = 'typegpuInspector.statusMenu';
  renderStatus(status, { state: 'idle', uri: '' });
  status.show();
  client.onNotification(
    'typegpu/inspectionStatus',
    (payload: InspectionStatus) => {
      renderStatus(status, payload);
      if (payload.state === 'failed') {
        void notifyInspectionFailure(payload);
      }
    },
  );

  context.subscriptions.push(
    status,
    commands.registerCommand('typegpuInspector.showOutput', () => {
      client?.outputChannel.show(true);
    }),
    commands.registerCommand('typegpuInspector.doctor', () => {
      const terminal = window.createTerminal('TypeGPU Inspector doctor');
      terminal.show();
      // Keep this spec identical to the server's FALLBACK_INSPECTOR_SPEC:
      // npx caches per spec string, so probing @latest would exercise a
      // different install than the one inspections actually run.
      terminal.sendText('npx -y typegpu-runtime-inspector-mcp@0.4.7 doctor');
    }),
    commands.registerCommand('typegpuInspector.selectVerbosity', async () => {
      const config = workspace.getConfiguration('typegpuInspector');
      const current = config.get<string>('hoverDetailLevel') ?? 'standard';
      const levels = [
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
      await client?.restart();
    }),
    workspace.onDidChangeConfiguration(async (event) => {
      // serverPath changes the spawned process itself, which only a full
      // restart can apply; everything else flows through didChangeConfiguration.
      if (event.affectsConfiguration('typegpuInspector.serverPath')) {
        await client?.restart();
      }
    }),
  );
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
