import { execFileSync } from 'node:child_process';
import { d, tgpu } from 'typegpu';

export const nodeOnly = execFileSync;
export const shade = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return d.f32(1);
});
