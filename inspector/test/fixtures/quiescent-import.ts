// @ts-nocheck
import tgpu from 'typegpu';

const applicationRoot = await tgpu.init();
const applicationCompute = tgpu.computeFn({ workgroupSize: [1] })(() => {
  'use gpu';
});

export const applicationPipeline = applicationRoot.createComputePipeline({
  compute: applicationCompute,
});

requestAnimationFrame(() => {
  throw new Error('scheduled animation frame ran during editor inspection');
});

new ResizeObserver(() => {
  throw new Error('resize observer ran during editor inspection');
}).observe(document.body);

applicationPipeline.dispatchWorkgroups(1);
