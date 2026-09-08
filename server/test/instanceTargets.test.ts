import { describe, expect, it } from 'vitest';
import { discoverTypeGpuModule } from '../src/discovery.js';
import { expandInstanceTargets } from '../src/instanceTargets.js';
import { coveredTargets } from '../src/mcpInspector.js';
import type { InspectorTargetReport } from '../src/protocol.js';
import { materializeInspection, mergeDocumentInspections } from '../src/surface.js';

describe('nested shader contexts', () => {
  const source = `function factory(radius: number) {
    const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(radius); });
  }
  factory(3); factory(7);`;

  it('uses the original binding offset and maps all instances back to the same declaration', () => {
    const discovered = discoverTypeGpuModule('/shaders.ts', source);
    const target = discovered.targets[0]!;
    expect(target.selector).toMatchObject({ selector: 'factory.helper', declaration: source.indexOf('helper =') });
    const reports: InspectorTargetReport[] = [0, 1].map(instance => ({
      label: `${target.label} [instance ${instance}]`, parentLabel: target.label,
      context: { instance }, kind: 'resolvable', ok: true,
    }));
    expect(coveredTargets({ ok: true, targets: reports }, [target])).toEqual(new Set([target.label]));
    const ids = expandInstanceTargets(discovered, reports, [target.id]);
    expect(ids).toHaveLength(2);
    expect(discovered.symbols[0]!.targetIds).toEqual(ids);
    expect(discovered.targets.map(t => t.label)).toEqual(reports.map(r => r.label));
    expect(discovered.targets.map(t => 'selector' in t.selector && t.selector.instance)).toEqual([0, 1]);
    expect(expandInstanceTargets(discovered, reports, ids)).toEqual(ids); // No recursive expansion on refresh.
  });

  it('expands top-level usage contexts and preserves both selection axes for nested ones', () => {
    for (const text of [source, "const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return 1; });"]) {
      const discovered = discoverTypeGpuModule('/shaders.ts', text);
      const target = discovered.targets[0]!;
      const nested = 'selector' in target.selector && target.selector.declaration !== undefined;
      const reports: InspectorTargetReport[] = [1, 3].map(usage => ({ label: `${target.label} [usage ${usage}]`, parentLabel: target.label,
        context: { usage, ...(nested ? { instance: 0 } : {}) }, kind: 'resolvable', ok: true }));
      const ids = expandInstanceTargets(discovered, reports, [target.id]);
      expect(ids).toHaveLength(2);
      expect(discovered.targets.map(t => 'selector' in t.selector && t.selector.usage)).toEqual([1, 3]);
      expect(expandInstanceTargets(discovered, reports, ids)).toEqual(ids);
    }
  });

  it('keeps runtime member paths addressable and attaches observed pipeline stages', () => {
    const discovered = discoverTypeGpuModule('/shaders.ts', `const compute = tgpu.computeFn({ workgroupSize: [1] })(impl);
      function make() { return root.createComputePipeline({ compute }); } const bundle = make();`);
    const target = discovered.targets.find(target => target.id === 'factory-result:bundle')!;
    const report = { label: target.label, parentLabel: target.label, kind: 'compute-pipeline', ok: true,
      context: { resultPath: [], pipelineStages: ['compute'] } };
    const ids = expandInstanceTargets(discovered, [report], [target.id]);
    expect(ids).toEqual(['factory-result:bundle:member:[]']);
    expect(discovered.symbols.find(symbol => symbol.name === 'compute')?.targetIds).toContain(ids[0]);
    expect(discovered.targets.find(target => target.id === ids[0])?.selector).toMatchObject({ selector: 'bundle', member: [], kind: 'compute-pipeline' });
    expect(expandInstanceTargets(discovered, [report], ids)).toEqual(ids);
  });

  it('preserves a missing-instance report as a blocked declaration', () => {
    const discovered = discoverTypeGpuModule('/shaders.ts', source);
    const target = discovered.targets[0]!;
    const ids = expandInstanceTargets(discovered, [{ label: target.label, kind: 'resolvable', ok: false, outcome: 'blocked' }]);
    expect(ids).toEqual([target.id]);
    expect(discovered.targets).toHaveLength(1);
  });

  it('replaces old instances and summary counts when a declaration is checked again', async () => {
    const discovered = discoverTypeGpuModule('/shaders.ts', source);
    const target = discovered.targets[0]!;
    const reports = [0, 1].map(instance => ({ label: `${target.label} [instance ${instance}]`,
      parentLabel: target.label, context: { instance }, kind: 'resolvable' as const, ok: true,
    }));
    const first = await materializeInspection('/workspace', '/shaders.ts', 1, discovered, { ok: true, targets: reports }, [target.id]);
    const fresh = discoverTypeGpuModule('/shaders.ts', source);
    const next = await materializeInspection('/workspace', '/shaders.ts', 1, fresh, { ok: true, targets: reports.slice(0, 1) }, [target.id]);
    const merged = mergeDocumentInspections(first, next, [target.id]);
    expect(merged.targets.size).toBe(1);
    expect(merged.output.summary?.targetCount).toBe(1);
    expect(next.unreported).toBeUndefined();
  });

  it('does not create independent runtime targets for declarations inside GPU code', () => {
    const discovered = discoverTypeGpuModule('/shaders.ts', `const outer = () => {
      'use gpu'; const inner = () => { 'use gpu'; return 2; }; return inner();
    };`);
    expect(discovered.symbols.map(s => s.name)).toEqual(['outer']);
    expect(discovered.targets.every(t => !('selector' in t.selector) || t.selector.declaration === undefined)).toBe(true);
  });

  it('distinguishes same-named declarations in sibling lexical blocks', () => {
    const discovered = discoverTypeGpuModule('/shaders.ts', `function factory() {
      { const helper = () => { 'use gpu'; return 1; }; }
      { const helper = () => { 'use gpu'; return 2; }; }
    }`);
    expect(discovered.targets).toHaveLength(2);
    expect(new Set(discovered.targets.map(t => t.label)).size).toBe(2);
    expect(discovered.targets.every(t => t.label.startsWith('factory.helper@'))).toBe(true);
  });
});
