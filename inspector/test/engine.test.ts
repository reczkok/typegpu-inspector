import { describe, expect, it } from 'vitest';
import { tgpu, d } from 'typegpu';
import {
  createEngineContext,
  createRequirementFailure,
  satisfyAndAttempt,
  slotValueProvisions,
} from '../src/browser/engine/engine.ts';
import { collectShapeProvenances, ledgerHas } from '../src/browser/engine/ledger.ts';
import {
  createFragmentTargetsLedgerEntry,
  createPlaceholderValue,
  createVertexAttribsLedgerEntry,
  synthesizeFragmentTargets,
} from '../src/browser/engine/synthesis.ts';
import { TargetDiagnosticError } from '../src/browser/diagnostics.ts';

describe('fragment target synthesis', () => {
  it.each(['light', 'dist'])('handles named color and %s outputs from a real fragment function', (name) => {
    const fragment = tgpu.fragmentFn({ out: { color: d.vec4f, [name]: d.vec4f } })`() {}`;
    expect(synthesizeFragmentTargets(d, fragment)).toEqual({
      color: { format: 'rgba8unorm' },
      [name]: { format: 'rgba8unorm' },
    });
  });

  it('omits builtin outputs and matches integer target formats', () => {
    const fragment = tgpu.fragmentFn({
      out: { color: d.vec4f, ids: d.vec4u, signed: d.vec4i, depth: d.builtin.fragDepth },
    })`() {}`;
    expect(synthesizeFragmentTargets(d, fragment)).toEqual({
      color: { format: 'rgba8unorm' }, ids: { format: 'rgba32uint' }, signed: { format: 'rgba32sint' },
    });
  });

  it('retains support for struct metadata and decorated single outputs', () => {
    expect(synthesizeFragmentTargets(d, { shell: { out: d.struct({ color: d.vec4f }) } })).toEqual({
      color: { format: 'rgba8unorm' },
    });
    expect(synthesizeFragmentTargets(d, { shell: { out: d.location(0, d.vec4u) } })).toEqual({
      format: 'rgba32uint',
    });
    expect(synthesizeFragmentTargets(d, tgpu.fragmentFn({ out: d.vec4f })`() {}`)).toEqual({
      format: 'rgba8unorm',
    });
    expect(synthesizeFragmentTargets(d, { shell: { out: { depth: d.builtin.fragDepth } } })).toBeUndefined();
  });

  it.each([d.u32, d.vec2u, d.vec3u, d.i32, d.vec2i, d.vec3i])('matches integer scalar and shorter vector output %s', (schema) => {
    const channels = schema.type.startsWith('vec') ? 'rg' : 'r';
    const expected = `${channels}32${schema.type.endsWith('u') || schema.type === 'u32' ? 'uint' : 'sint'}`;
    expect(synthesizeFragmentTargets(d, { shell: { out: schema } })).toEqual({ format: expected });
  });
});

function missingSlotError(slot: unknown, name: string): Error {
  return Object.assign(new Error(`Missing value for 'slot:${name}'`), { slot });
}

