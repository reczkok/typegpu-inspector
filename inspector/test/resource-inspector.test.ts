import { describe, expect, it } from 'vitest';
import tgpu, { d } from 'typegpu';
import {
  inspectResolvedBindGroupLayouts,
  inspectResourceValue,
} from '../src/browser/resourceInspector.ts';

describe('schema inspection limits', () => {
  it('reports every member within WGSL\'s required structure limit', () => {
    const fields = Object.fromEntries(
      Array.from({ length: 1_023 }, (_, index) => [`field${index}`, d.f32]),
    );
    const resource = inspectResourceValue(d.struct(fields));

    expect(resource.schema?.fieldCount).toBe(1_023);
    expect(resource.schema?.fields).toHaveLength(1_023);
    expect(resource.schema?.properties?.truncated).not.toBe(true);
  });

  it('retains wrapped types needed for host-shareability analysis', () => {
    expect(inspectResourceValue(d.atomic(d.u32)).schema).toMatchObject({
      type: 'atomic',
      inner: { type: 'u32' },
    });
    expect(inspectResourceValue(d.size(16, d.f32)).schema).toMatchObject({
      type: 'decorated',
      inner: { type: 'f32' },
    });
  });
});

describe('resolution-derived bind group layouts', () => {
  it('serializes sparse groups, default visibility, and WebGPU descriptors', () => {
    const layout = tgpu.bindGroupLayout({
      params: { uniform: d.vec3u },
      data: { storage: d.arrayOf(d.f32), access: 'mutable' },
      skipped: null,
      sampled: {
        texture: d.texture2d(d.f32),
        visibility: ['compute'] as const,
      },
    }).$idx(2).$name('blur layout');
    const layouts: unknown[] = [];
    layouts[2] = layout;

    expect(inspectResolvedBindGroupLayouts(layouts)).toEqual([{
      group: 2,
      label: 'blur layout',
      source: 'resolution',
      entries: [
        {
          binding: 0,
          name: 'params',
          visibility: ['compute', 'vertex', 'fragment'],
          resource: { buffer: { type: 'uniform' } },
        },
        {
          binding: 1,
          name: 'data',
          visibility: ['compute', 'fragment'],
          resource: { buffer: { type: 'storage' } },
        },
        {
          binding: 3,
          name: 'sampled',
          visibility: ['compute'],
          resource: {
            texture: {
              sampleType: 'float',
              viewDimension: '2d',
              multisampled: false,
            },
          },
        },
      ],
    }]);
  });
});
