import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeDependencyFailure,
  findImportChain,
  isDependencyOptimizationError,
  summarizeDependencyFailure,
} from '../src/inspect/optimizerFailure.ts';

const ESC = '\u001b';
const ROLLDOWN_REPORT = [
  'Error during dependency optimization:',
  '',
  'Build failed with 1 error:',
  '',
  `${ESC}[31m[PARSE_ERROR] ${ESC}[0mFlow is not supported`,
  `   ${ESC}[38;5;246m╭${ESC}[0m${ESC}[38;5;246m─${ESC}[0m${ESC}[38;5;246m[${ESC}[0m node_modules/.pnpm/react-native@0.86.2_@babel+core@7.29.7/node_modules/react-native/index.js:1:1 ${ESC}[38;5;246m]${ESC}[0m`,
  `   ${ESC}[38;5;246m│${ESC}[0m`,
  ` ${ESC}[38;5;246m1 │${ESC}[0m ╭─▶ /**`,
].join('\n');

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'typegpu-optimizer-'));
  temporary.push(root);
  const pkg = async (name: string, dependencies: Record<string, string> = {}) => {
    const dir = join(root, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }));
  };
  await pkg('react-native');
  await pkg('react-native-webgpu', { 'react-native': '*' });
  await pkg('wgpu-matrix');
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

describe('dependency optimization failures', () => {
  it('recognizes the optimizer prefix', () => {
    expect(isDependencyOptimizationError(new Error(ROLLDOWN_REPORT))).toBe(true);
    expect(isDependencyOptimizationError(new Error('Flow is not supported'))).toBe(false);
  });

  it('reads the reason and the failing package out of the colored report', () => {
    expect(summarizeDependencyFailure(ROLLDOWN_REPORT)).toEqual({
      reason: 'Flow is not supported',
      packageName: 'react-native',
      file: 'node_modules/react-native/index.js',
    });
  });

  it('handles scoped packages and reports without a code', () => {
    expect(summarizeDependencyFailure(
      'Error during dependency optimization:\n\nCould not resolve "fs" in node_modules/@scope/pkg/lib/io.js',
    )).toEqual({
      reason: 'Could not resolve "fs" in node_modules/@scope/pkg/lib/io.js',
      packageName: '@scope/pkg',
      file: 'node_modules/@scope/pkg/lib/io.js',
    });
  });

  it('finds the runtime import whose package depends on the failing one', async () => {
    const root = await project();
    const modulePath = join(root, 'src', 'water.ts');
    const source = [
      "import type { RNCanvasContext } from 'react-native-webgpu';",
      "import { mat4 } from 'wgpu-matrix';",
      "import { requestAnimationFrame } from 'react-native-webgpu';",
    ].join('\n');
    expect(findImportChain(modulePath, source, 'react-native')).toEqual({
      line: 3,
      packages: ['react-native-webgpu', 'react-native'],
    });
    expect(findImportChain(modulePath, source, 'three')).toBeUndefined();
  });

  it('describes the failure with the import chain and a way out', async () => {
    const root = await project();
    const path = join(root, 'src', 'water.ts');
    const source = "import { x } from 'react-native-webgpu';\n";
    const message = describeDependencyFailure(new Error(ROLLDOWN_REPORT), { path, source, cwd: root });
    expect(message).toBe(
      'Dependency optimization failed: Flow is not supported (node_modules/react-native/index.js). ' +
        "src/water.ts:1 imports 'react-native-webgpu', which depends on 'react-native'. " +
        'The inspector runs the module in a browser build, so this package cannot be imported at runtime; make the import type-only or keep it out of shader modules.',
    );
  });

  it('still names the failure when no import explains it', async () => {
    const root = await project();
    const message = describeDependencyFailure(new Error(ROLLDOWN_REPORT), {
      path: join(root, 'src', 'clean.ts'),
      source: "import { mat4 } from 'wgpu-matrix';\n",
      cwd: root,
    });
    expect(message).toContain('Dependency optimization failed: Flow is not supported');
    expect(message).not.toContain('imports');
  });
});
