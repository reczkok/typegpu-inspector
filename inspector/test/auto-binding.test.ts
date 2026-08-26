import { describe, expect, it } from 'vitest';
import { tgpu, d } from 'typegpu';
import {
  collectBindingSources,
  createProviderChain,
  satisfyRequirement,
} from '../src/browser/engine/providers.ts';
import type { Requirement, TaggedBindingSource } from '../src/browser/engine/types.ts';
import {
  createAutoBindingsNote,
  createSlotBindingRequiredDiagnostic,
} from '../src/browser/diagnostics.ts';

function slotRequirement(slot: unknown, slotName: string): Requirement {
  return {
    kind: 'slot-value',
    key: `slot-value:${slotName}`,
    subject: slot,
    discoveredBy: 'failure',
    detail: { slotName },
  };
}

function moduleScope(values: unknown[]): TaggedBindingSource[] {
  return values.map((value) => ({ value, origin: 'module-scope' as const }));
}

function satisfy(requirement: Requirement, sources: TaggedBindingSource[]) {
  return satisfyRequirement(requirement, createProviderChain(), {
    sources: collectBindingSources(sources),
  });
}

describe('collectBindingSources', () => {
  it('flattens records one level, tags origins, and includes other objects directly', () => {
    const access = tgpu.accessor(d.f32);
    const bound = tgpu.fn([], d.f32)(() => {
      'use gpu';
      return 1;
    });

    const sources = collectBindingSources([
      { value: { access, skipped: undefined, alsoSkipped: null }, origin: 'module-scope' },
      { value: bound, origin: 'import-scope', label: './helpers.ts' },
      { value: 'not-an-object', origin: 'module-scope' },
      { value: undefined, origin: 'module-scope' },
    ]);

    expect(sources).toContainEqual({ value: access, origin: 'module-scope', label: undefined });
    expect(sources).toContainEqual({ value: bound, origin: 'import-scope', label: './helpers.ts' });
    expect(sources.some((entry) => entry.value === undefined || entry.value === null)).toBe(false);
  });

  it('deduplicates by identity, first origin wins', () => {
    const access = tgpu.accessor(d.f32);
    const sources = collectBindingSources([
      { value: { a: access }, origin: 'module-scope' },
      { value: { b: access }, origin: 'import-scope' },
    ]);
    const matches = sources.filter((entry) => entry.value === access);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.origin).toBe('module-scope');
  });
});

