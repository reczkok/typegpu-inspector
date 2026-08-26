import * as path from 'node:path';
import {
  CodeLens,
  Diagnostic,
  DiagnosticSeverity,
  EventEmitter,
  Location,
  Position,
  Range,
  Uri,
  ViewColumn,
  commands,
  languages,
  window,
  workspace,
  type CodeLensProvider,
  type Disposable,
  type TextDocument,
  type TextDocumentContentProvider,
  type TextEditor,
} from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

export const WGSL_SCHEME = 'typegpu-wgsl';
const LIVE_PATH = '/TypeGPU WGSL.wgsl';
const FOLLOW_DEBOUNCE_MS = 120;

export type TargetRef = { uri: string; targetId: string };

type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };

type TargetsResponse = {
  version: number;
  stale: boolean;
  symbols: Array<{ name: string; range: LspRange; targetIds: string[] }>;
  targets: Array<{ id: string; label: string; status: string; wgslLines?: number }>;
};

type WgslResponse =
  | { ok: true; label: string; wgsl: string; stale: boolean; messages: Array<{ type: string; message: string; range?: LspRange }> }
  | { ok: false; label?: string; reason: string };

type ViewMeta = { ref: TargetRef; label: string; stale: boolean; ok: boolean; reason?: string };

/**
 * Generated WGSL as read-only virtual documents. One live document follows the
 * cursor across targets (the Markdown-preview model); pinned documents show a
 * single target. Both refresh in place after every inspection.
 */
export class WgslPreview implements TextDocumentContentProvider, CodeLensProvider, Disposable {
  private readonly contentChanged = new EventEmitter<Uri>();
  public readonly onDidChange = this.contentChanged.event;
  private readonly lensesChanged = new EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly diagnostics = languages.createDiagnosticCollection('TypeGPU WGSL');
  private readonly views = new Map<string, ViewMeta>();
  private readonly targetsCache = new Map<string, TargetsResponse>();
  private live: TargetRef | undefined;
  private followTimer: NodeJS.Timeout | undefined;
  private readonly disposables: Disposable[];

