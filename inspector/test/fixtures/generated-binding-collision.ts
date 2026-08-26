// @ts-nocheck
// A module that happens to declare one of the synthesized top-level bindings.
import { tgpu, d } from 'typegpu';

const __typegpuEditorInspectedModule = { spoofed: true };

const privateHelper = tgpu.fn([], d.f32)(() => {
  'use gpu';
  return __typegpuEditorInspectedModule.spoofed ? 1 : 0;
});

export const exportedHelper = privateHelper;
