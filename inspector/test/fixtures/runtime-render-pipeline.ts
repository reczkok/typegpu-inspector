// @ts-nocheck
import { tgpu, d } from 'typegpu';

const renderRoot = await tgpu.init();

export const runtimeVertexLayout = tgpu.vertexLayout(d.arrayOf(d.vec3f));

export const runtimeVertex = tgpu.vertexFn({
  in: { position: d.vec3f },
  out: { position: d.builtin.position },
})(({ position }) => {
  'use gpu';
  return { position: d.vec4f(position, 1) };
});

export const runtimeFragment = tgpu.fragmentFn({
  out: d.vec4f,
})(() => {
  'use gpu';
  return d.vec4f(1, 0.5, 0.25, 1);
});

export const runtimeRenderPipeline = renderRoot.createRenderPipeline({
  attribs: { position: runtimeVertexLayout.attrib },
  vertex: runtimeVertex,
  fragment: runtimeFragment,
  targets: {
    format: 'rgba16float',
    blend: {
      color: {
        srcFactor: 'src-alpha',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add',
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'zero',
        operation: 'add',
      },
    },
  },
  primitive: {
    topology: 'triangle-strip',
    frontFace: 'cw',
    cullMode: 'back',
  },
  depthStencil: {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less',
  },
  multisample: { count: 4 },
});
