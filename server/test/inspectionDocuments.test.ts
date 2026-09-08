import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverTypeGpuModule } from '../src/discovery.js';
import { describeTargets } from '../src/editorRequests.js';
import { inspectionDocumentPath, writeInspectionDocument } from '../src/inspectionDocuments.js';
import { materializeInspection } from '../src/surface.js';
import { createZedShaderHover } from '../src/zedShaderHover.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('persistent shader documents', () => {
  it('keeps unchanged files untouched and refuses a superseded revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shader-doc-test-'));
    temporary.push(directory);
    const path = join(directory, 'shader.wgsl');
    await writeInspectionDocument(path, 'current');
    const before = await stat(path);
    await writeInspectionDocument(path, 'current');
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    let current = true;
    const pending = writeInspectionDocument(path, 'stale', () => current);
    current = false;
    await pending;
    expect(await readFile(path, 'utf8')).toBe('current');
    expect(await readdir(directory)).toEqual(['shader.wgsl']);
  });

  it('distinguishes sanitized labels and contexts without incorporating source revisions', () => {
    const path = (label: string, context = {}) => inspectionDocumentPath('/project', '/project/a.ts', { label, context });
    expect(path('a/b')).not.toBe(path('a:b'));
    expect(path('helper', { instance: 0 })).not.toBe(path('helper', { instance: 1 }));
    expect(path('helper', { instance: 0, sourceRevision: 'old' })).toBe(path('helper', { instance: 0, sourceRevision: 'new' }));
  });

  it('shows both specialization bodies with separated direct links and one shared status', async () => {
    const path = '/project/specializations.ts';
    const discovered = discoverTypeGpuModule(path, `const test = <T extends d.v2f | d.v4f>(a: T) => { 'use gpu'; return a.x; };`);
    expect(discovered.targets).toHaveLength(2);
    const inspection = await materializeInspection('/project', path, 1, discovered, {
      ok: true, targets: discovered.targets.map(target => ({
        label: target.label, kind: 'resolvable', ok: true, outcome: 'passed-with-assumptions',
        wgsl: `fn dependency() {}\n\nfn test(a: ${target.label.includes('vec2f') ? 'vec2f' : 'vec4f'}) -> f32 {\n  return a.x;\n}\n\nfn item() { }`,
      })),
    });
    const snapshot = describeTargets(1, discovered, inspection, new Set());
    const hover = createZedShaderHover('test', snapshot, inspection, 'standard')!;
    const text = (hover.contents as { value: string }).value;
    expect(text.match(/```wgsl/g)).toHaveLength(2);
    expect(text.match(/WGSL compiled/g)).toHaveLength(1);
    expect(text).toContain('fn test(a: vec2f)');
    expect(text).toContain('fn test(a: vec4f)');
    expect(text).not.toContain('fn dependency');
    expect(text).not.toContain('fn item');
    expect(text).toContain('```\n\n**test(vec4f)**');
    for (const artifact of inspection.targets.values()) {
      expect(text).toContain(`[Open WGSL](<${artifact.generatedUri}>)`);
    }
  });

  it('shows bounded shader hovers and unchanged compiler input', async () => {
    const modulePath = '/project/compact-hover.ts';
    const discovered = discoverTypeGpuModule(modulePath, `const shade = tgpu.fn([], d.f32)(() => 1);`);
    const wgsl = `fn shade() -> f32 {\n${'  // compiler input\n'.repeat(30)}  return 1;\n}\n`;
    const inspection = await materializeInspection('/project', modulePath, 1, discovered, {
      ok: true, targets: [{ label: 'shade', kind: 'resolvable', ok: true, outcome: 'passed-with-assumptions', wgsl }],
    });
    const snapshot = describeTargets(2, discovered, inspection, new Set());
    const hover = createZedShaderHover('shade', snapshot, inspection, 'standard')!;
    const text = (hover.contents as { value: string }).value;
    expect(text).toContain('WGSL compiled');
    expect(text).toContain('Additional inspection assumptions');
    expect(text).toContain('Previous saved result');
    expect(text).toContain('Open WGSL');
    expect(text).not.toContain('All shaders');
    expect(text.split('\n').length).toBeLessThan(24);
    expect(await readFile(new URL([...inspection.targets.values()][0]!.generatedUri!), 'utf8')).toBe(wgsl);
  });
});
