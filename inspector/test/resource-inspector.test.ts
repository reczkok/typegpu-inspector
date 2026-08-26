import { describe, expect, it } from 'vitest';
import { tgpu, d } from 'typegpu';
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

// TypeGPU keeps root/encoder/pass state behind version-stamped private
// symbols. Reconstructing that shape here keeps the branch coverage in a plain
// Node test; test/browser-smoke.test.ts checks the same branches against real
// 0.12 objects on a live device.
const $soul = Symbol('typegpu:0.12.3:$soul');
const $internal = Symbol('typegpu:0.12.3:$internal');

describe('TypeGPU 0.12 runtime resources', () => {
  it('describes a root through its public device and soul settings', () => {
    const resource = inspectResourceValue({
      resourceType: 'root',
      nameRegistrySetting: 'strict',
      device: { label: 'inspector device', features: new Set(['timestamp-query']) },
      [$soul]: { type: 'root', minify: false, label: 'app root' },
    });

    expect(resource).toMatchObject({
      resourceType: 'root',
      properties: {
        label: 'app root',
        nameRegistry: 'strict',
        minify: false,
        deviceLabel: 'inspector device',
        deviceFeatures: ['timestamp-query'],
      },
    });
  });

  it('reports a guarded compute pipeline with its inner pipeline and size uniform', () => {
    const pipeline = { resourceType: 'compute-pipeline' };
    const sizeUniform = { resourceType: 'uniform', buffer: { resourceType: 'buffer' } };
    const resource = inspectResourceValue({
      resourceType: 'guarded-compute-pipeline',
      pipeline,
      sizeUniform,
      [$soul]: {
        type: 'guarded-compute-pipeline',
        workgroupSize: [64, 1, 1],
        label: 'blur guard',
      },
    });

    expect(resource.properties).toMatchObject({
      label: 'blur guard',
      workgroupSize: [64, 1, 1],
      pipelineResourceType: 'compute-pipeline',
    });
    expect(resource.itemNames).toEqual(['pipeline', 'sizeUniform']);
    expect(resource.items?.[0]?.resourceType).toBe('compute-pipeline');
    expect(resource.items?.[1]?.resourceType).toBe('uniform');
  });

  it('reports command encoder adoption and pending command hooks', () => {
    const resource = inspectResourceValue({
      resourceType: 'command-encoder',
      [$internal]: {
        rawEncoder: { label: 'frame encoder' },
        adopted: true,
        beforeFinish: new Map([['a', () => {}]]),
        afterSubmit: new Map(),
      },
    });

    expect(resource).toMatchObject({
      resourceType: 'command-encoder',
      properties: {
        label: 'frame encoder',
        adopted: true,
        pendingBeforeFinish: 1,
        pendingAfterSubmit: 0,
      },
    });
  });

  it('reports render pass draw state including render-only fields', () => {
    const resource = inspectResourceValue({
      resourceType: 'render-pass',
      [$internal]: {
        rawPass: { label: 'main pass' },
        owner: { resourceType: 'command-encoder' },
        state: {
          rawAccessed: false,
          version: 3,
          bindGroups: new Map([['layout', {}]]),
          vertexBuffers: new Map([['layout', {}], ['other', {}]]),
          indexBuffer: { indexFormat: 'uint16' },
          stencilReference: 7,
          currentPipeline: { resourceType: 'render-pipeline' },
        },
      },
    });

    expect(resource).toMatchObject({
      resourceType: 'render-pass',
      properties: {
        label: 'main pass',
        hasOwningEncoder: true,
        rawAccessed: false,
        stateVersion: 3,
        boundGroupCount: 1,
        vertexBufferCount: 2,
        indexFormat: 'uint16',
        stencilReference: 7,
        currentPipelineResourceType: 'render-pipeline',
      },
    });
  });

  it('omits render-only fields for a compute pass and marks adopted passes', () => {
    const resource = inspectResourceValue({
      resourceType: 'compute-pass',
      [$internal]: {
        rawPass: {},
        owner: undefined,
        state: { rawAccessed: true, version: 0, bindGroups: new Map() },
      },
    });

    expect(resource.resourceType).toBe('compute-pass');
    expect(resource.properties).toMatchObject({
      hasOwningEncoder: false,
      rawAccessed: true,
      boundGroupCount: 0,
    });
    expect(resource.properties).not.toHaveProperty('vertexBufferCount');
    expect(resource.properties).not.toHaveProperty('indexFormat');
  });

  it('describes a render bundle encoder with the shared draw state', () => {
    const resource = inspectResourceValue({
      resourceType: 'render-bundle-encoder',
      [$internal]: {
        rawPass: { label: 'bundle' },
        state: { rawAccessed: false, version: 1, bindGroups: new Map(), vertexBuffers: new Map() },
      },
    });

    expect(resource).toMatchObject({
      resourceType: 'render-bundle-encoder',
      properties: { label: 'bundle', stateVersion: 1, vertexBufferCount: 0 },
    });
  });

  it('keeps the runtime-type fallback for resources it has no branch for', () => {
    expect(inspectResourceValue({ resourceType: 'some-future-type', a: 1 })).toMatchObject({
      resourceType: 'some-future-type',
      properties: { runtimeType: 'Object', keys: ['resourceType', 'a'] },
    });
  });
});
