/**
 * Browser setup that neutralizes an application's import-time frame loop.
 *
 * Browser-oriented TypeGPU modules (docs examples, React entrypoints) commonly
 * start a requestAnimationFrame loop the moment they are imported. Under raw
 * inspection that loop draws to a canvas and submits work while the inspector's
 * per-target validation scopes are open, which takes the WebGPU device down
 * ('webgpu-device-lost') and blocks *every* target of the module. Stubbing the
 * scheduler plus the pipeline dispatch/draw entrypoints keeps synchronous
 * resource construction intact while making the module quiescent.
 *
 * The language server relies on this default (it passes `quiescent: true`
 * and no `browserSetup`), so this string is the single source of the editor
 * prologue.
 */
export const QUIESCENT_BROWSER_SETUP = [
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

/** Default for the `quiescent` runtime option across every entrypoint. */
export const DEFAULT_QUIESCENT = true;

/**
 * Resolves the browser setup actually handed to the page. A caller's own setup
 * is appended after the quiescent prologue so it can override any stub it
 * deliberately wants back.
 */
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
