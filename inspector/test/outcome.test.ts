import { describe, expect, it } from 'vitest';
import { inferTargetOutcome } from '../src/browser/outcome.ts';

describe('inferTargetOutcome', () => {
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
