#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import {
  createConnection,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocumentSyncKind,
  type Diagnostic,
  type InitializeParams,
  type InitializeResult,
  type Position,
  type Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import {
  discoverTypeGpuModule,
  type DiscoveredModule,
} from './discovery.js';
import {
  describeTargets,
  generatedWgsl,
  targetReport,
  type ReportResponse,
  type WgslResponse,
} from './editorRequests.js';
import { RuntimeInspectorClient } from './mcpInspector.js';
import {
  InspectionScheduler,
  type InspectionPriority,
} from './inspectionScheduler.js';
import {
  InspectionProgress,
  selectInspectionTargets,
} from './inspectionState.js';
import {
  defaultSettings,
  type InspectorOutput,
  type InspectorSettings,
} from './protocol.js';
import {
  mergeSettings,
  unwrapSettings,
  type SettingsWarning,
} from './settings.js';
import {
  createDiagnostics,
  createCodeActions,
  createDetailLevelActions,
  createInlayDetailLevelActions,
  createDocumentLinks,
  createHover,
  createInlayHints,
  DETAIL_LEVELS,
  INLAY_DETAIL_LEVELS,
  failedTargetInspection,
  materializeInspection,
  mergeDocumentInspections,
  type DocumentInspection,
  defaultMaxColumnsForClient,
  WIDE_MAX_COLUMNS,
  type SurfaceOptions,
} from './surface.js';

type DocumentState = {
  /** Document version the current `discovered` snapshot was parsed from. */
  discoveredVersion: number;
  savedVersion: number;
  discovered: DiscoveredModule;
  inspection?: DocumentInspection;
};

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const states = new Map<string, DocumentState>();
const scheduler = new InspectionScheduler<InspectorOutput>();
const progress = new InspectionProgress();
const inspectionRequests = new Map<string, Promise<DocumentInspection | undefined>>();

let workspaceRoot = process.cwd();
let settings: InspectorSettings = { ...defaultSettings };
let presentation: 'zed' | 'vscode' = 'zed';
let defaultHoverColumns = WIDE_MAX_COLUMNS;
let inspector = new RuntimeInspectorClient(workspaceRoot, () => settings);

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoot = rootFromInitialize(params) ?? process.cwd();
  if (/visual studio code|vscode/i.test(params.clientInfo?.name ?? '')) {
    presentation = 'vscode';
  }
  defaultHoverColumns = defaultMaxColumnsForClient(params.clientInfo?.name);
  settings = applySettings(params.initializationOptions);
  inspector = new RuntimeInspectorClient(workspaceRoot, () => settings);
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: false },
      },
      hoverProvider: true,
      inlayHintProvider: true,
      documentLinkProvider: { resolveProvider: false },
      codeActionProvider: true,
      executeCommandProvider: {
        commands: [
          'typegpuInspector.openGeneratedWgsl',
          'typegpuInspector.setHoverDetailLevel',
          'typegpuInspector.setInlayDetailLevel',
        ],
      },
    },
    serverInfo: {
      name: 'TypeGPU Inspector',
      version: __TYPEGPU_SERVER_VERSION__,
    },
  };
});

connection.onInitialized(() => {
  void connection.client.register(
    DidChangeConfigurationNotification.type,
    undefined,
  );
  connection.console.info(
    `TypeGPU Inspector ready (${settings.inspectOn}, runtime ${settings.inspectorPackage})`,
  );
});

connection.onDidChangeConfiguration(async (change) => {
  // Zed may deliver an empty payload (e.g. when the client has nothing
  // configured); that must not reset previously applied settings.
  if (Object.keys(unwrapSettings(change.settings)).length === 0) return;
  const previousPackage = settings.inspectorPackage;
  const previousRoot = settings.projectRoot;
  settings = applySettings(change.settings);
  if (
    previousPackage !== settings.inspectorPackage ||
    previousRoot !== settings.projectRoot
  ) {
    scheduler.cancelAll();
    await inspector.close();
    inspector = new RuntimeInspectorClient(workspaceRoot, () => settings);
    inspectorSessionWarm = false;
    inspectorWarmupInFlight = false;
  }
  // Surface toggles (diagnostics, sourceMapping, inlayHints, ...) must take
  // effect immediately, not on the next save: recompute diagnostics from the
  // cached inspection state and ask the editor to re-pull inlay hints.
  refreshAllSurfaces();
});

