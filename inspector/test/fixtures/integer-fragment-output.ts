// @ts-nocheck -- exercise legal WGSL outputs beyond TypeGPU's vec4-only TS constraint.
import { d, tgpu } from 'typegpu';

export const vertex = tgpu.vertexFn({ out: { position: d.builtin.position } })(() => {
  'use gpu';
  return { position: d.vec4f(0, 0, 0, 1) };
});
export const scalar = tgpu.fragmentFn({ out: d.u32 })(() => {
  'use gpu';
  return d.u32(1);
});
export const vector = tgpu.fragmentFn({ out: { color: d.vec2i } })(() => {
  'use gpu';
  return { color: d.vec2i(1) };
});

export const triple = tgpu.fragmentFn({ out: d.vec3u })(() => {
  'use gpu';
  return d.vec3u(1);
});
export const floatScalar = tgpu.fragmentFn({ out: d.f32 })(() => {
  'use gpu';
  return d.f32(1);
});
export const floatTriple = tgpu.fragmentFn({ out: d.vec3f })(() => {
  'use gpu';
  return d.vec3f(1);
});
