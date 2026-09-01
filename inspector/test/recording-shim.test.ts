import { describe, expect, it } from 'vitest';
import { buildRecordingShimModule } from '../src/inspect/recordingShim.ts';

describe('buildRecordingShimModule', () => {
  const code = buildRecordingShimModule('/some/project/node_modules/typegpu/index.js');

  it('re-exports the real package through an /@fs/ url, never the bare specifier', () => {
    expect(code).toContain('export * from "/@fs//some/project/node_modules/typegpu/index.js"');
    expect(code).toContain('import __typegpuMcpRealDefault from "/@fs/');
    // A bare 'typegpu' import would re-enter the alias and recurse.
    expect(code).not.toMatch(/from\s+["']typegpu["']/);
  });

  it('exports wrapped default and named tgpu entrypoints', () => {
    expect(code).toContain('export default __typegpuMcpTgpu');
    expect(code).toContain(
      'export const tgpu = __typegpuMcpWrapTgpu(__typegpuMcpRealNamespace.tgpu)',
    );
    expect(code).toContain("if (property === 'init')");
    expect(code).toContain("if (property === 'initFromDevice')");
  });

  it('records into the per-page registry with a freeze switch and fail-soft pushes', () => {
    expect(code).toContain('globalThis.__typegpuMcpRecording ??=');
    expect(code).toContain('if (__typegpuMcpRegistry.frozen) return;');
    for (const method of [
      'with',
      'createComputePipeline',
      'createRenderPipeline',
      'createGuardedComputePipeline',
      'createUniform',
      'pipe',
    ]) {
      expect(code).toContain(`${method}(target, pairs, args)`);
    }
  });

  it('follows pipe: records the transform bindings and re-wraps the returned branch', () => {
    expect(code).toContain('if (Array.isArray(result?.bindings)) added = result.bindings;');
    expect(code).toContain('return __typegpuMcpWrapRoot(branch, [...pairs, ...addedPairs]);');
  });

  it('never wraps recorded values, only root/branch objects', () => {
    // Pipelines and uniforms are pushed as returned by the real API.
    expect(code).toContain('const pipeline = target.createComputePipeline(...args);');
    expect(code).toContain('return pipeline;');
    expect(code).toContain('const uniform = target.createUniform(...args);');
    expect(code).toContain('return uniform;');
  });
});
