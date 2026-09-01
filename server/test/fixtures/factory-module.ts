// @ts-nocheck
import tgpu, { type TgpuRoot } from 'typegpu';
import * as d from 'typegpu/data';

/** Builds its pipeline inside a function, so nothing here is a target on its own. */
export function createRenderer(root: TgpuRoot) {
  const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
    const x = d.f32(1);
  });
  return root.createComputePipeline({ compute: main });
}
