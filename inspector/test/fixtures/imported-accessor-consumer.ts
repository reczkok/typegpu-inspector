// @ts-nocheck
import { tgpu, d } from 'typegpu';
import { paramsAccess } from './symbol-targets.ts';

// Consumes an accessor it imports but does NOT re-export: auto-binding must
// harvest it from import scope (the sibling module's namespace).
export const importedAccessorFragment = tgpu.fragmentFn({ out: d.vec4f })(() => {
  'use gpu';
  return paramsAccess.$.tint;
});
