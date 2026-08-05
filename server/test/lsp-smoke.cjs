const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const entry = process.argv[2];
const file = process.argv[3];
const needle = process.argv[4] ?? 'parameterizedHelper';
const expectedHoverText = process.argv.slice(5);
const text = readFileSync(file, 'utf8');
const line = text.split('\n').findIndex((value) =>
  value.includes(needle));
const uri = pathToFileURL(file).href;
const child = spawn(process.execPath, [entry, '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buffer = Buffer.alloc(0);
let diagnosticPublishes = 0;
const hoverRequestIds = new Set();
let nextHoverRequestId = 2;
let finished = false;
let latestDiagnostics = [];
const logs = [];

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function finish(ok, hover) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify({
    ok,
    diagnosticPublishes,
    hover: hover?.contents?.value?.slice(0, 1_600),
  }, null, 2)}\n`);
  send({ jsonrpc: '2.0', id: 9, method: 'shutdown', params: null });
  setTimeout(() => child.kill(), 250);
  setTimeout(() => process.exit(ok ? 0 : 1), 400);
}

child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const match = /Content-Length: (\d+)/i.exec(
      buffer.subarray(0, headerEnd).toString(),
    );
    if (!match) throw new Error('Invalid LSP frame.');
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const message = JSON.parse(
      buffer.subarray(bodyStart, bodyStart + length).toString(),
    );
    buffer = buffer.subarray(bodyStart + length);

    if (message.id === 1) {
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId: 'typescript',
            version: 1,
            text,
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'textDocument/didSave',
        params: { textDocument: { uri } },
      });
    }

    if (message.method === 'textDocument/publishDiagnostics') {
      diagnosticPublishes++;
      latestDiagnostics = message.params?.diagnostics ?? [];
    }

    if (message.method === 'window/logMessage') {
      logs.push(message.params?.message);
    }

    if (message.method === 'workspace/inlayHint/refresh') {
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: null });
      }
      const hoverRequestId = nextHoverRequestId++;
      hoverRequestIds.add(hoverRequestId);
      send({
        jsonrpc: '2.0',
        id: hoverRequestId,
        method: 'textDocument/hover',
        params: {
          textDocument: { uri },
          position: { line, character: 20 },
        },
      });
    }

    if (hoverRequestIds.has(message.id) && message.method === undefined) {
      hoverRequestIds.delete(message.id);
      // Strip zero-width soft-wrap chars so needles match the visible text.
      const value = (message.result?.contents?.value ?? '')
        .replace(/\u200B/g, '');
      if (value.includes('Inspecting this target')) {
        continue;
      }
      if (!message.result) {
        process.stdout.write(`${JSON.stringify({ latestDiagnostics, logs }, null, 2)}\n`);
      }
      finish(
        expectedHoverText.length > 0
          ? expectedHoverText.every((expected) => value.includes(expected))
          : value.includes('inspection-defaults-applied') &&
            value.includes('zero-argument tgpu.fn'),
        message.result,
      );
    }
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    processId: process.pid,
    rootUri: pathToFileURL(process.cwd()).href,
    capabilities: {},
    initializationOptions: {
      inspectOn: 'save',
      timeoutMs: 45_000,
      maxWgslBytes: 2_000_000,
    },
  },
});

setTimeout(() => finish(false), 65_000);
