#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtCli = resolve(root, 'dist/cli.js');
let cliUrl;
if (existsSync(builtCli)) {
  cliUrl = pathToFileURL(builtCli).href;
} else {
  // Source checkouts stay directly runnable without requiring a build. The
  // published package always contains dist/ and avoids TSX's loader/service.
  const requireFromRoot = createRequire(resolve(root, 'package.json'));
  const tsxApi = pathToFileURL(requireFromRoot.resolve('tsx/esm/api')).href;
  const { register } = await import(tsxApi);
  register();
  cliUrl = pathToFileURL(resolve(root, 'src/cli.ts')).href;
}

const { main } = await import(cliUrl);
process.exitCode = await main();
