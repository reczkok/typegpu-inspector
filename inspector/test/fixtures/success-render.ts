// @ts-nocheck
export async function inspect({ root, tgpu, d }) {
  const vertices = tgpu.const(d.arrayOf(d.vec2f, 3), [
    d.vec2f(-1, -1),
    d.vec2f(3, -1),
    d.vec2f(-1, 3),
  ]);

  const vertex = tgpu.vertexFn({
    in: { vertexIndex: d.builtin.vertexIndex },
    out: { position: d.builtin.position },
  })(({ vertexIndex }) => {
    'use gpu';
    return { position: d.vec4f(vertices.$[vertexIndex]!, 0, 1) };
  });

  const fragment = tgpu.fragmentFn({ out: d.vec4f })(() => {
    'use gpu';
    return d.vec4f(1, 0, 0, 1);
  });

  return {
    label: 'success render',
    kind: 'render-pipeline',
    value: root.createRenderPipeline({
      vertex,
      fragment,
      targets: { format: 'bgra8unorm' },
    }),
  };
}