describe('slot-value provider chain', () => {
  it('synthesizes a placeholder value from a matching accessor schema', () => {
    const access = tgpu.accessor(d.vec2f).$name('params');
    const provision = satisfy(slotRequirement(access.slot, 'params'), moduleScope([access]));

    expect(provision?.provider).toBe('synthesis');
    // Ones, not zeros: zero placeholders walk comptime math into NaN traps.
    expect(provision?.value).toEqual(d.vec2f(1, 1));
    expect(provision?.provenance).toBe(
      'non-degenerate placeholder value recursively derived from its accessor schema',
    );
  });

  it('recursively synthesizes non-degenerate composite values without field-name heuristics', () => {
    const Nested = d.struct({ scale: d.align(16, d.f32) });
    const Params = d.struct({
      tint: d.vec4f,
      transform: d.mat4x4f,
      samples: d.arrayOf(d.vec2f, 2),
      nested: Nested,
    });
    const access = tgpu.accessor(Params).$name('structParams');
    const provision = satisfy(
      slotRequirement(access.slot, 'structParams'),
      moduleScope([access]),
    );
    expect(provision?.value).toEqual(Params({
      tint: d.vec4f(1),
      transform: d.mat4x4f.identity(),
      samples: [d.vec2f(1), d.vec2f(1)],
      nested: Nested({ scale: 1 }),
    }));
  });

  it('prefers a borrowed real value over an accessor zero value', () => {
    const access = tgpu.accessor(d.f32).$name('force');
    const impl = tgpu.fn([], d.f32)(() => {
      'use gpu';
      return 2;
    });
    const consumer = tgpu.fn([], d.f32)(() => {
      'use gpu';
      return 1;
    });
    const bound = consumer.with(access, impl);

    const provision = satisfy(slotRequirement(access.slot, 'force'), moduleScope([access, bound]));
    expect(provision?.provider).toBe('module-scope');
    expect(provision?.value).toBe(impl);
    expect(provision?.provenance).toContain('borrowed from a bound function');
  });

  it('borrows from a bound function when no accessor matches', () => {
    const slot = tgpu.slot<number>().$name('scale');
    const consumer = tgpu.fn([], d.f32)(() => {
      'use gpu';
      return 1;
    });
    const bound = consumer.with(slot, 42);

    const provision = satisfy(slotRequirement(slot, 'scale'), moduleScope([bound]));
    expect(provision?.provider).toBe('module-scope');
    expect(provision?.value).toBe(42);
  });

  it('borrows from render-pipeline-shaped slot bindings and reports source origin', () => {
    const slot = tgpu.slot<number>().$name('mode');
    // A non-plain prototype, like a real pipeline instance: plain records get
    // flattened by collectBindingSources, other objects are included directly.
    const pipelineLike = Object.setPrototypeOf(
      {
        [Symbol('typegpu:x:$internal')]: {
          core: { options: { slotBindings: [[slot, 3]] } },
        },
      },
      { pipelineLikeMarker: true },
    );

    const provision = satisfy(slotRequirement(slot, 'mode'), [
      { value: pipelineLike, origin: 'import-scope', label: './pipes.ts' },
    ]);
    expect(provision?.provider).toBe('import-scope');
    expect(provision?.value).toBe(3);
    expect(provision?.provenance).toContain('render pipeline');
    expect(provision?.provenance).toContain("./pipes.ts");
  });

  it('never zero-synthesizes mutable accessors but still borrows for them', () => {
    const mutableAccess = tgpu.mutableAccessor(d.f32).$name('state');
    const consumer = tgpu.fn([], d.f32)(() => {
      'use gpu';
      return 1;
    });
    const bound = consumer.with(mutableAccess, 5 as never);

    expect(satisfy(slotRequirement(mutableAccess.slot, 'state'), moduleScope([mutableAccess])))
      .toBeUndefined();

    const provision = satisfy(
      slotRequirement(mutableAccess.slot, 'state'),
      moduleScope([mutableAccess, bound]),
    );
    expect(provision?.provider).toBe('module-scope');
    expect(provision?.value).toBe(5);
  });

  it('fails soft on a non-callable accessor schema', () => {
    const slot = tgpu.slot<number>().$name('weird');
    const brokenAccessorLike = { resourceType: 'accessor', slot, schema: { type: 'mystery' } };
    expect(satisfy(slotRequirement(slot, 'weird'), moduleScope([brokenAccessorLike])))
      .toBeUndefined();

    const consumer = tgpu.fn([], d.f32)(() => {
      'use gpu';
      return 1;
    });
    const bound = consumer.with(slot, 9);
    const provision = satisfy(
      slotRequirement(slot, 'weird'),
      moduleScope([brokenAccessorLike, bound]),
    );
    expect(provision?.value).toBe(9);
  });

  it('returns undefined when nothing matches', () => {
    const slot = tgpu.slot<number>();
    const unrelated = tgpu.accessor(d.f32);
    expect(satisfy(slotRequirement(slot, 'missing'), moduleScope([unrelated, {}, 5])))
      .toBeUndefined();
  });
});

describe('slot diagnostics builders', () => {
  it('builds the auto-bind failure diagnostic', () => {
    const diagnostic = createSlotBindingRequiredDiagnostic({
      slotName: 'lighting',
      appliedSlotNames: ['force'],
      autoBindAttempted: true,
    });

    expect(diagnostic.code).toBe('slot-binding-required');
    expect(diagnostic.severity).toBeUndefined();
    expect(diagnostic.message).toContain('slot:lighting');
    expect(diagnostic.message).toContain('could not auto-bind');
    expect(diagnostic.hint).toContain('force');
    expect(diagnostic.hint).toContain('probeBindings');
  });

  it('builds the auto-applied note with bounded value summaries', () => {
    const access = tgpu.accessor(d.f32).$name('params');
    const note = createAutoBindingsNote([
      {
        requirement: slotRequirement(access.slot, 'params'),
        provision: {
          value: 1,
          provider: 'synthesis',
          provenance: 'placeholder value derived from its accessor schema',
        },
      },
      {
        requirement: slotRequirement(tgpu.slot(), 'force'),
        provision: {
          value: { big: 'object' },
          provider: 'module-scope',
          provenance: 'value borrowed from a bound function in the binding sources',
        },
      },
    ]);

    expect(note.code).toBe('slot-bindings-auto-applied');
    expect(note.severity).toBe('note');
    expect(note.message).toContain('2 slot value(s)');
    expect(note.hint).toContain('slot:params <- placeholder value');
    expect(note.hint).toContain('slot:force <- value borrowed from a bound function');
    expect(note.valueSummary).toEqual([
      expect.objectContaining({ slot: 'params', provider: 'synthesis' }),
      expect.objectContaining({ slot: 'force', provider: 'module-scope' }),
    ]);
  });
});
