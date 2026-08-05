// @ts-nocheck
export async function inspect({ root, tgpu }) {
  const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
    'use gpu';
  });

  return {
    label: 'success compute',
    kind: 'compute-pipeline',
    value: root.createComputePipeline({ compute: main }),
  };
}
