import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { findContextSuggestions } from '../src/contextSuggestions.js';

it('finds aliases and barrel importers without executing them, excluding type-only edges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'typegpu-callers-'));
  try {
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shader': ['./barrel.ts'] } } }));
    await writeFile(join(root, 'shader.ts'), 'export const helper = 1;');
    await writeFile(join(root, 'barrel.ts'), 'export { helper as renamed } from "./shader";');
    await writeFile(join(root, 'app.ts'), 'import * as shaders from "@shader"; throw new Error("must never execute");');
    await writeFile(join(root, 'types.ts'), 'import type { helper } from "./shader";');
    const result = await findContextSuggestions(root, join(root, 'shader.ts'));
    expect(result.truncated).toBe(false);
    expect(result.candidates.map(candidate => candidate.path)).toEqual([join(root, 'app.ts'), join(root, 'barrel.ts')]);
    expect(result.candidates[0]).toMatchObject({ line: 1, kind: 'import', via: '@shader' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
