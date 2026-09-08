import { d, tgpu } from 'typegpu';

/** Bound only by pasted-slot-importer.ts; inspecting this file must not run its caller. */
export const shadeSlot = tgpu.slot<(texel: d.v4f) => d.v3f>();

export const shadedFragment = tgpu.fragmentFn({ in: { uv: d.vec2f }, out: d.vec4f })(
  ({ uv }) => {
    'use gpu';
    return d.vec4f(shadeSlot.$(d.vec4f(uv, 0, 1)), 1);
  },
);