function refreshAllSurfaces(): void {
  for (const document of documents.all()) {
    const state = states.get(document.uri);
    publishDiagnostics(
      document,
      settings.diagnostics &&
        state?.inspection &&
        state.inspection.sourceVersion === document.version
        ? createDiagnostics(
          document.uri,
          state.discovered,
          state.inspection,
          surfaceOptions(),
        )
        : [],
    );
  }
  refreshInlayHints();
}

documents.onDidOpen(({ document }) => {
  const state = ensureFreshState(document);
  if (state && state.discovered.targets.length > 0) {
    inspector.cancelIdleClose();
  }
  publishDiagnostics(document, []);
  // Establish the expensive first inspector session (Chromium, Vite,
  // dependency optimization) while the user is still reading the file, so
  // their first save lands on a warm session instead of paying the cold cost.
  if (
    settings.warmUpOnOpen &&
    !inspectorSessionWarm &&
    !inspectorWarmupInFlight &&
    (settings.inspectOn === 'save' || settings.inspectOn === 'save-and-hover') &&
    state &&
    state.discovered.targets.length > 0
  ) {
    inspectorWarmupInFlight = true;
    void requestInspection(
      document,
      state.discovered.targets.map((target) => target.id),
      'background',
    ).finally(() => {
      inspectorWarmupInFlight = false;
    });
  }
});

documents.onDidChangeContent(({ document }) => {
  scheduler.cancelDocument(document.uri);
  progress.clearDocument(document.uri);
  // Discovery is deferred until a consumer (hover/inlay/save) needs it, so
  // typing does not re-parse the module on every keystroke.
  if (states.has(document.uri)) {
    publishDiagnostics(document, []);
  }
});

documents.onDidClose(({ document }) => {
  scheduler.cancelDocument(document.uri);
  progress.clearDocument(document.uri);
  states.delete(document.uri);
  publishDiagnostics(document, []);
  if (![...states.values()].some((state) => state.discovered.targets.length > 0)) {
    inspector.scheduleIdleClose(INSPECTOR_IDLE_CLOSE_GRACE_MS, () => {
      inspectorSessionWarm = false;
      inspectorWarmupInFlight = false;
    });
  }
});

documents.onDidSave(({ document }) => {
  let state = ensureFreshState(document);
  if (state) {
    state = { ...state, savedVersion: document.version };
    states.set(document.uri, state);
  }
  if (settings.inspectOn === 'save' || settings.inspectOn === 'save-and-hover') {
    void requestInspection(
      document,
      state?.discovered.targets.map((target) => target.id) ?? [],
      'background',
    );
  }
});

connection.onHover(async ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document) return null;
  const state = ensureFreshState(document);
  if (!state) return null;
  const symbol = state.discovered.symbols.find((candidate) =>
    containsPosition(candidate.range, position));
  if (!symbol) return null;

  // Hover-triggered inspection stays alive even when the hover surface is
  // hidden: in "hover"/"save-and-hover" modes this is what keeps
  // diagnostics and inlays updating.
  inspectOnDemand(document, state, symbol.targetIds);

  if (!settings.hover) return null;
  return createHover(
    symbol,
    state.discovered,
    state.inspection,
    document.version,
    progress.targets(document.uri, document.version),
    { ...surfaceOptions(), documentUri: document.uri },
  );
});

function inspectOnDemand(
  document: TextDocument,
  state: DocumentState,
  targetIds: readonly string[],
): void {
  if (
    (settings.inspectOn === 'hover' || settings.inspectOn === 'save-and-hover') &&
    targetIds.length > 0 &&
    state.savedVersion === document.version &&
    (
      state.inspection?.sourceVersion !== document.version ||
      targetIds.some((id) => !isAttempted(state.inspection, id))
    )
  ) {
    void requestInspection(document, targetIds, 'interactive');
  }
}

