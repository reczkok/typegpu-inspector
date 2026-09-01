import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSourceFiles } from '../src/cliFiles.js';

/**
 * repo/               .git, .gitignore: *.generated.ts
 *   app/              .gitignore: scratch/
 *     main.ts
 *     main.generated.ts
 *     scratch/try.ts
 *     legacy/old.ts
 *     nested/         .gitignore: keep-out.ts
 *       keep-out.ts
 *       fine.ts
 */
async function repository(): Promise<{ root: string; app: string }> {
  const root = await mkdtemp(join(tmpdir(), 'typegpu-files-'));
  const app = join(root, 'app');
  await mkdir(join(root, '.git'));
  await mkdir(join(app, 'scratch'), { recursive: true });
  await mkdir(join(app, 'legacy'));
  await mkdir(join(app, 'nested'));
  await writeFile(join(root, '.gitignore'), '*.generated.ts\n');
  await writeFile(join(app, '.gitignore'), 'scratch/\n');
  await writeFile(join(app, 'nested', '.gitignore'), 'keep-out.ts\n');
  for (const file of ['main.ts', 'main.generated.ts', 'scratch/try.ts', 'legacy/old.ts', 'nested/keep-out.ts', 'nested/fine.ts']) {
    await writeFile(join(app, file), 'export {};\n');
  }
  return { root, app };
}

function names(files: readonly string[], base: string): string[] {
  return files.map((file) => relative(base, file));
}

describe('source file collection', () => {
  it('honors .gitignore files above, in, and below the walked directory', async () => {
    const { app } = await repository();
    const collected = await collectSourceFiles(['.'], app);
    expect(names(collected.files, app)).toEqual(['legacy/old.ts', 'main.ts', 'nested/fine.ts']);
  });

  it('applies the same rules when walking from the repository root', async () => {
    const { root } = await repository();
    const collected = await collectSourceFiles(['app'], root);
    expect(names(collected.files, root)).toEqual(['app/legacy/old.ts', 'app/main.ts', 'app/nested/fine.ts']);
  });

  it('keeps ignored files that are named directly and can skip .gitignore entirely', async () => {
    const { app } = await repository();
    const direct = await collectSourceFiles(['main.generated.ts'], app);
    expect(names(direct.files, app)).toEqual(['main.generated.ts']);

    const everything = await collectSourceFiles(['.'], app, { gitignore: false });
    expect(names(everything.files, app)).toEqual([
      'legacy/old.ts',
      'main.generated.ts',
      'main.ts',
      'nested/fine.ts',
      'nested/keep-out.ts',
      'scratch/try.ts',
    ]);
  });

  it('skips --ignore globs relative to the working directory', async () => {
    const { app } = await repository();
    const collected = await collectSourceFiles(['.'], app, { ignore: ['legacy/**', '**/fine.ts'] });
    expect(names(collected.files, app)).toEqual(['main.ts']);
  });
});
