#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromRoot = createRequire(resolve(root, 'package.json'));
const tsxLoader = pathToFileURL(requireFromRoot.resolve('tsx')).href;

const child = spawn(process.execPath, ['--import', tsxLoader, resolve(root, 'src/cli.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});

function stopChild(signal = 'SIGTERM') {
  if (!child.killed && child.exitCode === null) {
    child.kill(signal);
  }
}

process.stdin.on('end', () => stopChild());
process.stdin.on('close', () => stopChild());
process.once('SIGINT', () => stopChild('SIGINT'));
process.once('SIGTERM', () => stopChild('SIGTERM'));
process.once('SIGHUP', () => stopChild('SIGHUP'));
process.once('exit', () => stopChild());

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
