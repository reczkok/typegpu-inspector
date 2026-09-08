import { d, std, tgpu } from 'typegpu';

const State = d.struct({ position: d.vec3f, force: d.vec3f });
export const states = tgpu.mutableAccessor(d.arrayOf(State, 16));
export const velocity = tgpu.mutableAccessor(d.arrayOf(d.vec3f, 16));
export const scale = tgpu.accessor(d.f32);
export const step = tgpu.computeFn({ workgroupSize: [16], in: { gid: d.builtin.globalInvocationId } })(({ gid }) => {
  'use gpu';
  states.$[gid.x].force = std.mul(velocity.$[gid.x], scale.$);
});
export const invalid = tgpu.computeFn({ workgroupSize: [1] })(`{ states[0].force = vec2f(1); }`).$uses({ states });

export const unbounded = tgpu.mutableAccessor(d.arrayOf(d.f32));
export const runtimeArray = tgpu.computeFn({ workgroupSize: [1] })(() => {
  'use gpu';
  unbounded.$[0] = 1;
});