connection.onRequest('typegpu/targets', (params: {
  textDocument: { uri: string };
}) => {
  const document = documents.get(params.textDocument.uri);
  const state = document ? ensureFreshState(document) : undefined;
  if (!document || !state) return null;
  return describeTargets(
    document.version,
    state.discovered,
    state.inspection,
    progress.targets(document.uri, document.version),
  );
});

connection.onRequest<ReportResponse | null, void>('typegpu/report', (params: {
  textDocument: { uri: string };
  targetId: string;
}) => {
  const document = documents.get(params.textDocument.uri);
  const state = document ? ensureFreshState(document) : undefined;
  if (!document || !state) return null;
  inspectOnDemand(document, state, [params.targetId]);
  return targetReport(
    document.version,
    state.discovered,
    state.inspection,
    params.targetId,
    progress.targets(document.uri, document.version),
    { ...surfaceOptions(), documentUri: document.uri },
  );
});

connection.onRequest<WgslResponse | null, void>('typegpu/wgsl', (params: {
  textDocument: { uri: string };
  targetId: string;
}) => {
  const document = documents.get(params.textDocument.uri);
  const state = document ? ensureFreshState(document) : undefined;
  if (!document || !state) return null;
  inspectOnDemand(document, state, [params.targetId]);
  return generatedWgsl(
    document.version,
    state.discovered,
    state.inspection,
    params.targetId,
    progress.targets(document.uri, document.version),
  );
});

connection.onRequest('textDocument/inlayHint', (params: {
  textDocument: { uri: string };
  range: Range;
}) => {
  if (!settings.inlayHints) return [];
  const document = documents.get(params.textDocument.uri);
  const state = document ? ensureFreshState(document) : undefined;
  if (!document || !state) return [];
  return createInlayHints(
    state.discovered,
    state.inspection,
    document.version,
    params.range,
    progress.targets(document.uri, document.version),
    surfaceOptions(),
  );
});

connection.onDocumentLinks(({ textDocument }) => {
  if (!settings.documentLinks) return [];
  const document = documents.get(textDocument.uri);
  const state = document ? ensureFreshState(document) : undefined;
  if (!state) return [];
  return createDocumentLinks(state.discovered, state.inspection);
});

connection.onCodeAction(({ textDocument, context }) => {
  const actions = createCodeActions(context);
  // Zed has no settings QuickPick, so independent hover/inlay selectors live
  // in its code-actions menu. VS Code provides dedicated persistent pickers.
  if (presentation === 'zed') {
    const document = documents.get(textDocument.uri);
    const state = document ? ensureFreshState(document) : undefined;
    if (state && state.discovered.targets.length > 0) {
      actions.push(...createDetailLevelActions(settings.hoverDetailLevel));
      actions.push(...createInlayDetailLevelActions(settings.inlayDetailLevel));
    }
  }
  return actions;
});

connection.onExecuteCommand(async ({ command, arguments: args }) => {
  if (command === 'typegpuInspector.setHoverDetailLevel') {
    const level = args?.[0];
    if (!isHoverDetailLevel(level)) return;
    // In-memory only: editors that persist settings (VS Code) write the
    // config instead, which flows back through didChangeConfiguration.
    settings = { ...settings, hoverDetailLevel: level };
    refreshAllSurfaces();
    return;
  }
  if (command === 'typegpuInspector.setInlayDetailLevel') {
    const level = args?.[0];
    if (!isInlayDetailLevel(level)) return;
    settings = { ...settings, inlayDetailLevel: level };
    refreshAllSurfaces();
    return;
  }
  if (command !== 'typegpuInspector.openGeneratedWgsl') return;
  const argument = args?.[0];
  if (!isRecord(argument) || typeof argument.uri !== 'string') return;
  await connection.window.showDocument({
    uri: argument.uri,
    takeFocus: true,
    ...(isRange(argument.selection) ? { selection: argument.selection } : {}),
  });
});

function isHoverDetailLevel(value: unknown): value is InspectorSettings['hoverDetailLevel'] {
  return DETAIL_LEVELS.includes(value as (typeof DETAIL_LEVELS)[number]);
}

