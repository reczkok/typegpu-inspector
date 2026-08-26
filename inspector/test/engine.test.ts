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
  createVertexAttribsLedgerEntry,
} from '../src/browser/engine/synthesis.ts';
import { TargetDiagnosticError } from '../src/browser/diagnostics.ts';

function missingSlotError(slot: unknown, name: string): Error {
  return Object.assign(new Error(`Missing value for 'slot:${name}'`), { slot });
}

describe('satisfyAndAttempt', () => {
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
      'Fragment targets were synthesized from fragment.shell.out with rgba8unorm formats.',
    ]);
  });
});
