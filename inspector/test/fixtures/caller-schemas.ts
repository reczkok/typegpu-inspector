import { d, tgpu } from 'typegpu';
const isPinned = (index: number) => { 'use gpu'; return index <= 32 && index % 8 === 0; };
const identity = (value: number) => { 'use gpu'; return value; };
const invalidForFloat = (value: number) => { 'use gpu'; return value & 1; };
const compute = tgpu.computeFn({ workgroupSize: [1], in: { gid: d.builtin.globalInvocationId } })(({ gid }) => {
  'use gpu';
  const index = gid.x;
  isPinned(index);
  identity(d.u32(1));
  identity(d.f32(1));
});
const invalidCompute = tgpu.computeFn({ workgroupSize: [1] })(() => {
  'use gpu';
  invalidForFloat(d.f32(1));
});
