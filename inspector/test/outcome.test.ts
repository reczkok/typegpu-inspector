import { describe, expect, it } from 'vitest';
import { inferTargetOutcome } from '../src/browser/outcome.ts';

describe('inferTargetOutcome', () => {
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
