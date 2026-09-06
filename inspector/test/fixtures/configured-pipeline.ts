import { d, tgpu } from 'typegpu';

const values = tgpu.accessor(d.arrayOf(d.vec4f)).$name('values');
const compute = tgpu.computeFn({ workgroupSize: [1] })(() => {
  'use gpu';
  if (values.$[0].x > 0) return;
});

const root = await tgpu.init();
const storage = root.createReadonly(d.arrayOf(d.vec4f, 1), [d.vec4f(1)]);
export const configuredPipeline = root.with(values, storage).createComputePipeline({ compute });
