import tgpu, { d, std } from 'typegpu';

export const posterize = tgpu.fn([d.vec3f, d.f32], d.vec3f)((color, steps) => {
  'use gpu';
  return std.floor(color * steps) / steps;
});

export const vignette = tgpu.fn([d.vec2f], d.f32)((uv) => {
  'use gpu';
  const centered = uv * 2 - 1;
  return std.smoothstep(1.1, 0.2, std.length(centered));
});

export const paletteSlot = tgpu.slot(
  tgpu.fn([d.f32], d.vec3f)((t) => {
    'use gpu';
    return d.vec3f(t, 0.35 + 0.5 * t, 1 - t);
  }),
);

