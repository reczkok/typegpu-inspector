// Run against an extracted server package with the packaged runtime installed
// beside it. Uses only Node APIs: no repository source imports or MCP test client.
// Usage: node scripts/release-smoke.mjs <server.cjs> <isolated-project> <output-dir>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [entryArg, projectArg, outputArg] = process.argv.slice(2);
assert(entryArg && projectArg && outputArg, 'Expected server entry, isolated project, and output directory');
const entry = resolve(entryArg), project = resolve(projectArg), output = resolve(outputArg);
const env = { ...process.env, NO_COLOR: '1' };
delete env.TYPEGPU_INSPECTOR_RUNTIME_DIR;
delete env.NODE_PATH;
await mkdir(output, { recursive: true });
const fixtures = await mkdtemp(join(project, 'release-smoke-'));
const shaderPath = join(fixtures, 'shader.ts'), contextPath = join(fixtures, 'context.json');
const good = `import tgpu, { d } from 'typegpu';
const privateHelper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(2); });
function makeBlur(radius: number) {
  const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(radius); });
  void helper;
}
makeBlur(3);
makeBlur(7);
`;
const invalid = good.replace(
  "tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(2); })",
  'tgpu.fn([], d.f32)`() -> f32 { return definitely_missing_symbol; }`',
);
await writeFile(shaderPath, good);
await writeFile(contextPath, JSON.stringify({
  module: './shader.ts', setupBody: 'module.makeBlur(11);',
  targets: { 'makeBlur.helper': { label: 'radius 11', instance: 2 } },
}, null, 2));
const brokenPackage = join(fixtures, 'node_modules', 'release-broken');
await mkdir(brokenPackage, { recursive: true });
await writeFile(join(brokenPackage, 'package.json'), JSON.stringify({ name: 'release-broken', version: '1.0.0', main: 'index.js' }));
await writeFile(join(brokenPackage, 'index.js'), 'export const value: number = 1;');
const brokenPath = join(fixtures, 'dependency.ts');
const brokenSource = `import { value } from 'release-broken';
import tgpu, { d } from 'typegpu';
const dependencyHelper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(value); });
`;
await writeFile(brokenPath, brokenSource);
const evidence = { entry, fixtures, cli: {}, lsp: {} };

async function cli(name, args, expectedExit = 0) {
  const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
    cwd: fixtures, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    env,
  });
  await writeFile(join(output, `${name}.stdout.json`), result.stdout ?? '');
  await writeFile(join(output, `${name}.stderr.log`), result.stderr ?? '');
  assert.equal(result.status, expectedExit, `${name}: ${result.error ?? result.stderr ?? result.signal}`);
  const parsed = JSON.parse(result.stdout);
  evidence.cli[name] = { exitCode: result.status };
  return parsed;
}

const compositionPath = join(fixtures, 'composition.ts');
await writeFile(compositionPath, `import { d, tgpu } from 'typegpu';
const make = (offset: number) => (value: d.v2f) => { 'use gpu'; return value.x + offset; };
const returned = make(7);
const isPinned = (index: number) => { 'use gpu'; return index % 8 === 0; };
const compute = tgpu.computeFn({ workgroupSize: [1], in: { gid: d.builtin.globalInvocationId } })(({ gid }) => {
  'use gpu'; const i = gid.x; isPinned(i);
});
`);
const returned = await cli('returned-helper', ['wgsl', compositionPath, '-t', 'make → returned']);
assert.equal(returned.length, 1);
assert.match(returned[0].wgsl, /value: vec2f/);
assert.match(returned[0].wgsl, /7f/);
const caller = await cli('numeric-caller', ['wgsl', compositionPath, '-t', 'isPinned']);
assert.match(caller[0].wgsl, /index: u32/);
assert.equal(caller[0].context.probe.origin, 'call-site');
const pipeline = await cli('numeric-pipeline', ['wgsl', compositionPath, '-t', 'compute']);
assert.equal(/fn isPinned\([^}]+}/.exec(caller[0].wgsl)?.[0], /fn isPinned\([^}]+}/.exec(pipeline[0].wgsl)?.[0]);

