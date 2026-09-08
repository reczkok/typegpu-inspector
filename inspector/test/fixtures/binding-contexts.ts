import { tgpu, d } from 'typegpu';
export const left = tgpu.slot<number>();
export const right = tgpu.slot<number>();
export const helper = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return d.f32(left.$ * 100 + right.$);
});
export const first = helper.with(left, 2).with(right, 7);
export const second = helper.with(left, 4).with(right, 9);
export const incomplete = helper.with(left, 6);
// This supplies the missing slot in another configuration: never mix them.
export const other = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(right.$); }).with(right, 8);

// Shares the slots, but no observed bound function points to this helper.
export const candidateHelper = tgpu.fn([], d.f32)(() => {
  'use gpu'; return d.f32(left.$ * 100 + right.$);
});
