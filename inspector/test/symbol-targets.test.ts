import { describe, expect, it } from 'vitest';
import { prepareSymbolTargets } from '../src/browser/symbolTargets.ts';
import { registerInstance } from '../src/browser/symbolRegistry.ts';
import { readSelector } from '../src/browser/symbolRuntime.ts';

class Root {
  constructor(readonly bindings: unknown[][] = []) {}
  with(slot: unknown, value: unknown) { return new Root([...this.bindings, [slot, value]]); }
  createComputePipeline(descriptor: unknown) { return { descriptor, bindings: this.bindings }; }
  createRenderPipeline(descriptor: unknown) { return { descriptor, bindings: this.bindings }; }
}
function environment(inspectedModule: Record<string, unknown> = {}) {
  return { modulePath: '/runtime-plan.ts', sourceRevision: 'revision', inspectedModule,
    roots: { ctx: { d: { f32: 'schema' } }, setup: { amount: 19 } },
    ctx: { root: new Root(), tgpu: { vertexLayout: () => ({ attrib: {} }) }, d: { arrayOf: () => [] } },
  };
}

describe('symbol target preparation', () => {
  it('isolates selector errors and preserves inferred versus explicit kinds', () => {
    const value = {};
    const targets = prepareSymbolTargets([
      { selector: 'missing', label: 'inferred' },
      { selector: 'missing', label: 'explicit', kind: 'compute-pipeline' },
      { selector: 'existing', label: 'existing' },
    ], [], environment({ existing: value }));
    expect(targets[0]?.error).toBeInstanceOf(Error);
    expect(targets[0]?.kind).toBeUndefined();
    expect(targets[1]?.kind).toBe('compute-pipeline');
    expect(targets[2]?.value).toBe(value);
    expect(targets.every(t => t.context?.sourceRevision === 'revision')).toBe(true);
  });

  it('retains context and sibling instances when one probe fails', () => {
    registerInstance('/runtime-plan.ts', 123, 'first', () => ({ local: 3 }));
    registerInstance('/runtime-plan.ts', 123, 'second', () => ({ local: 7 }));
    const slot = {};
    const targets = prepareSymbolTargets([
      { selector: 'factory.helper', label: 'factory.helper', declaration: 123,
        context: { label: 'chosen setup', with: [{ slot: 'slot', value: 'setup.amount' }] } },
    ], [(value, module, roots) => {
      expect(readSelector(module, 'ctx.d.f32', 'schema', roots)).toBe('schema');
      if (value === 'first') throw new Error('Bad first shader');
      return { value: readSelector(module, 'local', 'capture', roots) };
    }], environment({ slot }));
    expect(targets[0]).toMatchObject({ error: new Error('Bad first shader'), context: { instance: 0, label: 'chosen setup' } });
    expect(targets[1]).toMatchObject({ label: 'factory.helper [instance 1]', parentLabel: 'factory.helper',
      value: 7, autoBind: false, context: { instance: 1 }, bindings: [[slot, 19]],
    });
  });

  it('prepares deferred pipelines with attribute selectors and explicit bindings', () => {
    const slot = {}, vertex = {}, fragment = {}, attrib = {};
    const [target] = prepareSymbolTargets([
      { label: 'pipeline', kind: 'render-pipeline', vertex: 'vertex', fragment: 'fragment',
        attribs: { color: 'attrib' }, descriptor: { targets: [{ format: 'rgba8unorm' }] },
        with: [{ slot: 'slot', value: 'setup.amount' }], synthesizeMissing: false },
    ], [], environment({ slot, vertex, fragment, attrib }));
    const pipeline = target!.create!() as ReturnType<Root['createRenderPipeline']>;
    expect(pipeline.descriptor).toEqual({ vertex, fragment, attribs: { color: attrib }, targets: [{ format: 'rgba8unorm' }] });
    expect(pipeline.bindings).toEqual([[slot, 19]]);
    expect(target!.recreate!([[vertex, 7]])).toMatchObject({ bindings: [[slot, 19], [vertex, 7]] });
  });
});
