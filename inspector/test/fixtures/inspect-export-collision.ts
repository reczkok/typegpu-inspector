// @ts-nocheck
// A module that already exports `inspect`, which is the name the browser
// harness looks up on the synthesized module.
import { tgpu, d } from 'typegpu';

const privateHelper = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return 7;
});

export function inspect() {
  return privateHelper;
}
