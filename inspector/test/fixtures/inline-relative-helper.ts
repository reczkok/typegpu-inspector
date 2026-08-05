// @ts-nocheck
import tgpu, { d, std } from 'typegpu';

export const relativeHelper = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return std.cos(0);
});
