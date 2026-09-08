import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInspectionFixture } from '../src/inspectionFixture.js';
import { discoverTypeGpuModule } from '../src/discovery.js';

describe('explicit inspection fixtures', () => {
  it('applies setup and one explicit context, rejecting typos and a mismatched module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typegpu-context-'));
    try {
      const file = join(dir, 'context.json');
      const module = join(dir, 'shader.ts');
      const returned = discoverTypeGpuModule(module, `function make() { return tgpu.fn([], d.f32)(() => { 'use gpu'; return 1; }); } const bundle = { key: make() };`);
      await writeFile(file, JSON.stringify({ module: './shader.ts', targets: { bundle: { member: ['odd.key', '0'], arguments: [{ schema: 'ctx.d.f32' }] } } }));
      expect((await applyInspectionFixture(file, module, returned.targets)).targets[0]?.selector).toMatchObject({ member: ['odd.key', '0'], context: { arguments: [{ schema: 'ctx.d.f32' }] } });
      const discovered = discoverTypeGpuModule(module, `function make(n: number) { const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(n); }); }`);
      const data = { module: './shader.ts', setupBody: 'module.make(3); module.make(7);', targets: {
        'make.helper': { label: 'radius 7', instance: 1, arguments: [], with: [{ slot: 'bias', value: 'setup.bias' }] },
      } };
      await writeFile(file, JSON.stringify(data));
      const result = await applyInspectionFixture(file, module, discovered.targets);
      expect(result.setupBody).toBe(data.setupBody);
      expect(result.targets[0]!.selector).toMatchObject({ instance: 1, context: { label: 'radius 7', arguments: [], with: data.targets['make.helper'].with } });
      await expect(applyInspectionFixture(file, join(dir, 'other.ts'), discovered.targets)).rejects.toThrow('module must name');
      expect((await applyInspectionFixture(file, join(dir, 'other.ts'), discovered.targets, discovered.targets, true)).setupBody).toBeUndefined();
      await writeFile(file, JSON.stringify({ ...data, targets: { 'make.helper': { usage: 2, instance: 0 } } }));
      expect((await applyInspectionFixture(file, module, discovered.targets)).targets[0]!.selector).toMatchObject({ usage: 2, instance: 0 });
      expect((await applyInspectionFixture(file, module, discovered.targets)).targets[0]!.selector).not.toHaveProperty('context');
      await writeFile(file, JSON.stringify({ ...data, targets: { 'make.helper': { usage: 2, with: [] } } }));
      await expect(applyInspectionFixture(file, module, discovered.targets)).rejects.toThrow('mutually exclusive');
      await writeFile(file, JSON.stringify({ ...data, targets: { misspelled: {} } }));
      await expect(applyInspectionFixture(file, module, discovered.targets)).rejects.toThrow('unknown target');
      await writeFile(file, JSON.stringify({ ...data, targets: { 'make.helper': { instance: -1 } } }));
      await expect(applyInspectionFixture(file, module, discovered.targets)).rejects.toThrow('nonnegative');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
