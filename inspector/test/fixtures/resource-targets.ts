// @ts-nocheck
import { tgpu, d, std } from 'typegpu';

const resourceRoot = await tgpu.init();

export const ResourceSettings = d.struct({
  filterDim: d.i32,
  blockDim: d.u32,
});

export const settingsUniform = resourceRoot.createUniform(ResourceSettings, {
  filterDim: 8,
  blockDim: 4,
});

export const imageTexture = resourceRoot
  .createTexture({
    size: [64, 32],
    format: 'rgba8unorm',
  })
  .$usage('sampled', 'render');

export const storageTexture = resourceRoot
  .createTexture({
    size: [64, 32],
    format: 'rgba8unorm',
  })
  .$usage('sampled', 'storage');

export const sampledView = imageTexture.createView(d.texture2d(d.f32));
export const storageView = storageTexture.createView(
  d.textureStorage2d('rgba8unorm'),
);

export const linearSampler = resourceRoot.createSampler({
  magFilter: 'linear',
  minFilter: 'linear',
});

export const resourceBundle = {
  buffers: {
    settings: settingsUniform,
  },
  textures: {
    sampled: imageTexture,
    view: sampledView,
  },
  sampler: linearSampler,
  label: 'post-processing resources',
};

export const samplerHelper = (uv: d.v2f, sampler: d.sampler) => {
  'use gpu';
  return std.textureSampleLevel(sampledView.$, sampler, uv, 0);
};

const factoryCompute = tgpu.computeFn({ workgroupSize: [1] })(() => {
  'use gpu';
});

function createFactoryPipelines() {
  return {
    'gpu-simple': resourceRoot.createComputePipeline({
      compute: factoryCompute,
    }),
  };
}

export const factoryPipelines = createFactoryPipelines();

export const ioLayout = tgpu.bindGroupLayout({
  flip: { uniform: d.u32 },
  input: { texture: d.texture2d(d.f32) },
  output: { storageTexture: d.textureStorage2d('rgba8unorm') },
  sampler: { sampler: 'filtering' },
});

export const flipBuffer = resourceRoot
  .createBuffer(d.u32, 0)
  .$usage('uniform');

export const ioBindGroups = [
  resourceRoot.createBindGroup(ioLayout, {
    flip: flipBuffer,
    input: sampledView,
    output: storageView,
    sampler: linearSampler,
  }),
];

export const tileData = tgpu.workgroupVar(
  d.arrayOf(d.arrayOf(d.vec3f, 8), 4),
);

export const vertexLayout = tgpu.vertexLayout(d.arrayOf(d.vec4f));

export const resourceSlot = tgpu.slot(7);

export const resourceAccessor = tgpu.accessor(ResourceSettings, {
  filterDim: 3,
  blockDim: 126,
});

// TypeGPU 0.12 runtime resources: the root itself, the guarded compute
// pipeline wrapper, and the command-encoder/pass/bundle-encoder family.
export const inspectedRoot = resourceRoot;

export const guardedPipeline = resourceRoot.createGuardedComputePipeline(() => {
  'use gpu';
});

export const commandEncoder = resourceRoot.createCommandEncoder({
  label: 'resource encoder',
});

export const computePass = commandEncoder.beginComputePass({
  label: 'resource compute pass',
});
computePass.end();

export const renderPass = commandEncoder.beginRenderPass({
  label: 'resource render pass',
  colorAttachments: [{ view: imageTexture }],
});
renderPass.end();

export const renderBundleEncoder = resourceRoot.createRenderBundleEncoder({
  label: 'resource bundle encoder',
  colorFormats: ['rgba8unorm'],
});
