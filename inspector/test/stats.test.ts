import { describe, expect, it } from 'vitest';
import { summarizeCalls } from '../src/browser/gpuRecorder.ts';
import type { RecordedGpuCall } from '../src/types.ts';

describe('summarizeCalls', () => {
  it('counts pipelines, shader modules, explicit layouts, catch-all layouts, and bindings', () => {
    const calls: RecordedGpuCall[] = [
      call(1, 'device.createShaderModule', { code: '@compute fn main() {}' }),
      call(2, 'device.createComputePipeline', {}),
      call(3, 'device.createBindGroupLayout', {
        label: 'explicit',
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
          { binding: 1, visibility: 6, buffer: { type: 'read-only-storage' } },
        ],
      }),
      call(4, 'device.createBindGroupLayout', {
        label: 'pipeline - Automatic Bind Group & Layout',
        entries: [{ binding: 0, visibility: 7, sampler: { type: 'filtering' } }],
      }),
      call(5, 'device.createRenderPipeline', {}),
    ];

    expect(summarizeCalls(calls)).toEqual({
      shaderModuleCount: 1,
      computePipelineCount: 1,
      renderPipelineCount: 1,
      pipelineCount: 2,
      bindGroupLayoutCount: 2,
      explicitBindGroupLayoutCount: 1,
      inferredCatchallBindGroupLayoutCount: 1,
      bindingCounts: {
        total: 3,
        byResourceType: {
          'buffer:uniform': 1,
          'buffer:read-only-storage': 1,
          'sampler:filtering': 1,
        },
        byVisibility: {
          compute: 3,
          fragment: 2,
          vertex: 1,
        },
      },
      compilationMessageCount: 2,
      compilationErrorCount: 1,
      compilationWarningCount: 1,
      compilationInfoCount: 0,
      compilationMessages: {
        total: 2,
        errorCount: 1,
        warningCount: 1,
        infoCount: 0,
        byType: {
          error: 1,
          warning: 1,
        },
      },
      consoleMessageCount: 0,
      consoleWarningCount: 0,
      consoleErrorCount: 0,
      consoleInfoCount: 0,
      consoleDebugCount: 0,
      consoleMessages: {
        total: 0,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
        byType: {},
      },
    });
  });
});

function call(id: number, name: string, descriptor: unknown): RecordedGpuCall {
  return {
    id,
    name,
    ok: true,
    startedAtMs: 0,
    durationMs: 0,
    descriptor,
    compilationMessages:
      name === 'device.createShaderModule'
        ? [
            { type: 'warning', message: 'conversion warning' },
            { type: 'error', message: 'syntax error' },
          ]
        : undefined,
  };
}
