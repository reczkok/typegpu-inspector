import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveInspectorLaunch, resolveNpmInvocation } from '../src/mcpInspector.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.TYPEGPU_INSPECTOR_RUNTIME_DIR;
  delete process.env.TYPEGPU_INSPECTOR_NODE;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe('runtime inspector launch', () => {
  it('launches a version-matched VS Code runtime directly without npx', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'typegpu-runtime-launch-'));
    temporaryDirectories.push(runtimeDir);
    const packageRoot = join(
      runtimeDir,
      'node_modules',
      'typegpu-runtime-inspector-mcp',
    );
    const bin = join(packageRoot, 'bin', 'typegpu-runtime-inspector-mcp.mjs');
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: 'typegpu-runtime-inspector-mcp',
        // Must match the build-time define, or the launcher treats the
        // installed runtime as stale and reinstalls it.
        version: __TYPEGPU_INSPECTOR_VERSION__,
      }),
    );
    await writeFile(bin, '#!/usr/bin/env node\n');
    process.env.TYPEGPU_INSPECTOR_RUNTIME_DIR = runtimeDir;

    const launch = await resolveInspectorLaunch('bundled');

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([bin]);
    expect(launch.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

async function makeExecutable(directory: string, name: string): Promise<string> {
  const file = join(directory, name);
  await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('npm resolution for the runtime install', () => {
  it('prefers an npm executable found on the launch PATH', async () => {
    const binDirectory = await temporaryDirectory('typegpu-npm-path-');
    const npm = await makeExecutable(binDirectory, 'npm');

    const invocation = resolveNpmInvocation({ PATH: binDirectory }, 'linux');

    expect(invocation.command).toBe(npm);
    expect(invocation.args).toEqual([]);
    expect(invocation.shell).toBe(false);
    expect(invocation.source).toContain(npm);
  });

  it('falls back to npm-cli.js beside the node on PATH', async () => {
    const prefix = await temporaryDirectory('typegpu-npm-prefix-');
    const binDirectory = join(prefix, 'bin');
    await mkdir(binDirectory, { recursive: true });
    const node = await makeExecutable(binDirectory, 'node');
    const cliDirectory = join(prefix, 'lib', 'node_modules', 'npm', 'bin');
    await mkdir(cliDirectory, { recursive: true });
    const cli = join(cliDirectory, 'npm-cli.js');
    await writeFile(cli, '// npm\n');

    const invocation = resolveNpmInvocation({ PATH: binDirectory }, 'linux');

    expect(invocation.command).toBe(node);
    expect(invocation.args).toEqual([cli]);
    expect(invocation.source).toContain('npm-cli.js');
  });

  it('uses TYPEGPU_INSPECTOR_NODE when PATH has neither npm nor node', async () => {
    const prefix = await temporaryDirectory('typegpu-npm-configured-');
    const binDirectory = join(prefix, 'bin');
    await mkdir(binDirectory, { recursive: true });
    const node = await makeExecutable(binDirectory, 'node');
    const cliDirectory = join(prefix, 'lib', 'node_modules', 'npm', 'bin');
    await mkdir(cliDirectory, { recursive: true });
    await writeFile(join(cliDirectory, 'npm-cli.js'), '// npm\n');
    const emptyDirectory = await temporaryDirectory('typegpu-npm-empty-');

    const invocation = resolveNpmInvocation(
      { PATH: emptyDirectory, TYPEGPU_INSPECTOR_NODE: node },
      'linux',
    );

    expect(invocation.command).toBe(node);
    expect(invocation.args).toEqual([join(cliDirectory, 'npm-cli.js')]);
  });

  it('reads the Windows npm-cli.js layout beside node.exe', async () => {
    const prefix = await temporaryDirectory('typegpu-npm-win-');
    const node = join(prefix, 'node.exe');
    await writeFile(node, 'binary');
    const cliDirectory = join(prefix, 'node_modules', 'npm', 'bin');
    await mkdir(cliDirectory, { recursive: true });
    await writeFile(join(cliDirectory, 'npm-cli.js'), '// npm\n');

    const invocation = resolveNpmInvocation({ Path: prefix }, 'win32');

    expect(invocation.command).toBe(node);
    expect(invocation.args).toEqual([join(cliDirectory, 'npm-cli.js')]);
  });

  it('names what it searched and points at the doctor when npm is missing', async () => {
    const emptyDirectory = await temporaryDirectory('typegpu-npm-missing-');

    expect(() => resolveNpmInvocation({ PATH: emptyDirectory }, 'linux'))
      .toThrowError(/npm on PATH.*node on PATH.*Environment Doctor/s);
  });
});