const listed = await cli('targets', ['targets', shaderPath]);
assert(listed.targets.some(t => t.label === 'privateHelper'));
assert(listed.targets.some(t => t.label === 'makeBlur.helper'));
const plain = await cli('private', ['wgsl', shaderPath, '-t', 'privateHelper']);
assert.match(plain[0].wgsl, /return 2/);
const nested = await cli('nested', ['wgsl', shaderPath, '-t', 'makeBlur.helper']);
assert.equal(nested.length, 2);
assert.deepEqual(nested.map(t => t.context.instance), [0, 1]);
assert.match(nested[0].wgsl, /return 3/);
assert.match(nested[1].wgsl, /return 7/);
const specialized = await cli('context', ['wgsl', shaderPath, '-t', 'makeBlur.helper', '--context-file', contextPath]);
assert.equal(specialized.length, 1);
assert.equal(specialized[0].context.instance, 2);
assert.match(specialized[0].wgsl, /return 11/);
await writeFile(shaderPath, invalid);
const rejected = await cli('compiler-error', ['check', shaderPath, '-t', 'privateHelper'], 1);
assert(rejected.files[0].diagnostics.some(d => d.severity === 'error' && d.message.includes('definitely_missing_symbol')));
await writeFile(shaderPath, good);
await cli('recovery', ['check', shaderPath, '-t', 'privateHelper']);
console.log('Packaged CLI: private/nested WGSL, explicit context, compiler error, recovery passed');

const child = spawn(process.execPath, [entry, '--stdio'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
const requests = new Map(), diagnostics = new Map(), shownDocuments = [];
let buffer = Buffer.alloc(0), nextId = 1, stderr = '', closing = false;
child.stderr.on('data', chunk => { stderr += chunk; });
function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}
function notify(method, params) { send({ method, params }); }
function request(method, params) {
  return new Promise((resolveRequest, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`LSP request timed out: ${method}`)); }, 30_000);
    requests.set(id, { resolve: resolveRequest, reject, timer });
    send({ id, method, params });
  });
}
child.on('exit', (code, signal) => {
  for (const pending of requests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`LSP exited ${code ?? signal}: ${stderr}`));
  }
  requests.clear();
  if (!closing) stderr += `\nUnexpected server exit: ${code ?? signal}`;
});
child.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
    assert(Number.isFinite(length), 'Invalid LSP framing');
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    if (message.method) {
      if (message.method === 'textDocument/publishDiagnostics') diagnostics.set(message.params.uri, message.params.diagnostics);
      if (message.method === 'window/showDocument') shownDocuments.push(message.params);
      if (message.id !== undefined) send({ id: message.id, result: message.method === 'window/showDocument' ? { success: true } : null });
    } else {
      const pending = requests.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer); requests.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }
});

