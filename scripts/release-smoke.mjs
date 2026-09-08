// Run against an extracted server package with the packaged runtime installed
// beside it. Uses only Node APIs: no repository source imports or MCP test client.
// Usage: node scripts/release-smoke.mjs <server.cjs> <isolated-project> <output-dir>
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
const requests = new Map(), diagnostics = new Map();
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
      if (message.id !== undefined) send({ id: message.id, result: null });
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
async function settled(documentUri, version) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await request('typegpu/targets', { textDocument: { uri: documentUri } });
    if (state?.version === version && !state.stale && state.targets.length && state.targets.every(t => ['ok', 'failed'].includes(t.status))) return state;
    await delay(100);
  }
  throw new Error(`Inspection did not finish: ${documentUri}\n${stderr}`);
}
async function saved(source, version) {
  await writeFile(shaderPath, source);
  notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: source }] });
  notify('textDocument/didSave', { textDocument: doc });
  return settled(uri, version);
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
  evidence.lsp.initial = initial;

  notify('workspace/didChangeConfiguration', { settings: { contextFile: contextPath } });
  const configured = await saved(good + '\n', 2);
  const contextShader = await wgsl(configured, 'makeBlur.helper');
  assert.equal(contextShader.result.wgsl, specialized[0].wgsl);
  const report = await request('typegpu/report', { textDocument: doc, targetId: contextShader.target.id });
  assert(report.ok && report.markdown.includes('radius 11') && report.markdown.includes('closure instance 2'));
  evidence.lsp.context = { targets: configured, wgsl: contextShader.result, report };

  const failed = await saved(invalid, 3);
  const errorShader = await wgsl(failed, 'privateHelper');
  assert.equal(errorShader.target.status, 'failed');
  assert(errorShader.result.messages.some(m => m.type === 'error' && m.message.includes('definitely_missing_symbol') && m.range));
  assert((diagnostics.get(uri) ?? []).some(d => d.severity === 1 && d.message.includes('definitely_missing_symbol')));
  evidence.lsp.compilerError = { wgsl: errorShader.result, diagnostics: diagnostics.get(uri) };

  const recovered = await saved(good, 4);
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
  const afterDependencyFailure = await saved(good + '\n', 5);
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
