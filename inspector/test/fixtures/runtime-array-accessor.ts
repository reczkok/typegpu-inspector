import { d, tgpu } from 'typegpu';

export const instances = tgpu.accessor(d.arrayOf(d.vec4f)).$name('instances');

export const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
  'use gpu';
  if (instances.$[0].x > 0) return;
});
