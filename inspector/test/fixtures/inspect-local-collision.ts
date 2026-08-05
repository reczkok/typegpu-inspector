// @ts-nocheck
// A module that declares (but does not export) a top-level `inspect` binding.
// Inlining it must not collide with the synthesized inspection entrypoint.
import tgpu, { d } from 'typegpu';

const inspect = () => 'this is the user\'s own helper';

const privateHelper = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return inspect().length;
});

export const exportedHelper = privateHelper;
