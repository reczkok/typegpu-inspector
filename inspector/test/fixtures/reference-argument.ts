import { d } from 'typegpu';

export const Vector = d.vec4f;
export function readReference(value: d.v4f): number {
  'use gpu';
  const reference = d.ref(value);
  return reference.$.x;
}

export function incrementReference(value: d.ref<number>): number {
  'use gpu';
  value.$ += 1;
  return value.$;
}
