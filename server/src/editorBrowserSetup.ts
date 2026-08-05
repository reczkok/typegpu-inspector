export const QUIESCENT_EDITOR_BROWSER_SETUP = [
  // Browser-oriented examples commonly start their render loop at import
  // time. Preserve synchronous resource construction, but prevent application
  // work from racing the inspector's per-target WebGPU validation scopes.
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
