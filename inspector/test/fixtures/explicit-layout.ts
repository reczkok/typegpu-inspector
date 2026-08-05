// @ts-nocheck
export async function inspect({ root, tgpu, d }) {
  const layout = tgpu
    .bindGroupLayout({
      values: { storage: d.arrayOf(d.f32), access: 'readonly' },
    })
    .$idx(2);

  const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
    'use gpu';
    const _first = layout.$.values[0];
  });

  const buffer = root.createBuffer(d.arrayOf(d.f32, 4)).$usage('storage');

  return {
    label: 'explicit layout',
    kind: 'compute-pipeline',
    value: root.createComputePipeline({ compute: main }).with(
      root.createBindGroup(layout, {
        values: buffer,
      }),
    ),
  };
}
