import { describe, expect, it } from 'vitest';
import {
  partitionUnavailableExtensionErrors,
  pruneUnusedWgslExtensions,
  unavailableExtensionFeature,
  wgslExtensionsFor,
} from '../src/browser/wgslExtensions.ts';
import { createGpuRecorder } from '../src/browser/gpuRecorder.ts';

describe('unused WGSL directives', () => {
  const features = ['shader-f16', 'clip-distances', 'dual-source-blending', 'subgroups', 'primitive-index'];
  const header = 'enable f16;\nenable clip_distances;\nenable dual_source_blending;\nenable subgroups;\nenable primitive_index;\n\n';

  it('removes unused capabilities without mistaking comments or similar names for usage', () => {
    const body = '// subgroupAdd(1)\n/* f16 /* @builtin(clip_distances) */ */\nfn subgroupHelper() -> f32 { return 1; }';
    expect(pruneUnusedWgslExtensions(header + body, features)).toBe(body);
  });

  it.each([
    ['f16', 'alias Half = f16;'], ['f16', 'const half = vec2h(1);'],
    ['f16', 'const half = mat2x2h();'], ['f16', 'const half = 1e-2h;'],
    ['f16', 'const half = 0x1.fp+0h;'], ['f16', 'const half = 0x.fp+0h;'],
    ['clip_distances', 'struct Out { @builtin(/* comment */ clip_distances) distances: array<f32, 1> }'],
    ['dual_source_blending', 'struct Out { @location(0) @blend_src(1) color: vec4f }'],
    ['primitive_index', 'fn fragment(@builtin(primitive_index) index: u32) {}'],
    ['subgroups', 'fn main() { let result = subgroupAdd(1); }'],
    ['subgroups', 'fn main() { let result = quadSwapX(1); }'],
    ['subgroups', 'fn main(@builtin(subgroup_size) size: u32) {}'],
  ])('retains %s for %s', (extension, body) => {
    const result = pruneUnusedWgslExtensions(header + body, features);
    expect(result).toBe(`enable ${extension};\n\n${body}`);
    expect(pruneUnusedWgslExtensions(result, features)).toBe(result);
  });

  it('preserves unsupported, unknown and malformed directives for compiler diagnostics', () => {
    for (const code of ['enable f16;\nfn main() {}', 'enable future_feature;\nfn main() {}', 'enable f16, subgroups;\nfn main() {}', 'enable subgroups;\n/* unclosed']) {
      expect(pruneUnusedWgslExtensions(code, ['subgroups'])).toBe(code);
    }
  });

  it('records exactly the compiler input and leaves the caller descriptor unchanged', () => {
    let compiled: GPUShaderModuleDescriptor | undefined;
    const device = {
      features: new Set(features), queue: {},
      createShaderModule(descriptor: GPUShaderModuleDescriptor) {
        compiled = descriptor;
        return { getCompilationInfo: async () => ({ messages: [] }) };
      },
    } as unknown as GPUDevice;
    const recorder = createGpuRecorder(device);
    const descriptor = { code: header + '@compute @workgroup_size(1) fn main() {}', label: 'test' };
    recorder.device.createShaderModule(descriptor);
    expect(compiled?.code).toBe('@compute @workgroup_size(1) fn main() {}');
    expect(compiled?.label).toBe('test');
    expect(recorder.calls[0]?.descriptor).toMatchObject(compiled!);
    expect(descriptor.code).toBe(header + compiled!.code);
  });
});

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
