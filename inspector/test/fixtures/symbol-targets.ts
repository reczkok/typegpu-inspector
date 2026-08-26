// @ts-nocheck
import { tgpu, d } from 'typegpu';
import { fullScreenTriangle } from 'typegpu/common';

const vertices = tgpu.const(d.arrayOf(d.vec2f, 3), [
  d.vec2f(-1, -1),
  d.vec2f(3, -1),
  d.vec2f(-1, 3),
]);
const attributedVertexLayout = tgpu.vertexLayout(d.arrayOf(d.vec4f));

export const exportedHelper = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return 1;
});

export const parameterizedHelper = (value: d.v4f) => {
  'use gpu';
  return value / (1 + d.vec4f(1));
};

const privateHelper = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return 42;
});

export const exportedCompute = tgpu.computeFn({ workgroupSize: [1] })(() => {
  'use gpu';
  const _value = exportedHelper();
});

export const exportedVertex = tgpu.vertexFn({
  in: { vertexIndex: d.builtin.vertexIndex },
  out: { position: d.builtin.position },
})(({ vertexIndex }) => {
  'use gpu';
  return { position: d.vec4f(vertices.$[vertexIndex]!, 0, 1) };
});

export const exportedFragment = tgpu.fragmentFn({ out: d.vec4f })(() => {
  'use gpu';
  return d.vec4f(1, 0, 0, 1);
});

export const exportedAttributedVertex = tgpu.vertexFn({
  in: {
    vertexIndex: d.builtin.vertexIndex,
    color: d.vec4f,
  },
  out: {
    position: d.builtin.position,
    color: d.vec4f,
  },
})(({ vertexIndex, color }) => {
  'use gpu';
  return { position: d.vec4f(vertices.$[vertexIndex]!, 0, 1), color };
});

export const exportedAttributedVertexLayout = attributedVertexLayout;

export const AccessorParams = d.struct({
  tint: d.vec4f,
});

const privateStructHelper = (params: d.Infer<typeof AccessorParams>) => {
  'use gpu';
  return d.vec4f(params.tint).add(d.vec4f(paramsAccess.$.tint));
};

export const paramsAccess = tgpu.accessor(AccessorParams);

export const accessorFragment = tgpu.fragmentFn({ out: d.vec4f })(() => {
  'use gpu';
  return paramsAccess.$.tint;
});

export const NondegenerateParams = d.struct({
  dimensions: d.vec2f,
  divisor: d.f32,
  transform: d.mat4x4f,
  samples: d.arrayOf(d.f32, 2),
});

export const nondegenerateParamsAccess = tgpu.accessor(NondegenerateParams);

export const nondegenerateVertex = tgpu.vertexFn({
  out: { position: d.builtin.position },
})(() => {
  'use gpu';
  const params = nondegenerateParamsAccess.$;
  const aspect = params.dimensions.x / params.dimensions.y;
  const scalarRatio = params.divisor / params.divisor;
  const matrixRatio = params.transform.columns[0].x / params.transform.columns[3].w;
  const arrayRatio = params.samples[0] / params.samples[1];
  return {
    position: d.vec4f(aspect + scalarRatio + matrixRatio + arrayRatio, 0, 0, 1),
  };
});
