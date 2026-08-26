// @ts-nocheck
import { tgpu, d } from 'typegpu';

// Private, default-less, never bound anywhere in the module: nothing for the
// inspector to harvest, so the consumer below must fail with the improved
// slot-binding-required diagnostic while its sibling still succeeds.
const mysterySlot = tgpu.slot();

const consumeMystery = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return mysterySlot.$;
});

const healthyHelper = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return 2;
});

export async function inspect() {
  return [
    { label: 'unbindable slot consumer', kind: 'resolvable', value: consumeMystery },
    { label: 'sibling', kind: 'resolvable', value: healthyHelper },
  ];
}
