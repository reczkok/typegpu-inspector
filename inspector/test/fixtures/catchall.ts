// @ts-nocheck
export async function inspect({ root, tgpu, d }) {
  const value = root.createUniform(d.u32, 7);
  const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
    'use gpu';
    const _copy = value.$;
  });

  return {
    label: 'catchall',
    kind: 'compute-pipeline',
    value: root.createComputePipeline({ compute: main }),
  };
}
