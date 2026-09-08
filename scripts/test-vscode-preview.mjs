// Isolated extension-host test using an installed VS Code. No user settings or extensions are modified.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const { build } = createRequire(join(root, 'server/package.json'))('esbuild');
const parent = join(root, '.local/editor-remaster');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'vscode-'));
const userData = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'tgpu-vscode-'));
await writeFile(join(directory, 'user-data-path.txt'), userData);
await mkdir(join(userData, 'User'));
await writeFile(join(userData, 'User/settings.json'), JSON.stringify({ 'chat.disableAIFeatures': true, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none' }));
const extension = join(directory, 'extension'), workspace = join(directory, 'workspace');
await mkdir(extension); await mkdir(workspace);
await writeFile(join(extension, 'package.json'), JSON.stringify({ name: 'typegpu-preview-tests', publisher: 'local', version: '0.0.0', engines: { vscode: '^1.90.0' } }));
const tests = join(extension, 'tests.cjs');
await build({ entryPoints: [join(root, 'editors/vscode/test/preview-host.ts')], outfile: tests, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'] });
console.log(`VS Code test evidence: ${directory}`);
const executable = process.env.VSCODE_EXECUTABLE ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : 'code');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [
  '--new-window', '--disable-gpu', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  `--user-data-dir=${userData}`, `--extensions-dir=${join(directory, 'extensions')}`,
  `--extensionDevelopmentPath=${extension}`, `--extensionTestsPath=${tests}`, resolve(workspace),
], { stdio: 'inherit', env, detached: process.platform !== 'win32' });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
  else child.kill();
}, 90_000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', async code => {
  clearTimeout(timer);
  try {
    const result = JSON.parse(await readFile(join(workspace, 'preview-host-result.json'), 'utf8'));
    if (timedOut || code !== 0 || result.ok !== true) throw new Error('VS Code preview tests did not complete successfully.');
    console.log('VS Code preview tests passed:', result.checks.join(', '));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
