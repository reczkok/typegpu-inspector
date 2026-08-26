import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveInspectorLaunch } from '../src/mcpInspector.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.TYPEGPU_INSPECTOR_RUNTIME_DIR;
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
      JSON.stringify({ name: 'typegpu-runtime-inspector-mcp', version: '0.4.7' }),
    );
    await writeFile(bin, '#!/usr/bin/env node\n');
    process.env.TYPEGPU_INSPECTOR_RUNTIME_DIR = runtimeDir;

    const launch = await resolveInspectorLaunch('bundled');

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([bin]);
    expect(launch.env?.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