describe('satisfyAndAttempt', () => {
  it('requires a real binding for runtime-sized arrays instead of generating invalid WGSL literals', () => {
    const access = tgpu.accessor(d.arrayOf(d.vec4f)).$name('instances');
    const engine = createEngineContext({
      enabled: true,
      sources: [{ value: { access }, origin: 'module-scope' }],
    });
    expect(() => satisfyAndAttempt(engine, () => {
      throw missingSlotError(access.slot, 'instances');
    }, (requirement, error) => createRequirementFailure(engine, requirement, error, undefined)))
      .toThrow(TargetDiagnosticError);
    expect(engine.satisfied).toHaveLength(0);
    expect(engine.ledger[0]).toMatchObject({
      status: 'unsatisfied', kind: 'slot-value',
      detail: { bindingReason: expect.stringContaining('Runtime-sized arrays require a storage binding') },
    });
    const failure = createRequirementFailure(engine, {
      kind: 'slot-value', key: 'slot-value:instances', subject: access.slot, discoveredBy: 'failure',
      detail: engine.ledger[0]?.detail,
    }, new Error('Missing binding'), access);
    expect(failure.diagnostics[0]?.hint).toContain("explicit inspection context");
    expect(() => createPlaceholderValue(d.struct({ data: d.arrayOf(d.vec4f, 0) })))
      .toThrow('Runtime-sized arrays require a storage binding');
    expect(createPlaceholderValue(d.arrayOf(d.vec4f, 2))).toEqual([d.vec4f(1), d.vec4f(1)]);
  });

  it('returns immediately when the attempt succeeds', () => {
    const engine = createEngineContext({ enabled: true, sources: [] });
    expect(satisfyAndAttempt(engine, () => 'ok', () => new Error('no'))).toBe('ok');
    expect(engine.ledger).toHaveLength(0);
  });

  it('satisfies a missing slot and retries until resolution succeeds', () => {
    const access = tgpu.accessor(d.f32).$name('params');
    const engine = createEngineContext({
      enabled: true,
      sources: [{ value: { access }, origin: 'module-scope' }],
    });

    let attempts = 0;
    const result = satisfyAndAttempt(
      engine,
      () => {
        attempts += 1;
        if (slotValueProvisions(engine).length === 0) {
          throw missingSlotError(access.slot, 'params');
        }
        return 'resolved';
      },
      () => new Error('unsatisfiable'),
    );

    expect(result).toBe('resolved');
    expect(attempts).toBe(2);
    expect(ledgerHas(engine.ledger, 'slot-value', 'satisfied')).toBe(true);
    expect(engine.ledger[0]).toMatchObject({
      kind: 'slot-value',
      status: 'satisfied',
      discoveredBy: 'failure',
      provider: 'synthesis',
      detail: { slotName: 'params' },
    });
  });

  it('records an unsatisfied entry and throws the failure builder result', () => {
    const orphanSlot = tgpu.slot<number>().$name('orphan');
    const engine = createEngineContext({ enabled: true, sources: [] });

    expect(() =>
      satisfyAndAttempt(
        engine,
        () => {
          throw missingSlotError(orphanSlot, 'orphan');
        },
        (requirement, error) =>
          createRequirementFailure(engine, requirement, error, undefined),
      )
    ).toThrow(TargetDiagnosticError);

    expect(ledgerHas(engine.ledger, 'slot-value', 'unsatisfied')).toBe(true);
    expect(engine.ledger[0]).toMatchObject({ status: 'unsatisfied', detail: { slotName: 'orphan' } });
  });

  it('bails out when a satisfied slot reappears (provision had no effect)', () => {
    const access = tgpu.accessor(d.f32).$name('sticky');
    const engine = createEngineContext({
      enabled: true,
      sources: [{ value: { access }, origin: 'module-scope' }],
    });

    let attempts = 0;
    expect(() =>
      satisfyAndAttempt(
        engine,
        () => {
          attempts += 1;
          throw missingSlotError(access.slot, 'sticky');
        },
        () => new Error('gave up'),
      )
    ).toThrow('gave up');

    expect(attempts).toBe(2);
    expect(engine.satisfied).toHaveLength(1);
    expect(ledgerHas(engine.ledger, 'slot-value', 'unsatisfied')).toBe(true);
  });

  it('rethrows the original error untouched when the engine is disabled', () => {
    const access = tgpu.accessor(d.f32).$name('params');
    const engine = createEngineContext({
      enabled: false,
      sources: [{ value: { access }, origin: 'module-scope' }],
    });
    const original = missingSlotError(access.slot, 'params');

    expect(() =>
      satisfyAndAttempt(engine, () => {
        throw original;
      }, () => new Error('unused'))
    ).toThrow(original);
    expect(engine.ledger).toHaveLength(0);
  });

  it('rethrows unrecognized errors for the message classifiers', () => {
    const engine = createEngineContext({ enabled: true, sources: [] });
    const original = new Error('some other resolution problem');
    expect(() =>
      satisfyAndAttempt(engine, () => {
        throw original;
      }, () => new Error('unused'))
    ).toThrow(original);
    expect(engine.ledger).toHaveLength(0);
  });
});

describe('ledger helpers', () => {
  it('collects descriptor-synthesis provenance sentences for the compat note', () => {
    const entries = [createVertexAttribsLedgerEntry(), createFragmentTargetsLedgerEntry()];
    const provenances = collectShapeProvenances(entries);
    expect(provenances).toEqual([
      'Vertex attributes were synthesized from vertex.shell.in using one minimal vertex layout per attribute.',
      'Fragment targets were synthesized from fragment.shell.out with formats matching the output scalar types.',
    ]);
  });
});
