import * as path from 'node:path';
import {
  CodeLens,
  Diagnostic,
  DiagnosticSeverity,
  EventEmitter,
  Location,
  Position,
  Range,
  TabInputWebview,
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

import { targetSelectionKey, findEditorTarget, targetContextLabel, targetStatusLabel, type TargetRef, type SourceRange as LspRange, type TargetsResponse, type WgslResponse, type ReportResponse } from '../../../server/src/editorProtocol';
import { EditorSelection } from '../../../server/src/editorSelection';
export type { TargetRef } from '../../../server/src/editorProtocol';

export const WGSL_SCHEME = 'typegpu-wgsl';
const LIVE_PATH = '/TypeGPU WGSL.wgsl';
const REPORT_PATH = '/TypeGPU Report.md';
const FOLLOW_DEBOUNCE_MS = 120;

type ViewMeta = { ref: TargetRef; label: string; stale: boolean; ok: boolean; reason?: string; detail?: string };

/**
 * Generated WGSL and inspection reports as read-only virtual documents. The
 * live WGSL document and the report (rendered by the Markdown preview) follow
 * the cursor across targets; pinned documents show a single target. All
 * refresh in place after every inspection.
 */
export class WgslPreview implements TextDocumentContentProvider, CodeLensProvider, Disposable {
  private readonly contentChanged = new EventEmitter<Uri>();
  public readonly onDidChange = this.contentChanged.event;
  private readonly lensesChanged = new EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly diagnostics = languages.createDiagnosticCollection('TypeGPU WGSL');
  private readonly views = new Map<string, ViewMeta>();
  private readonly selection = new EditorSelection();
  private sourceUri: string | undefined;
  private revision = 0;
  private followRevision = 0;
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
      this.contentChanged,
      this.lensesChanged,
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
    if (!this.live) await this.selectTarget();
  }

  /** Opens the cursor-following report in the built-in Markdown preview. */
  public async openReport(): Promise<void> {
    const source = window.activeTextEditor;
    await workspace.openTextDocument(reportUri());
    await commands.executeCommand('markdown.showPreviewToSide', reportUri());
    if (source) await this.follow(source);
  }

  public async openPinned(ref: TargetRef): Promise<void> {
    const snapshot = await this.targetsFor(ref.uri);
    const target = snapshot ? findEditorTarget(snapshot, ref) : undefined;
    if (target) ref = { ...ref, targetId: target.id, targetKey: targetSelectionKey(target) };
    const label = target?.label ?? ref.targetId;
    await window.showTextDocument(pinnedUri(ref, label), {
      viewColumn: ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
    });
  }

  public async peek(ref: TargetRef): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor) return this.openPinned(ref);
    const snapshot = await this.targetsFor(ref.uri);
    const target = snapshot ? findEditorTarget(snapshot, ref) : undefined;
    if (target) ref = { ...ref, targetId: target.id, targetKey: targetSelectionKey(target) };
    const label = target?.label ?? ref.targetId;
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
    const target = targets ? findEditorTarget(targets, ref) : undefined;
    const symbol = targets?.symbols.find((entry) => entry.targetIds.includes(target?.id ?? ref.targetId));
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
    this.revision++;
    this.followRevision++;
    for (const document of workspace.textDocuments) {
      if (document.uri.scheme !== WGSL_SCHEME) continue;
      const ref = this.refFor(document.uri);
      if (ref?.uri === sourceUri || (!ref && this.sourceUri === sourceUri)) this.contentChanged.fire(document.uri);
    }
    const source = window.visibleTextEditors.find(editor => editor.document.uri.toString() === sourceUri);
    if (source) this.scheduleFollow(source);
  }

  public async provideTextDocumentContent(uri: Uri): Promise<string> {
    const revision = this.revision;
    if (uri.path === REPORT_PATH) return this.provideReport();
    const ref = this.refFor(uri);
    if (!ref) {
      this.setView(uri, undefined);
      return '// Select a TypeGPU specialization to inspect its generated WGSL.\n';
    }
    const client = this.client();
    if (!client) {
      this.setView(uri, undefined);
      return '// TypeGPU Inspector is not running.\n';
    }
    const response = await client.sendRequest<WgslResponse | null>('typegpu/wgsl', {
      textDocument: { uri: ref.uri },
      targetId: ref.targetId,
      targetKey: ref.targetKey,
    });
    if (revision !== this.revision || client !== this.client()) return this.provideTextDocumentContent(uri);
    if (!response) {
      this.setView(uri, undefined);
      return '// The source file is not open in this window.\n';
    }
    if (!response.ok) {
      this.setView(uri, { ref, label: response.label ?? ref.targetId, stale: false, ok: false, reason: response.reason });
      return `// ${response.label ?? ref.targetId}: ${response.reason}\n`;
    }
    this.setView(uri, {
      ref, label: response.label, stale: response.stale, ok: true,
      detail: [targetStatusLabel({ status: response.refreshing ? 'inspecting' : 'ok', outcome: response.outcome }),
        response.inputSummary, targetContextLabel(response.context), `source v${response.sourceVersion}`].filter(Boolean).join(' · '),
    }, response.messages);
    return response.wgsl;
  }

  private async provideReport(): Promise<string> {
    const revision = this.revision;
    const ref = this.live;
    const client = this.client();
    if (!ref || !client) {
      return '_Move the cursor onto a TypeGPU symbol to show its inspection report here._\n';
    }
    const response = await client.sendRequest<ReportResponse | null>('typegpu/report', {
      textDocument: { uri: ref.uri },
      targetId: ref.targetId,
      targetKey: ref.targetKey,
    });
    if (revision !== this.revision || client !== this.client()) return this.provideReport();
    if (!response) return '_The source file is not open in this window._\n';
    const targets = await this.targetsFor(ref.uri);
    const target = targets ? findEditorTarget(targets, ref) : undefined;
    const symbol = targets?.symbols.find((entry) => entry.targetIds.includes(target?.id ?? ref.targetId));
    const sourceUri = Uri.parse(ref.uri);
    if (revision !== this.revision || client !== this.client()) return this.provideReport();
    const line = (symbol?.range.start.line ?? 0) + 1;
    const origin = `[${path.basename(sourceUri.fsPath)}:${line}](${sourceUri.toString()}#L${line})`;
    if (!response.ok) {
      return `${origin}\n\n_${response.label ?? ref.targetId}: ${response.reason}_\n`;
    }
    const note = response.stale ? ' · _from previous save_' : '';
    return `${origin}${note}\n\n${response.markdown}\n`;
  }

  public provideCodeLenses(document: TextDocument): CodeLens[] {
    const meta = this.views.get(document.uri.toString());
    if (!meta) return [new CodeLens(new Range(0, 0, 0, 0), { title: 'Select specialization', command: 'typegpuInspector.selectTarget' })];
    const isLive = document.uri.path === LIVE_PATH;
    const sourceFile = path.basename(Uri.parse(meta.ref.uri).fsPath);
    const title = [
      `$(symbol-method) ${meta.label}`,
      sourceFile,
      meta.detail,
      ...(meta.stale ? ['from previous save'] : []),
    ].filter(Boolean).join(' · ');
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
      lenses.push(new CodeLens(head, { title: 'Select specialization', command: 'typegpuInspector.selectTarget' }));
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
    if (uri.path === LIVE_PATH || uri.path === REPORT_PATH) return this.live;
    const query = new URLSearchParams(uri.query);
    const source = query.get('uri');
    const targetId = query.get('target');
    const targetKey = query.get('key');
    return source && targetId ? { uri: source, targetId, ...(targetKey ? { targetKey } : {}) } : undefined;
  }

  private scheduleFollow(editor: TextEditor): void {
    if (editor.document.uri.scheme !== 'file' || !this.isLiveVisible()) return;
    this.followRevision++;
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => {
      this.followTimer = undefined;
      void this.follow(editor);
    }, FOLLOW_DEBOUNCE_MS);
  }

  private isLiveVisible(): boolean {
    const liveEditor = window.visibleTextEditors.some(
      (editor) => editor.document.uri.scheme === WGSL_SCHEME && editor.document.uri.path === LIVE_PATH,
    );
    // The report lives in a Markdown preview webview, not a text editor.
    const reportOpen = workspace.textDocuments.some(
      (document) => document.uri.scheme === WGSL_SCHEME && document.uri.path === REPORT_PATH,
    ) && window.tabGroups.all.some((group) =>
      group.tabs.some((tab) =>
        tab.input instanceof TabInputWebview && tab.input.viewType.includes('markdown.preview')
      )
    );
    return liveEditor || reportOpen;
  }

  public async selectTarget(): Promise<void> {
    const active = window.activeTextEditor;
    const uri = active?.document.uri.scheme === 'file' ? active.document.uri.toString() : this.sourceUri;
    if (!uri) return;
    const snapshot = await this.targetsFor(uri);
    if (!snapshot?.targets.length) {
      void window.showInformationMessage('No TypeGPU targets yet. Save the source file to inspect it.');
      return;
    }
    const picked = await window.showQuickPick(snapshot.targets.filter(target => target.kind !== 'resource').map(target => ({
      label: target.label,
      description: `${targetStatusLabel(target)}${snapshot.stale ? ' · previous save' : ''}`,
      detail: [target.inputSummary, targetContextLabel(target.context), target.requirementSummary].filter(Boolean).join(' · ') || target.diagnostics?.find(diagnostic => diagnostic.severity !== 'note')?.message,
      targetId: target.id,
      targetKey: targetSelectionKey(target),
    })), { title: 'TypeGPU: Select specialization', matchOnDescription: true, matchOnDetail: true });
    if (!picked) return;
    const current = await this.targetsFor(uri);
    const selected = current ? findEditorTarget(current, picked) : undefined;
    if (!current || !selected) {
      void window.showInformationMessage('That specialization changed during inspection. Select it again.');
      return;
    }
    this.followRevision++;
    this.selection.select(uri, current, selected.id);
    this.sourceUri = uri;
    this.setLive({ uri, targetId: selected.id, targetKey: targetSelectionKey(selected) });
    await window.showTextDocument(liveUri(), { viewColumn: ViewColumn.Beside, preserveFocus: true, preview: false });
  }

  private setLive(ref: TargetRef | undefined): void {
    if (this.live?.uri === ref?.uri && this.live?.targetId === ref?.targetId && this.live?.targetKey === ref?.targetKey) return;
    this.live = ref;
    this.revision++;
    this.contentChanged.fire(liveUri());
    this.contentChanged.fire(reportUri());
  }

  private async follow(editor: TextEditor): Promise<void> {
    if (editor.document.uri.scheme !== 'file') return;
    const revision = ++this.followRevision;
    const version = editor.document.version;
    const cursor = editor.selection.active;
    const uri = editor.document.uri.toString();
    const targets = await this.targetsFor(uri);
    if (revision !== this.followRevision || version !== editor.document.version || !targets) return;
    this.sourceUri = uri;
    // Pick the innermost declaration when source ranges overlap.
    const symbol = targets.symbols.filter(entry => toRange(entry.range).contains(cursor)).sort((a, b) =>
      (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line) ||
      (a.range.end.character - a.range.start.character) - (b.range.end.character - b.range.start.character)
    )[0];
    if (!symbol) return;
    this.setLive(this.selection.resolve(uri, targets, symbol));
  }

  private async targetsFor(uri: string): Promise<TargetsResponse | undefined> {
    return (await this.client()?.sendRequest<TargetsResponse | null>('typegpu/targets', {
      textDocument: { uri },
    })) ?? undefined;
  }


}

function liveUri(): Uri {
  return Uri.from({ scheme: WGSL_SCHEME, path: LIVE_PATH });
}

function reportUri(): Uri {
  return Uri.from({ scheme: WGSL_SCHEME, path: REPORT_PATH });
}

function pinnedUri(ref: TargetRef, label: string): Uri {
  const fileName = `${label.replace(/[^\w.-]+/g, '_')}.wgsl`;
  return Uri.from({
    scheme: WGSL_SCHEME,
    path: `/${fileName}`,
    query: new URLSearchParams({ uri: ref.uri, target: ref.targetId, ...(ref.targetKey ? { key: ref.targetKey } : {}) }).toString(),
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
    typeof (value as TargetRef).targetId === 'string' &&
    ((value as TargetRef).targetKey === undefined || typeof (value as TargetRef).targetKey === 'string');
}
