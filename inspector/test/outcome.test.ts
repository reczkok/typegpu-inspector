import { describe, expect, it } from 'vitest';
import { inferTargetOutcome } from '../src/browser/outcome.ts';

describe('inferTargetOutcome', () => {
  it.each(['module-scope', 'import-scope', 'recorded-app-bindings'] as const)(
    'qualifies bindings borrowed from %s as inspection assumptions', (provider) => {
      expect(inferTargetOutcome({
        ok: true,
        ledger: [{ tier: 'resource', kind: 'slot-value', key: 'slot:value', status: 'satisfied', discoveredBy: 'failure', provider }],
      })).toBe('passed-with-assumptions');
    },
  );

  it.each(['inspection-timeout', 'webgpu-validation-timeout', 'result-serialization-failed'])(
    'classifies %s as an incomplete inspection, not a shader failure', (code) => {
      expect(inferTargetOutcome({ ok: false, diagnostics: [{ code, message: code }] })).toBe('blocked');
    },
  );
  it('does not count environment-tier ledger entries as target assumptions', () => {
    expect(inferTargetOutcome({
      ok: true,
      ledger: [{
        tier: 'environment',
        kind: 'device-session',
        key: 'device-session:quiescent-run',
        status: 'satisfied',
        discoveredBy: 'shape',
        provider: 'synthesis',
        provenance: 'Quiescent run.',
      }],
    })).toBe('passed');
  });

  it('marks structural-only resource success as assumption-qualified', () => {
    expect(inferTargetOutcome({
      ok: true,
      diagnostics: [{
        code: 'structural-resource-only',
        severity: 'note',
        message: 'Only structural metadata was inspected.',
      }],
    })).toBe('passed-with-assumptions');
  });
});