const uri = pathToFileURL(shaderPath).href;
const doc = { uri };
async function settled(documentUri, version, selectedLabel) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await request('typegpu/targets', { textDocument: { uri: documentUri } });
    const targets = selectedLabel ? state?.targets.filter(target => target.label === selectedLabel) : state?.targets;
    if (state?.version === version && !state.stale && targets?.length && targets.every(t => ['ok', 'failed'].includes(t.status))) return state;
    await delay(100);
  }
  throw new Error(`Inspection did not finish: ${documentUri}\n${stderr}`);
}
async function saved(source, version, trigger, selectedLabel) {
  await writeFile(shaderPath, source);
  notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: source }] });
  notify('textDocument/didSave', { textDocument: doc });
  if (trigger) await trigger();
  return settled(uri, version, selectedLabel);
}
async function wgsl(state, label) {
  const target = state.targets.find(t => t.label === label);
  assert(target, `Missing ${label}: ${JSON.stringify(state)}`);
  const result = await request('typegpu/wgsl', { textDocument: doc, targetId: target.id });
  assert(result?.ok && !result.stale, JSON.stringify(result));
  return { target, result };
}
try {
  await request('initialize', {
    processId: process.pid, rootUri: pathToFileURL(project).href, capabilities: {},
    initializationOptions: { inspectOn: 'save', warmUpOnOpen: false, timeoutMs: 15_000, maxWgslBytes: 2_000_000 },
  });
  notify('initialized', {});
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text: good } });
  notify('textDocument/didSave', { textDocument: doc });
  const initial = await settled(uri, 1);
  assert.equal(initial.targets.length, 3);
  assert(initial.targets.every(t => t.status === 'ok'));
  const initialPrivate = await wgsl(initial, 'privateHelper');
  assert.equal(initialPrivate.result.wgsl, plain[0].wgsl);
  const firstClosure = await wgsl(initial, 'makeBlur.helper [instance 0]');
  const secondClosure = await wgsl(initial, 'makeBlur.helper [instance 1]');
  assert.equal(firstClosure.result.wgsl, nested[0].wgsl);
  assert.equal(secondClosure.result.wgsl, nested[1].wgsl);
  assert.equal(firstClosure.target.inputSummary, 'Captured: radius = 3');
  assert.equal(secondClosure.target.inputSummary, 'Captured: radius = 7');
  assert.equal(secondClosure.result.inputSummary, 'Captured: radius = 7');
  evidence.lsp.initial = initial;

  // Shader browsing stays in the editor protocol; clean declarations get no menu clutter.
  const symbol = initial.symbols.find(s => s.name === 'makeBlur.helper');
  const actions = await request('textDocument/codeAction', { textDocument: doc, range: symbol.range, context: { diagnostics: [] } });
  assert.deepEqual(actions, []);
  const selected = secondClosure.target;
  const context = selected.context;
  const selectedRef = {
    targetId: selected.id, label: selected.label,
    targetKey: JSON.stringify([selected.label, context?.instance, context?.usage, context?.resultPath, context?.label]),
  };
  const links = await request('textDocument/documentLink', { textDocument: doc });
  const generatedUri = links.find(link => link.tooltip === `Open generated WGSL for ${selected.label}`).target;
  assert.match(await readFile(new URL(generatedUri), 'utf8'), /return 7/);
  const hover = await request('textDocument/hover', { textDocument: doc, position: symbol.range.start });
  assert(!hover.contents.value.includes('All shaders'));
  assert(hover.contents.value.includes('Instance 0') && hover.contents.value.includes('Instance 1'));
  assert.equal((hover.contents.value.match(/```wgsl/g) ?? []).length, 2);
  assert(hover.contents.value.includes('return 3') && hover.contents.value.includes('return 7'));
  assert(hover.contents.value.includes('Captured: radius = 3') && hover.contents.value.includes('Captured: radius = 7'));
  assert(hover.contents.value.includes(`[Open WGSL](<${generatedUri}>)`));

  const shifted = '// offset changed above nested declaration\n' + good;
  notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: shifted }] });
  const stale = await request('typegpu/wgsl', { textDocument: doc, ...selectedRef });
  assert(stale.ok && stale.stale && stale.sourceVersion === 1);
  assert.match(stale.wgsl, /return 7/);
  notify('workspace/didChangeConfiguration', { settings: { inspectOn: 'hover' } });
  const moved = await saved(shifted, 3, () => request('typegpu/wgsl', { textDocument: doc, ...selectedRef }), selectedRef.label);
  notify('workspace/didChangeConfiguration', { settings: { inspectOn: 'save' } });
  const movedShader = await request('typegpu/wgsl', { textDocument: doc, ...selectedRef });
  assert(movedShader.ok && !movedShader.stale && movedShader.sourceVersion === 3);
  assert.match(movedShader.wgsl, /return 7/);
  const movedLinks = await request('textDocument/documentLink', { textDocument: doc });
  assert.equal(movedLinks.find(link => link.tooltip === `Open generated WGSL for ${selected.label}`).target, generatedUri);


  const nestedError = shifted.replace(
    "tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(radius); })",
    'tgpu.fn([], d.f32)`() -> f32 { return definitely_missing_symbol; }`',
  );
  await saved(nestedError, 4);
  const selectedError = await request('typegpu/wgsl', { textDocument: doc, ...selectedRef });
  assert(selectedError.ok && selectedError.outcome === 'failed');
  assert(selectedError.messages.some(message => message.type === 'error' && message.range));
  assert((diagnostics.get(generatedUri) ?? []).some(diagnostic => diagnostic.severity === 1));
  const errorActions = await request('textDocument/codeAction', {
    textDocument: doc, range: symbol.range, context: { diagnostics: diagnostics.get(uri) ?? [] },
  });
  assert(errorActions.length && errorActions.every(action => action.command.command === 'typegpuInspector.openGeneratedWgsl'));
  await request('workspace/executeCommand', errorActions[0].command);
  assert(shownDocuments.at(-1).selection, 'Compiler action navigates to the generated error range');

  await saved(shifted, 5);
  assert.equal((diagnostics.get(generatedUri) ?? []).length, 0);
  assert.match(await readFile(new URL(generatedUri), 'utf8'), /return 7/);

  assert.match((await request('typegpu/wgsl', { textDocument: doc, ...selectedRef })).wgsl, /return 7/);
  evidence.lsp.specializationWorkflow = { selectedRef, generatedUri, stale, moved, selectedError };

  notify('workspace/didChangeConfiguration', { settings: { contextFile: contextPath } });
  const configured = await saved(good + '\n', 6);
  const contextShader = await wgsl(configured, 'makeBlur.helper');
  assert.equal(contextShader.result.wgsl, specialized[0].wgsl);
  const report = await request('typegpu/report', { textDocument: doc, targetId: contextShader.target.id });
  assert(report.ok && report.markdown.includes('radius 11') && report.markdown.includes('closure instance 2'));
  evidence.lsp.context = { targets: configured, wgsl: contextShader.result, report };

  const failed = await saved(invalid, 7);
  const errorShader = await wgsl(failed, 'privateHelper');
  assert.equal(errorShader.target.status, 'failed');
  assert(errorShader.result.messages.some(m => m.type === 'error' && m.message.includes('definitely_missing_symbol') && m.range));
  assert((diagnostics.get(uri) ?? []).some(d => d.severity === 1 && d.message.includes('definitely_missing_symbol')));
  evidence.lsp.compilerError = { wgsl: errorShader.result, diagnostics: diagnostics.get(uri) };

  const recovered = await saved(good, 8);
  assert(recovered.targets.every(t => t.status === 'ok'));
  assert.equal((await wgsl(recovered, 'privateHelper')).result.wgsl, plain[0].wgsl);
  assert(!(diagnostics.get(uri) ?? []).some(d => d.severity === 1));
  evidence.lsp.compilerRecovery = recovered;

  const brokenUri = pathToFileURL(brokenPath).href;
  notify('textDocument/didOpen', { textDocument: { uri: brokenUri, languageId: 'typescript', version: 1, text: brokenSource } });
  notify('textDocument/didSave', { textDocument: { uri: brokenUri } });
  const broken = await settled(brokenUri, 1);
  assert.equal(broken.targets[0].status, 'failed');
  const failure = await request('typegpu/report', { textDocument: { uri: brokenUri }, targetId: broken.targets[0].id });
  assert(JSON.stringify(failure).includes('release-broken'), JSON.stringify(failure));
  const afterDependencyFailure = await saved(good + '\n', 9);
  assert(afterDependencyFailure.targets.every(t => t.status === 'ok'));
  assert.equal((await wgsl(afterDependencyFailure, 'privateHelper')).result.wgsl, plain[0].wgsl);
  evidence.lsp.dependencyRecovery = { failure, recovered: afterDependencyFailure };
  console.log('Packaged LSP: WGSL parity, context refresh, compiler diagnostics, same-process recovery passed');
  evidence.ok = true;
} finally {
  closing = true;
  try { await request('shutdown', null); notify('exit'); }
  finally {
    if (child.exitCode === null) child.kill();
    await writeFile(join(output, 'lsp-stderr.log'), stderr);
    await writeFile(join(output, 'release-smoke.json'), JSON.stringify(evidence, null, 2));
  }
}
