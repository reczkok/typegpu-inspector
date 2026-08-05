// @ts-nocheck
import tgpu, { d } from 'typegpu';

export const badWgsl = tgpu.fn([], d.f32)`() {
  return definitely_missing_symbol;
}`;
