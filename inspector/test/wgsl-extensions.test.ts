import { describe, expect, it } from 'vitest';
import {
  partitionUnavailableExtensionErrors,
  unavailableExtensionFeature,
  wgslExtensionsFor,
} from '../src/browser/wgslExtensions.ts';

describe('wgslExtensionsFor', () => {
  it('maps enabled device features to WGSL enable directives', () => {
    expect(wgslExtensionsFor(['shader-f16', 'subgroups', 'timestamp-query'])).toEqual([
      'f16',
      'subgroups',
    ]);
  });
});

describe('partitionUnavailableExtensionErrors', () => {
  const f16Error = { type: 'error', message: "'f16' type used without 'f16' extension enabled" };
  const subgroupError = {
    type: 'error',
    message: "cannot call built-in function 'subgroupAdd' without extension 'subgroups'",
  };
  const other = { type: 'error', message: 'unresolved value' };

  it('separates errors about extensions the device cannot enable', () => {
    expect(partitionUnavailableExtensionErrors([f16Error, subgroupError, other], ['subgroups']))
      .toEqual({ messages: [subgroupError, other], unavailableFeatures: ['shader-f16'] });
  });

  it('keeps an extension error when the device has the feature (the directive is the bug)', () => {
    expect(partitionUnavailableExtensionErrors([f16Error], ['shader-f16'])).toEqual({
      messages: [f16Error],
      unavailableFeatures: [],
    });
  });
});

describe('unavailableExtensionFeature', () => {
  it('names the missing feature behind a thrown compiler message', () => {
    expect(
      unavailableExtensionFeature(
        "Error while parsing WGSL: :4:36 error: 'f16' type used without 'f16' extension enabled",
        ['subgroups'],
      ),
    ).toBe('shader-f16');
    expect(unavailableExtensionFeature('unresolved value', [])).toBeUndefined();
    expect(
      unavailableExtensionFeature("'f16' type used without 'f16' extension enabled", ['shader-f16']),
    ).toBeUndefined();
  });
});
