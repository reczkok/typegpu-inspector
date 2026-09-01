import { d, tgpu } from 'typegpu';
import { shadedFragment, shadeSlot } from './pasted-slot-provider.ts';

const root = await tgpu.init();

const vertex = tgpu.vertexFn({ out: { position: d.builtin.position, uv: d.vec2f } })(() => {
  'use gpu';
  return { position: d.vec4f(0, 0, 0, 1), uv: d.vec2f(0) };
});

const grayscale = (texel: d.v4f) => {
  'use gpu';
  return d.vec3f(texel.x * 0.25);
};

export const pipeline = root.with(shadeSlot, grayscale).createRenderPipeline({
  vertex,
  fragment: shadedFragment,
  targets: { format: 'rgba8unorm' },
});