  public constructor(private readonly client: () => LanguageClient | undefined) {
    this.disposables = [
      workspace.registerTextDocumentContentProvider(WGSL_SCHEME, this),
      languages.registerCodeLensProvider({ scheme: WGSL_SCHEME }, this),
      window.onDidChangeTextEditorSelection((event) => this.scheduleFollow(event.textEditor)),
      window.onDidChangeActiveTextEditor((editor) => editor && this.scheduleFollow(editor)),
      workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme !== WGSL_SCHEME) return;
        this.views.delete(document.uri.toString());
        this.diagnostics.delete(document.uri);
      }),
      this.diagnostics,
    ];
  }

  public dispose(): void {
    if (this.followTimer) clearTimeout(this.followTimer);
    for (const disposable of this.disposables) disposable.dispose();
  }

  /** Opens (or focuses) the cursor-following document beside the active editor. */
  public async openLive(): Promise<void> {
    const source = window.activeTextEditor;
    await window.showTextDocument(liveUri(), {
      viewColumn: ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
    });
    if (source) await this.follow(source);
  }

  public async openPinned(ref: TargetRef): Promise<void> {
    const label = await this.labelFor(ref);
    await window.showTextDocument(pinnedUri(ref, label), {
      viewColumn: ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
    });
  }

  public async peek(ref: TargetRef): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor) return this.openPinned(ref);
    const label = await this.labelFor(ref);
    await commands.executeCommand(
      'editor.action.peekLocations',
      editor.document.uri,
      editor.selection.active,
      [new Location(pinnedUri(ref, label), new Position(0, 0))],
      'peek',
    );
  }

  /** Jumps from a generated-WGSL document back to the TypeGPU symbol it came from. */
  public async revealSource(ref: TargetRef): Promise<void> {
    const targets = await this.targetsFor(ref.uri);
    const symbol = targets?.symbols.find((entry) => entry.targetIds.includes(ref.targetId));
    const sourceUri = Uri.parse(ref.uri);
    const existing = window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === sourceUri.toString(),
    );
    await window.showTextDocument(sourceUri, {
      viewColumn: existing?.viewColumn ?? ViewColumn.One,
      ...(symbol ? { selection: toRange(symbol.range) } : {}),
    });
  }

  /** Called when an inspection of `sourceUri` finishes. */
  public refresh(sourceUri: string): void {
    this.targetsCache.clear();
    for (const document of workspace.textDocuments) {
      if (document.uri.scheme !== WGSL_SCHEME) continue;
      const ref = this.refFor(document.uri);
      if (ref?.uri === sourceUri) this.contentChanged.fire(document.uri);
    }
  }

  public async provideTextDocumentContent(uri: Uri): Promise<string> {
    const ref = this.refFor(uri);
    if (!ref) {
      this.setView(uri, undefined);
      return '// Move the cursor onto a TypeGPU symbol to show its generated WGSL here.\n';
    }
    const client = this.client();
    if (!client) {
      this.setView(uri, undefined);
      return '// TypeGPU Inspector is not running.\n';
    }
    const response = await client.sendRequest<WgslResponse | null>('typegpu/wgsl', {
      textDocument: { uri: ref.uri },
      targetId: ref.targetId,
    });
    if (!response) {
      this.setView(uri, undefined);
      return '// The source file is not open in this window.\n';
    }
    if (!response.ok) {
      this.setView(uri, { ref, label: response.label ?? ref.targetId, stale: false, ok: false, reason: response.reason });
      return `// ${response.label ?? ref.targetId}: ${response.reason}\n`;
    }
    this.setView(uri, { ref, label: response.label, stale: response.stale, ok: true }, response.messages);
    return response.wgsl;
  }

  public provideCodeLenses(document: TextDocument): CodeLens[] {
    const meta = this.views.get(document.uri.toString());
    if (!meta) return [];
    const isLive = document.uri.path === LIVE_PATH;
    const sourceFile = path.basename(Uri.parse(meta.ref.uri).fsPath);
    const title = [
      `$(symbol-method) ${meta.label}`,
      sourceFile,
      ...(meta.stale ? ['from previous save'] : []),
    ].join(' · ');
    const head = new Range(0, 0, 0, 0);
    const lenses = [
      new CodeLens(head, {
        title,
        tooltip: 'Reveal the TypeGPU symbol this WGSL was generated from',
        command: 'typegpuInspector.revealSource',
        arguments: [meta.ref],
      }),
    ];
    if (isLive) {
      lenses.push(new CodeLens(head, {
        title: '$(pin) Pin',
        tooltip: 'Keep this target open in its own tab while the live view moves on',
        command: 'typegpuInspector.openWgsl',
        arguments: [meta.ref],
      }));
    }
    return lenses;
  }

  private setView(
    uri: Uri,
    meta: ViewMeta | undefined,
    messages: Array<{ type: string; message: string; range?: LspRange }> = [],
  ): void {
    if (meta) this.views.set(uri.toString(), meta);
    else this.views.delete(uri.toString());
    this.diagnostics.set(
      uri,
      messages
        .filter((message) => message.range)
        .map((message) => {
          const diagnostic = new Diagnostic(
            toRange(message.range!),
            message.message,
            compilerSeverity(message.type),
          );
          diagnostic.source = 'WGSL compiler';
          return diagnostic;
        }),
    );
    this.lensesChanged.fire();
  }

  private refFor(uri: Uri): TargetRef | undefined {
    if (uri.path === LIVE_PATH) return this.live;
    const query = new URLSearchParams(uri.query);
    const source = query.get('uri');
    const targetId = query.get('target');
    return source && targetId ? { uri: source, targetId } : undefined;
  }

  private scheduleFollow(editor: TextEditor): void {
    if (editor.document.uri.scheme !== 'file' || !this.isLiveVisible()) return;
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => {
      this.followTimer = undefined;
      void this.follow(editor);
    }, FOLLOW_DEBOUNCE_MS);
  }

  private isLiveVisible(): boolean {
    return window.visibleTextEditors.some(
      (editor) => editor.document.uri.scheme === WGSL_SCHEME && editor.document.uri.path === LIVE_PATH,
    );
  }

  private async follow(editor: TextEditor): Promise<void> {
    if (editor.document.uri.scheme !== 'file') return;
    const targets = await this.targetsFor(editor.document.uri.toString());
    if (!targets) return;
    const cursor = editor.selection.active;
    const symbol = targets.symbols.find((entry) => toRange(entry.range).contains(cursor));
    if (!symbol) return;
    const byId = new Map(targets.targets.map((target) => [target.id, target]));
    // Prefer a target that has (or will have) WGSL over a plain resource.
    const targetId = symbol.targetIds.find((id) => (byId.get(id)?.wgslLines ?? 0) > 0) ??
      symbol.targetIds[0];
    if (!targetId) return;
    const ref = { uri: editor.document.uri.toString(), targetId };
    if (this.live?.uri === ref.uri && this.live.targetId === ref.targetId) return;
    this.live = ref;
    this.contentChanged.fire(liveUri());
  }

  private async targetsFor(uri: string): Promise<TargetsResponse | undefined> {
    const client = this.client();
    if (!client) return undefined;
    const document = workspace.textDocuments.find((entry) => entry.uri.toString() === uri);
    const key = `${uri}@${document?.version ?? -1}`;
    const cached = this.targetsCache.get(key);
    if (cached) return cached;
    const response = await client.sendRequest<TargetsResponse | null>('typegpu/targets', {
      textDocument: { uri },
    });
    if (!response) return undefined;
    this.targetsCache.clear();
    this.targetsCache.set(key, response);
    return response;
  }

  private async labelFor(ref: TargetRef): Promise<string> {
    const targets = await this.targetsFor(ref.uri);
    return targets?.targets.find((target) => target.id === ref.targetId)?.label ?? ref.targetId;
  }
}

function liveUri(): Uri {
  return Uri.from({ scheme: WGSL_SCHEME, path: LIVE_PATH });
}

function pinnedUri(ref: TargetRef, label: string): Uri {
  const fileName = `${label.replace(/[^\w.-]+/g, '_')}.wgsl`;
  return Uri.from({
    scheme: WGSL_SCHEME,
    path: `/${fileName}`,
    query: new URLSearchParams({ uri: ref.uri, target: ref.targetId }).toString(),
  });
}

function toRange(range: LspRange): Range {
  return new Range(
    new Position(range.start.line, range.start.character),
    new Position(range.end.line, range.end.character),
  );
}

function compilerSeverity(type: string): DiagnosticSeverity {
  switch (type.toLowerCase()) {
    case 'error':
      return DiagnosticSeverity.Error;
    case 'warning':
      return DiagnosticSeverity.Warning;
    default:
      return DiagnosticSeverity.Information;
  }
}

export function isTargetRef(value: unknown): value is TargetRef {
  return typeof value === 'object' && value !== null &&
    typeof (value as TargetRef).uri === 'string' &&
    typeof (value as TargetRef).targetId === 'string';
}
