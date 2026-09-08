import { describe, expect, it } from 'vitest';
import { inspectionInputSummary, inspectionRequirementSummary } from '../src/inspectionContext.js';
import type { InspectorLedgerEntry, InspectorTargetReport } from '../src/protocol.js';

const report = (ledger: InspectorLedgerEntry[] = [], context?: InspectorTargetReport['context']): InspectorTargetReport => ({
  label: 'test', kind: 'resolvable', ok: true, ledger, ...(context ? { context } : {}),
});
const slot = (name: string, storage = false): InspectorLedgerEntry => ({
  kind: 'slot-value', key: `slot-value:${name}`, status: 'satisfied', provider: 'synthesis',
  detail: { slotName: name }, valueSummary: storage ? { resourceType: 'mutable' } : { type: 'object' },
});

describe('concise inspection context', () => {
  it('describes schema probes, mixed real inputs and reference probes without reading prose', () => {
    expect(inspectionInputSummary(report([{
      kind: 'argument-values', key: 'probe', status: 'satisfied', provider: 'synthesis',
      provenance: 'This text may change.', detail: { arguments: [{ schema: 'ctx.d.vec2f' }, { value: 'module.scale' }, { refSchema: 'ctx.d.f32' }] },
    }]))).toBe('Probe: vec2f(0), scale, ref(f32())');
  });
  it('distinguishes caller-derived types from independently synthesized inputs', () => {
    expect(inspectionInputSummary(report([], { probe: { origin: 'call-site', line: 7 }, arguments: [{ schema: 'ctx.d.u32' }] }))).toBe('Call-site type probe: u32(0)');
  });
  it('names synthetic storage and value placeholders, excluding environment defaults', () => {
    expect(inspectionInputSummary(report([
      slot('forceAccess', true), slot('verticesAccess', true), slot('velocityAccess', true), slot('grabAccess'), slot('paramsAccess'),
      { tier: 'environment', kind: 'dom-setup', key: 'dom', status: 'satisfied', provider: 'synthesis' },
    ]))).toBe('3 synthetic storage bindings · Placeholders: grabAccess, paramsAccess');
  });
  it('shows concrete captured constants and preserves observed versus candidate provenance', () => {
    expect(inspectionInputSummary(report([], { captured: { radius: 7 } }))).toBe('Captured: radius = 7');
    expect(inspectionInputSummary(report([], { bindingSource: 'pipeline', association: 'direct' }))).toBe('Observed bindings: pipeline');
    expect(inspectionInputSummary(report([], { bindingSource: 'pipeline', association: 'candidate' }))).toBe('Candidate bindings: pipeline');
  });
  it('does not describe real bindings as synthesized placeholders', () => {
    expect(inspectionInputSummary(report([{ ...slot('color'), provider: 'observed-context' }]))).toBeUndefined();
    expect(inspectionInputSummary(report([{ ...slot('scale'), valueSummary: 1 }]))).toBe('Placeholder: scale = 1');
  });
  it('keeps missing inputs actionable and distinguishes known schema limitations', () => {
    const missing = { ...slot('material'), status: 'unsatisfied' as const };
    expect(inspectionRequirementSummary(report([missing]))).toBe('Missing slot: material — provide a binding or accessor schema.');
    expect(inspectionRequirementSummary(report([{ ...missing, detail: { slotName: 'data', bindingReason: 'Requires a concrete buffer size.' } }]))).toBe('Missing slot: data — Requires a concrete buffer size.');
    expect(inspectionRequirementSummary(report([], { probe: { origin: 'schema', missing: [{ index: 0, parameter: 'samples', reason: 'Supply an array schema.' }] } }))).toBe('Missing argument: samples — Supply an array schema.');
  });
  it('bounds large summaries and avoids inventing values for older reports', () => {
    expect(inspectionInputSummary(report([], { captured: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`parameter${i}`, 'x'.repeat(100)])) }))!.length).toBeLessThanOrEqual(160);
    expect(inspectionInputSummary({ ...report(), outcome: 'passed-with-assumptions' })).toBe('Additional inspection assumptions');
    expect(inspectionInputSummary(report())).toBeUndefined();
  });
});
