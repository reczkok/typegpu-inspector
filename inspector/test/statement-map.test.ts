import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import typegpuPlugin from 'unplugin-typegpu/esbuild';
import { tgpu } from 'typegpu';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildStatementMap,
  createStatementMapGenerator,
  currentRecorderSequence,
  findLatestRecordedFailure,
  findStatementMapForCode,
  isStatementMapSupported,
  type StatementMapRecorder,
} from '../src/browser/statementMap.ts';
import { resolveTypegpuInternalPath } from '../src/inspect/paths.ts';
import type { StatementMap, StatementPathSegment } from '../src/types.ts';

const require = createRequire(import.meta.url);
const fixturePath = resolve(import.meta.dirname, 'fixtures/statement-map.ts');

/** Bundles the fixture through unplugin-typegpu so its functions carry tinyest metadata. */
async function loadFixture(): Promise<Record<string, unknown>> {
  const result = await esbuild.build({
    entryPoints: [fixturePath],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      typegpuPlugin({}),
      {
        name: 'typegpu-shared-instance',
        setup(build) {
          build.onResolve({ filter: /^typegpu(\/.*)?$/ }, (args) => ({
            path: pathToFileURL(require.resolve(args.path)).href,
            external: true,
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0]!.text;
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

function resolveWithRecorder(value: unknown): {
  code: string;
  recorder: StatementMapRecorder;
  map: StatementMap | undefined;
} {
  const recording = createStatementMapGenerator();
  if (!recording) throw new Error('statement map generator unavailable');
  const { code } = tgpu.resolveWithContext([value as never], {
    names: 'strict',
    unstable_shaderGenerator: recording.generator,
  });
  return { code, recorder: recording.recorder, map: buildStatementMap(recording.recorder, code) };
}

function entryLine(map: StatementMap, fn: string, path: StatementPathSegment[]) {
  const entry = map.functions
    .find((candidate) => candidate.name === fn)
    ?.statements.find((candidate) => candidate.path.join('.') === path.join('.'));
  if (!entry) throw new Error(`no entry ${fn} ${path.join('.')}`);
  return entry;
}

describe('statement map recorder', () => {
  let fixture: Record<string, unknown>;

  beforeAll(async () => {
    fixture = await loadFixture();
  });

  it('is supported by the bundled TypeGPU', () => {
    expect(isStatementMapSupported()).toBe(true);
  });

  it('records every statement of every function with its absolute WGSL line', () => {
    const { code, map } = resolveWithRecorder(fixture.mainCompute);
    expect(map).toBeDefined();
    const lines = code.split('\n');
    const lineOf = (fn: string, path: StatementPathSegment[]) =>
      lines[entryLine(map!, fn, path).line]!.trim();

    expect(map!.functions.map((fn) => fn.name)).toEqual(['rotateXY', 'stepBoid', 'mainCompute']);
    for (const fn of map!.functions) {
      expect(lines[fn.line]).toMatch(new RegExp(`fn ${fn.name}\\(`));
    }

    expect(lineOf('rotateXY', [0])).toBe('let s = sin(angle);');
    expect(lineOf('rotateXY', [2])).toMatch(/^return vec3f\(/);
    expect(lineOf('stepBoid', [1])).toMatch(/^var pos = /);
    expect(lineOf('stepBoid', [3])).toMatch(/^for \(var i = 0; \(i < 4i\); i\+\+\) \{$/);
    expect(lineOf('stepBoid', [3, 'init'])).toMatch(/^for \(var i = 0;/);
    expect(lineOf('stepBoid', [3, 'body', 0])).toMatch(/^if \(\(length\(vel\) > 2f\)\) \{$/);
    expect(lineOf('stepBoid', [3, 'body', 0, 'then', 0])).toBe('vel = (normalize(vel) * 2f);');
    expect(lineOf('stepBoid', [3, 'body', 0, 'else'])).toMatch(/^if \(\(i > 2i\)\) \{$/);
    expect(lineOf('stepBoid', [3, 'body', 0, 'else', 'then', 0])).toMatch(/^vel = \(vel \+ vec3f\(/);
    expect(lineOf('stepBoid', [3, 'body', 1])).toBe('pos = (pos + (vel * 0.016f));');
    expect(lineOf('stepBoid', [4])).toMatch(/^let bounded = select\(/);
    expect(lineOf('stepBoid', [6])).toBe('boids[index].vel = (vel * 1f);');
    expect(lineOf('mainCompute', [0])).toBe('if ((gid.x >= 64u)) {');
    expect(lineOf('mainCompute', [0, 'then', 0])).toBe('return;');
    expect(lineOf('mainCompute', [1])).toBe('stepBoid(gid.x);');

    const forEntry = entryLine(map!, 'stepBoid', [3]);
    expect(lines[forEntry.line + forEntry.lineCount - 1]!.trim()).toBe('}');
    expect(map!.failure).toBeUndefined();
  });

  it('names the statement whose resolution failed, innermost function first', () => {
    const sequence = currentRecorderSequence();
    const recording = createStatementMapGenerator()!;
    expect(() =>
      tgpu.resolveWithContext([fixture.brokenCompute as never], {
        names: 'strict',
        unstable_shaderGenerator: recording.generator,
      })
    ).toThrow(/references cannot be assigned/);
    expect(recording.recorder.failure).toEqual({ fn: 'brokenHelper', path: [2] });
    expect(findLatestRecordedFailure(sequence)).toEqual({ fn: 'brokenHelper', path: [2] });
    expect(buildStatementMap(recording.recorder, '')).toMatchObject({
      functions: [],
      failure: { fn: 'brokenHelper', path: [2] },
    });
  });

  it('finds the recording behind code that TypeGPU resolved on its own', () => {
    const sequence = currentRecorderSequence();
    const { code, map } = resolveWithRecorder(fixture.stepBoid);
    expect(findStatementMapForCode(code, sequence)).toEqual(map);
    expect(findStatementMapForCode('fn unrelated() {}', sequence)).toBeUndefined();
    expect(findStatementMapForCode(code, sequence + 10)).toBeUndefined();
  });

  it('places repeated statement code by order within its parent', () => {
    const recorder: StatementMapRecorder = {
      sequence: 0,
      failure: undefined,
      functions: [{
        name: 'twice',
        bodyCode: '{\n  if (a) {\n    x = 1;\n  }\n  x = 1;\n}',
        statements: [
          { path: [0, 'then', 0], code: 'x = 1;' },
          { path: [0], code: 'if (a) {\n    x = 1;\n  }' },
          { path: [1], code: 'x = 1;' },
        ],
      }],
    };
    const code = 'struct S {}\n\nfn twice() {\n  if (a) {\n    x = 1;\n  }\n  x = 1;\n}';
    expect(buildStatementMap(recorder, code)).toEqual({
      functions: [{
        name: 'twice',
        line: 2,
        statements: [
          { path: [0], line: 3, lineCount: 3 },
          { path: [0, 'then', 0], line: 4, lineCount: 1 },
          { path: [1], line: 6, lineCount: 1 },
        ],
      }],
    });
  });

  it('refuses code that does not contain a recorded function', () => {
    const { recorder } = resolveWithRecorder(fixture.rotateXY);
    expect(buildStatementMap(recorder, 'fn rotateXY_2() {}')).toBeUndefined();
  });
});

describe('resolveTypegpuInternalPath', () => {
  it('resolves the ~internal entry of the package that owns the typegpu entry', () => {
    const typegpuPath = require.resolve('typegpu');
    const internalPath = resolveTypegpuInternalPath(typegpuPath);
    expect(internalPath).toBe(join(dirname(typegpuPath), 'internal.js'));
  });

  it('yields nothing for a package without the export or a sibling internal module', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-internal-'));
    try {
      const packageDir = join(tempDir, 'node_modules', 'typegpu');
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: 'typegpu', version: '0.11.9', exports: { '.': './index.js' } }),
      );
      await writeFile(join(packageDir, 'index.js'), 'export const tgpu = {};\n');
      expect(resolveTypegpuInternalPath(join(packageDir, 'index.js'))).toBeUndefined();
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
