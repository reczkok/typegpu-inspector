import { describe, expect, it } from 'vitest';
import { scrubProbeNames, serializeError } from '../src/browser/gpuRecorder.js';

describe('scrubProbeNames', () => {
  it('drops probe wrapper entries from resolution trees', () => {
    const message = [
      'Resolution of the following tree failed:',
      '- <root>',
      '- fn:__typegpuMcpProbe14',
      '- fn:getNormalFromSdf: Unsupported data types: vec2i.',
    ].join('\n');
    expect(scrubProbeNames(message)).toBe([
      'Resolution of the following tree failed:',
      '- <root>',
      '- fn:getNormalFromSdf: Unsupported data types: vec2i.',
    ].join('\n'));
  });

  it('replaces other mentions and applies to serialized errors', () => {
    expect(scrubProbeNames('__typegpuMcpProbeSchema3_0 is not callable'))
      .toBe('<probe> is not callable');
    expect(serializeError(new Error('__typegpuMcpProbe2 failed')).message)
      .toBe('<probe> failed');
  });
});
