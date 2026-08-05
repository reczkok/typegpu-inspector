// @ts-nocheck
import { paletteSlot, posterize, vignette } from '#inspector-helpers';

export async function inspect({ root, tgpu, d, std }) {
  const vertices = tgpu.const(d.arrayOf(d.vec2f, 3), [
    d.vec2f(0, 0),
    d.vec2f(2, 0),
    d.vec2f(0, 2),
  ]);

  const customPalette = tgpu.fn([d.f32], d.vec3f)((t) => {
    'use gpu';
    return d.vec3f(0.15 + t * 0.7, 0.85 - t * 0.35, 0.35 + std.sin(t * 6.28318530718) * 0.2);
  });

  const vertex = tgpu.vertexFn({
    in: { vertexIndex: d.builtin.vertexIndex },
    out: {
      position: d.builtin.position,
      uv: d.vec2f,
    },
  })(({ vertexIndex }) => {
    'use gpu';
    const uv = vertices.$[vertexIndex]!;

    return {
      position: d.vec4f(uv * 2 - 1, 0, 1),
      uv,
    };
  });

  const fragment = tgpu.fragmentFn({
    in: { uv: d.vec2f },
    out: d.vec4f,
  })(({ uv }) => {
    'use gpu';
    const bands = std.fract(uv.x * 4 + std.sin(uv.y * 12.5) * 0.15);
    const color = paletteSlot.$(bands) * vignette(uv);
    return d.vec4f(posterize(color, 6), 1);
  });

  return {
    label: 'aliased helper library render',
    kind: 'render-pipeline',
    value: root
      .with(paletteSlot, customPalette)
      .createRenderPipeline({
        vertex,
        fragment,
        targets: { format: 'rgba8unorm' },
      }),
  };
}