function isInlayDetailLevel(value: unknown): value is InspectorSettings['inlayDetailLevel'] {
  return INLAY_DETAIL_LEVELS.includes(value as (typeof INLAY_DETAIL_LEVELS)[number]);
}

connection.onShutdown(async () => {
  scheduler.cancelAll();
  await inspector.close();
});

connection.onExit(() => {
  void shutdown(0);
});

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.cancelAll();
  // Bounded: a wedged inspector child must not block editor shutdown.
  await Promise.race([
    inspector.close().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

documents.listen(connection);
connection.listen();

function ensureFreshState(document: TextDocument): DocumentState | undefined {
  const fileName = fileNameFromUri(document.uri);
  if (!fileName) return undefined;
  const previous = states.get(document.uri);
  if (previous && previous.discoveredVersion === document.version) {
    return previous;
  }
  const discovered = discoverTypeGpuModule(fileName, document.getText());
  const next: DocumentState = {
    discoveredVersion: document.version,
    savedVersion: previous?.savedVersion ?? document.version,
    discovered,
    ...(previous?.inspection ? { inspection: previous.inspection } : {}),
  };
  states.set(document.uri, next);
  return next;
}

// Additive editor-facing status feed (used by the VS Code status bar).
// Clients that do not know the notification simply ignore it.
type InspectionStatus = {
  state: 'inspecting' | 'done' | 'failed' | 'idle';
  uri: string;
  targetCount?: number | undefined;
  passedTargetCount?: number | undefined;
  failedTargetCount?: number | undefined;
  elapsedMs?: number | undefined;
  message?: string | undefined;
  /** True while no inspection has completed yet, i.e. the first run is still
   * paying session-establishment costs and may take minutes. */
  coldStart?: boolean | undefined;
};

let inspectorSessionWarm = false;
let inspectorWarmupInFlight = false;
const INSPECTOR_IDLE_CLOSE_GRACE_MS = 60_000;

function sendInspectionStatus(status: InspectionStatus): void {
  void connection.sendNotification('typegpu/inspectionStatus', status);
}

async function inspectDocument(
  document: TextDocument,
  targetIds: readonly string[],
  priority: InspectionPriority,
): Promise<DocumentInspection | undefined> {
  // TextDocuments mutates document instances in place, so every version read
  // after an await would observe post-edit state. Snapshot once up front.
  const sourceVersion = document.version;
  const state = ensureFreshState(document);
  const modulePath = fileNameFromUri(document.uri);
  const targets = state
    ? selectInspectionTargets(state.discovered, targetIds)
    : [];
  if (!state || !modulePath || targets.length === 0) {
    publishDiagnostics(document, []);
    return undefined;
  }
  if (settings.inspectOn === 'off') return state.inspection;

  const discovered = state.discovered;
  const requestedTargetIds = targets.map((target) => target.id);
  const progressToken = progress.begin(
    document.uri,
    sourceVersion,
    requestedTargetIds,
  );
  refreshInlayHints();

  const startedAt = Date.now();
  try {
    connection.console.info(
      `Inspecting ${modulePath} (${targets.length} targets, ${priority})`,
    );
    sendInspectionStatus({
      state: 'inspecting',
      uri: document.uri,
      targetCount: targets.length,
      coldStart: !inspectorSessionWarm,
    });
    let inspection: DocumentInspection;
    try {
      const result = await scheduler.schedule(
        {
          documentUri: document.uri,
          sourceVersion,
          targetIds: requestedTargetIds,
          priority,
        },
        (signal) => inspector.inspect(modulePath, targets, signal),
      );
      if (result.status === 'superseded') {
        sendInspectionStatus({ state: 'idle', uri: document.uri });
        return undefined;
      }
      inspectorSessionWarm = true;
      inspection = await materializeInspection(
        settings.projectRoot ?? workspaceRoot,
        modulePath,
        sourceVersion,
        discovered,
        result.value,
        requestedTargetIds,
      );
      sendInspectionStatus({
        state: 'done',
        uri: document.uri,
        targetCount: targets.length,
        passedTargetCount: inspection.output.summary?.passedTargetCount,
        failedTargetCount: inspection.output.summary?.failedTargetCount,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      sendInspectionStatus({
        state: 'failed',
        uri: document.uri,
        targetCount: targets.length,
        elapsedMs: Date.now() - startedAt,
        message: errorMessage(error),
      });
      inspection = failedTargetInspection(
        sourceVersion,
        requestedTargetIds,
        errorMessage(error),
      );
    }

    const current = states.get(document.uri);
    const liveDocument = documents.get(document.uri);
    if (current && liveDocument?.version === sourceVersion) {
      const merged = mergeDocumentInspections(
        current.inspection,
        inspection,
        requestedTargetIds,
      );
      states.set(document.uri, { ...current, inspection: merged });
      publishDiagnostics(
        liveDocument,
        settings.diagnostics
          ? createDiagnostics(
            document.uri,
            current.discovered,
            merged,
            surfaceOptions(),
          )
          : [],
      );
      return merged;
    }
    return inspection;
  } finally {
    progress.finish(progressToken);
    refreshInlayHints();
  }
}

function requestInspection(
  document: TextDocument,
  targetIds: readonly string[],
  priority: InspectionPriority,
): Promise<DocumentInspection | undefined> {
  const sourceVersion = document.version;
  const key = [
    document.uri,
    sourceVersion,
    priority,
    [...new Set(targetIds)].sort().join(','),
  ].join(':');
  const existing = inspectionRequests.get(key);
  if (existing) return existing;

  const request = inspectDocument(document, targetIds, priority);
  inspectionRequests.set(key, request);
  void request.then(
    () => inspectionRequests.delete(key),
    () => inspectionRequests.delete(key),
  );
  return request;
}

function surfaceOptions(): SurfaceOptions {
  return {
    sourceMapping: settings.sourceMapping,
    schemaLayoutHealth: settings.schemaLayoutHealth,
    schemaPackingSuggestions: settings.schemaPackingSuggestions,
    saveAffordance: settings.inspectOn === 'save' ||
      settings.inspectOn === 'save-and-hover',
    presentation,
    hoverDetailLevel: settings.hoverDetailLevel,
    inlayDetailLevel: settings.inlayDetailLevel,
    hoverPresentation: settings.hoverPresentation,
    defaultMaxColumns: defaultHoverColumns,
  };
}

function refreshInlayHints(): void {
  void connection.sendRequest('workspace/inlayHint/refresh').catch(() => {
    // Older Zed builds may not advertise refresh support.
  });
}

function publishDiagnostics(
  document: TextDocument,
  diagnostics: Diagnostic[],
): void {
  connection.sendDiagnostics({
    uri: document.uri,
    version: document.version,
    diagnostics,
  });
}

function applySettings(value: unknown): InspectorSettings {
  const warnings: SettingsWarning[] = [];
  const merged = mergeSettings(value, defaultSettings, warnings);
  for (const warning of warnings) {
    connection.console.warn(
      `Ignoring invalid setting "${warning.key}": ${warning.detail}`,
    );
  }
  return merged;
}

function rootFromInitialize(params: InitializeParams): string | undefined {
  const uri = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
  if (!uri) return undefined;
  return fileNameFromUri(uri);
}

function fileNameFromUri(uri: string): string | undefined {
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function isAttempted(
  inspection: DocumentInspection | undefined,
  targetId: string,
): boolean {
  if (!inspection) return false;
  return inspection.targets.has(targetId) ||
    (inspection.unreported?.has(targetId) ?? false) ||
    (inspection.targetFailures?.has(targetId) ?? false);
}

function containsPosition(range: Range, position: Position): boolean {
  return comparePosition(position, range.start) >= 0 &&
    comparePosition(position, range.end) <= 0;
}

function comparePosition(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRange(value: unknown): value is Range {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) {
    return false;
  }
  return typeof value.start.line === 'number' &&
    typeof value.start.character === 'number' &&
    typeof value.end.line === 'number' &&
    typeof value.end.character === 'number';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
