/**
 * Stubs frame scheduling, queue submits, and pipeline draw/dispatch before the
 * module is imported; an import-time render loop would otherwise lose the
 * WebGPU device during validation.
 */
export const QUIESCENT_BROWSER_SETUP = [
  'window.requestAnimationFrame = () => 0;',
  'window.cancelAnimationFrame = () => {};',
  'window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };',
  'Object.getPrototypeOf(device.queue).submit = () => {};',
  'const __typegpuEditorNoop = () => {};',
  'const __typegpuEditorCompute = tgpu.computeFn({ workgroupSize: [1] })(() => { "use gpu"; });',
  'const __typegpuEditorComputePipeline = root.createComputePipeline({ compute: __typegpuEditorCompute });',
  'for (const method of ["dispatchWorkgroups", "dispatchWorkgroupsIndirect", "initSync"]) Object.getPrototypeOf(__typegpuEditorComputePipeline)[method] = __typegpuEditorNoop;',
  'Object.getPrototypeOf(__typegpuEditorComputePipeline).initAsync = async () => {};',
  'const __typegpuEditorGuardedPipeline = root.createGuardedComputePipeline(() => { "use gpu"; });',
  'for (const method of ["dispatchThreads", "initSync"]) Object.getPrototypeOf(__typegpuEditorGuardedPipeline)[method] = __typegpuEditorNoop;',
  'Object.getPrototypeOf(__typegpuEditorGuardedPipeline).initAsync = async () => {};',
  'const __typegpuEditorFragment = tgpu.fragmentFn({ out: d.vec4f })(() => { "use gpu"; return d.vec4f(); });',
  'const __typegpuEditorRenderPipeline = root.createRenderPipeline({ vertex: common.fullScreenTriangle, fragment: __typegpuEditorFragment });',
  'for (const method of ["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect", "initSync"]) Object.getPrototypeOf(__typegpuEditorRenderPipeline)[method] = __typegpuEditorNoop;',
  'Object.getPrototypeOf(__typegpuEditorRenderPipeline).initAsync = async () => {};',
].join('\n');

/** Default for the `quiescent` runtime option across every entrypoint. */
export const DEFAULT_QUIESCENT = true;

/** Caller setup runs after the prologue, so it can restore individual stubs. */
export function composeBrowserSetup(
  browserSetup: string | undefined,
  quiescent: boolean,
): string | undefined {
  if (!quiescent) {
    return browserSetup;
  }
  return browserSetup === undefined
    ? QUIESCENT_BROWSER_SETUP
    : `${QUIESCENT_BROWSER_SETUP}\n${browserSetup}`;
}
