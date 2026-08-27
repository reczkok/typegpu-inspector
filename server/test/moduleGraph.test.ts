import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverTypeGpuModule } from '../src/discovery.js';
import { collectImportedShaderSymbols, resolveImport } from '../src/moduleGraph.js';

const shaderFn = (name: string) =>
  [
    "import { tgpu, d } from 'typegpu';",
    `export const ${name} = tgpu.fn([], d.f32)(() => {`,
    "  'use gpu';",
    '  return 1;',
    '});',
  ].join('\n');

describe('collectImportedShaderSymbols', () => {
  let root: string;
  const files: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        moduleResolution: 'bundler',
        paths: { '@shaders/*': ['./shaders/*'] },
      },
    }),
    'src/entry.ts': [
      "import { tgpu, d } from 'typegpu';",
      "import { helperA as a } from './helpers/a.ts';",
      "import { helperB } from './helpers/b.js';",
      "import * as lib from '@shaders/lib';",
      "import type { Only } from './helpers/types-only.ts';",
      "import { plain } from './helpers/plain.ts';",
      "import { viaBarrel as vb, starred } from './helpers/index.ts';",
      'export const main = tgpu.computeFn({ workgroupSize: [1] })(() => {',
      "  'use gpu';",
      '  a(); helperB(); lib.libFn(); vb(); starred();',
      '});',
    ].join('\n'),
    'src/helpers/a.ts': `${shaderFn('helperA')}\nimport { deep as deepFn } from './deep.ts';\n`,
    'src/helpers/index.ts': [
      "export { barrelled as viaBarrel } from './barrelled.ts';",
      "export * from './starred.ts';",
      '',
    ].join('\n'),
    'src/helpers/barrelled.ts': shaderFn('barrelled'),
    'src/helpers/starred.ts': shaderFn('starred'),
    'src/helpers/b.ts': shaderFn('helperB'),
    'src/helpers/deep.ts': shaderFn('deep'),
    'src/helpers/types-only.ts': shaderFn('typesOnly'),
    'src/helpers/plain.ts': 'export const plain = 1;\n',
    'shaders/lib.ts': shaderFn('libFn'),
    'node_modules/typegpu/package.json': JSON.stringify({ name: 'typegpu', main: 'index.js' }),
    'node_modules/typegpu/index.js': 'export const tgpu = {};\n',
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'module-graph-'));
    for (const [relative, text] of Object.entries(files)) {
      const path = join(root, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('resolves relative, extension-swapped, and path-aliased source imports only', () => {
    const entry = join(root, 'src/entry.ts');
    expect(resolveImport('./helpers/a.ts', entry)).toBe(join(root, 'src/helpers/a.ts'));
    expect(resolveImport('./helpers/b.js', entry)).toBe(join(root, 'src/helpers/b.ts'));
    expect(resolveImport('@shaders/lib', entry)).toBe(join(root, 'shaders/lib.ts'));
    expect(resolveImport('typegpu', entry)).toBeUndefined();
    expect(resolveImport('./missing.ts', entry)).toBeUndefined();
  });

  it('collects shader helpers across the import graph with the entry aliases', () => {
    const entryFile = join(root, 'src/entry.ts');
    const entry = discoverTypeGpuModule(entryFile, files['src/entry.ts']!);
    const symbols = collectImportedShaderSymbols(entryFile, entry);
    const summary = symbols
      .map((external) => ({
        name: external.symbol.name,
        uri: external.uri,
        callName: external.callName,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    expect(summary).toEqual([
      { name: 'barrelled', uri: pathToFileURL(join(root, 'src/helpers/barrelled.ts')).href, callName: 'vb' },
      { name: 'deep', uri: pathToFileURL(join(root, 'src/helpers/deep.ts')).href, callName: undefined },
      { name: 'helperA', uri: pathToFileURL(join(root, 'src/helpers/a.ts')).href, callName: 'a' },
      { name: 'helperB', uri: pathToFileURL(join(root, 'src/helpers/b.ts')).href, callName: 'helperB' },
      { name: 'libFn', uri: pathToFileURL(join(root, 'shaders/lib.ts')).href, callName: undefined },
      { name: 'starred', uri: pathToFileURL(join(root, 'src/helpers/starred.ts')).href, callName: 'starred' },
    ]);
    expect(symbols.every((external) => (external.symbol.shaderBodies?.length ?? 0) > 0)).toBe(true);
  });

  it('records the name each importing module uses, following re-exports', () => {
    const entryFile = join(root, 'src/entry.ts');
    const entry = discoverTypeGpuModule(entryFile, files['src/entry.ts']!);
    const symbols = collectImportedShaderSymbols(entryFile, entry);
    const localNames = (name: string) =>
      symbols.find((external) => external.symbol.name === name)!.localNames;
    expect(localNames('helperA')).toEqual({ [entryFile]: 'a' });
    expect(localNames('deep')).toEqual({ [join(root, 'src/helpers/a.ts')]: 'deepFn' });
    expect(localNames('barrelled')).toEqual({ [entryFile]: 'vb' });
    expect(localNames('starred')).toEqual({ [entryFile]: 'starred' });
    expect(localNames('libFn')).toEqual({});
  });

  it('prefers editor text over disk and honours the module cap', () => {
    const entryFile = join(root, 'src/entry.ts');
    const entry = discoverTypeGpuModule(entryFile, files['src/entry.ts']!);
    const edited = collectImportedShaderSymbols(entryFile, entry, {
      readText: (fileName) =>
        fileName === join(root, 'src/helpers/b.ts') ? shaderFn('helperRenamed') : undefined,
    });
    expect(edited.map((external) => external.symbol.name)).toContain('helperRenamed');
    expect(edited.map((external) => external.symbol.name)).not.toContain('helperB');

    const capped = collectImportedShaderSymbols(entryFile, entry, { maxModules: 2 });
    expect(capped.length).toBeLessThan(4);
    const shallow = collectImportedShaderSymbols(entryFile, entry, { maxDepth: 1 });
    expect(shallow.map((external) => external.symbol.name)).not.toContain('deep');
  });
});
