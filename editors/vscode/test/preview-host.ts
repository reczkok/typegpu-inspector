import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { WgslPreview, WGSL_SCHEME } from '../src/wgslPreview';
import { findEditorTarget, type TargetsResponse, type WgslResponse } from '../../../server/src/editorProtocol';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert(Date.now() < deadline, description);
    await delay(50);
  }
}

/** Real VS Code documents, QuickPick, selection events and diagnostics; deterministic server responses. */
export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const sourcePath = join(root, 'shader.ts');
  await writeFile(sourcePath, 'const helper = () => 7;\n');
  const source = await vscode.workspace.openTextDocument(sourcePath);
  const editor = await vscode.window.showTextDocument(source);
  editor.selection = new vscode.Selection(0, 7, 0, 7);
  let snapshot: TargetsResponse = {
    version: source.version, stale: false,
    symbols: [{ name: 'makeBlur.helper', range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } }, targetIds: ['a', 'b'] }],
    targets: [0, 1].map(instance => ({ id: instance ? 'b' : 'a', label: `makeBlur.helper [instance ${instance}]`, context: { instance }, status: 'ok', outcome: 'passed' })),
  };
  let broken = false;
  let refreshing = false;
  let delayed: (() => Promise<WgslResponse>) | undefined;
  const client = {
    async sendRequest(method: string, params: { targetId: string; targetKey?: string }) {
      if (method === 'typegpu/targets') return structuredClone(snapshot);
      assert.equal(method, 'typegpu/wgsl');
      if (delayed) { const next = delayed; delayed = undefined; return next(); }
      const target = findEditorTarget(snapshot, params);
      if (!target) return { ok: false, reason: 'Select this specialization again.' };
      return {
        ok: true, label: target.label, sourceVersion: snapshot.version, stale: snapshot.stale,
        refreshing, outcome: broken ? 'failed' : 'passed', context: target.context,
        wgsl: `fn helper() -> f32 { return ${broken ? 'missing' : target.context?.instance ? 7 : 3}; }`,
        messages: broken ? [{ type: 'error', message: 'Unknown identifier missing', range: { start: { line: 0, character: 27 }, end: { line: 0, character: 34 } } }] : [],
      };
    },
  } as unknown as LanguageClient;
  const preview = new WgslPreview(() => client);
  const liveUri = vscode.Uri.from({ scheme: WGSL_SCHEME, path: '/TypeGPU WGSL.wgsl' });
  try {
    const choosing = preview.selectTarget();
    await delay(400);
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await delay(150);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await choosing;
    const live = await vscode.workspace.openTextDocument(liveUri);
    await until(() => live.getText().includes('return 7'), `Picker must open instance 1: ${live.getText()}`);

    // A source offset change must keep instance 1, including a pinned document.
    await preview.openPinned({ uri: source.uri.toString(), targetId: 'b' });
    const pinned = vscode.workspace.textDocuments.find(document => document.uri.scheme === WGSL_SCHEME && document.uri.path !== liveUri.path)!;
    assert(pinned);
    snapshot = structuredClone(snapshot);
    snapshot.targets[0]!.id = 'moved-a'; snapshot.targets[1]!.id = 'moved-b';
    snapshot.symbols[0]!.targetIds = ['moved-a', 'moved-b'];
    snapshot.version++;
    preview.refresh(source.uri.toString());
    await until(() => pinned.getText().includes('return 7') && preview.provideCodeLenses(pinned).some(lens => lens.command?.title.includes(`source v${snapshot.version}`)), 'Pin must survive offset changes');

    // Late responses must never replace newer diagnostics or code.
    let finishOld!: (result: WgslResponse) => void;
    delayed = () => new Promise(resolve => { finishOld = resolve; });
    const pending = preview.provideTextDocumentContent(liveUri);
    await until(() => !!finishOld, 'Delayed request starts');
    broken = true;
    preview.refresh(source.uri.toString());
    await until(() => live.getText().includes('return missing'), 'Compiler error updates the document');
    finishOld({ ok: true, label: 'old', wgsl: 'OLD RESPONSE', sourceVersion: 1, stale: false, refreshing: false, outcome: 'passed', messages: [] });
    assert((await pending).includes('return missing'));
    await until(() => vscode.languages.getDiagnostics(liveUri).some(diagnostic => diagnostic.message.includes('missing')), 'Generated compiler diagnostics appear');

    refreshing = true; snapshot.stale = true;
    preview.refresh(source.uri.toString());
    assert((await preview.provideTextDocumentContent(liveUri)).includes('return missing'));
    assert(preview.provideCodeLenses(live).some(lens => lens.command?.title.includes('previous save')));

    broken = false; refreshing = false; snapshot.stale = false;
    preview.refresh(source.uri.toString());
    await until(() => live.getText().includes('return 7') && vscode.languages.getDiagnostics(liveUri).length === 0, 'Recovery clears errors and retains instance 1');

    // Removing the selected instance must not silently choose the remaining one.
    snapshot.targets.pop(); snapshot.symbols[0]!.targetIds.pop();
    preview.refresh(source.uri.toString());
    await until(() => !live.getText().includes('return 7'), 'Removed target invalidates the view');
    assert(!live.getText().includes('return 3'));
    await writeFile(join(root, 'preview-host-result.json'), JSON.stringify({ ok: true, checks: ['native picker', 'pinned identity', 'late response', 'stale WGSL', 'compiler diagnostics', 'recovery', 'removed instance'] }, null, 2));
  } finally {
    preview.dispose();
  }
}
