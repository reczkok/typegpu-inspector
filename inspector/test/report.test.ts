import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  formatCalls,
  formatInspectionReport,
  normalizeReportOptions,
  truncateUtf8,
} from '../src/report.ts';
import {
  MAX_SERIALIZED_LARGE_ARRAY_ENTRIES,
  sanitizeForJson,
} from '../src/browser/gpuRecorder.ts';
import type { RecordedGpuCall, TypeGpuInspectionReport } from '../src/types.ts';

const SAMPLE_WGSL = '@compute @workgroup_size(1) fn main() { let value = 1u; }';

describe('formatInspectionReport', () => {
  it('returns a compact summary by default', () => {
    const report = sampleReport();
    report.ledger = [{
      kind: 'dependency-resolution',
      key: 'dependency:typegpu',
      status: 'satisfied',
      discoveredBy: 'shape',
    }];
    report.targets[0]!.ledger = [{
      kind: 'slot-value',
      key: 'slot:test',
      status: 'satisfied',
      discoveredBy: 'shape',
    }];
    report.targets[0]!.resource = { resourceType: 'buffer' };
    report.targets[0]!.bindGroupLayouts = [{ group: 0, source: 'resolution', entries: [] }];
    const formatted = formatInspectionReport(report) as {
      ok: boolean;
      summary: Record<string, unknown>;
      targets: Array<Record<string, unknown>>;
      ledger?: unknown;
      calls?: unknown;
    };

    expect(formatted.ok).toBe(true);
    expect(formatted.summary.pipelineCount).toBe(1);
    expect(formatted.summary.totalMs).toBe(123.4);
    expect(formatted.targets[0]?.wgslSize).toBe(SAMPLE_WGSL.length);
    expect(formatted.targets[0]?.wgsl).toBeUndefined();
    expect(formatted.targets[0]?.ledger).toBeUndefined();
    expect(formatted.targets[0]?.resource).toBeUndefined();
    expect(formatted.targets[0]?.bindGroupLayouts).toBeUndefined();
    expect(formatted.targets[0]?.compilationMessages).toBeUndefined();
    expect(formatted.ledger).toBeUndefined();
    expect(formatted.calls).toBeUndefined();
  });

  it('keeps the compact summary available in normal and full reports', () => {
    const normal = formatInspectionReport(sampleReport(), {
      verbosity: 'normal',
    }) as { summary?: { pipelineCount?: number } };
    const full = formatInspectionReport(sampleReport(), {
      verbosity: 'full',
    }) as { summary?: { pipelineCount?: number } };

    expect(normal.summary?.pipelineCount).toBe(1);
    expect(full.summary?.pipelineCount).toBe(1);
  });

  it('includes and truncates WGSL in full reports', () => {
    const formatted = formatInspectionReport(sampleReport(), {
      verbosity: 'full',
      maxWgslBytes: 40,
    }) as {
      targets: Array<{ wgsl?: string }>;
      calls?: Array<{ descriptor?: { code?: string } }>;
    };

    expect(formatted.targets[0]?.wgsl).toContain('truncated');
    expect(formatted.targets[0]?.wgsl?.startsWith('@compute')).toBe(true);
    expect(Buffer.byteLength(formatted.targets[0]?.wgsl ?? '', 'utf8')).toBeLessThanOrEqual(40);
    expect(formatted.calls?.[0]?.descriptor?.code).toContain('omitted from call descriptor');
  });

  it('only repeats WGSL in call descriptors when explicitly requested', () => {
    const formatted = formatInspectionReport(sampleReport(), {
      verbosity: 'full',
      includeCallWgsl: true,
      maxWgslBytes: 40,
    }) as { calls?: Array<{ descriptor?: { code?: string } }> };

    expect(formatted.calls?.[0]?.descriptor?.code).toContain('truncated');
  });

  it('classifies a TypeGPU resolution failure as a source error', () => {
    const report = sampleReport();
    report.ok = false;
    report.targets[0] = {
      ...report.targets[0]!,
      ok: false,
      error: {
        name: 'Error',
        message: [
          'Resolution of the following tree failed:',
          '- <root>',
          "- fn*:getSliderNormal(vec3f): 'position.z = absZ' is invalid, because non-pointer arguments cannot be mutated.",
        ].join('\n'),
        cause: { __object: 'WgslTypeError' },
      },
    };
    const formatted = formatInspectionReport(report) as {
      targets: Array<{ failureCategory?: string }>;
    };
    expect(formatted.targets[0]?.failureCategory).toBe('source');
  });

  it('classifies failures and hides browser stacks outside full output', () => {
    const report = sampleReport();
    report.ok = false;
    report.targets[0] = {
      ...report.targets[0]!,
      ok: false,
      error: {
        message: 'Pipeline validation failed near setTimeout cleanup.',
        stack: 'Error: Pipeline validation failed.\n    at http://generated.test/harness.js:1:1',
      },
      pipelineCreation: { attempted: true, ok: false, callIds: [1] },
    };
    report.pageErrors = [
      'Error: Pipeline validation failed.\n    at http://generated.test/harness.js:1:1',
    ];

    const compact = formatInspectionReport(report) as {
      targets: Array<{ failureCategory?: string; error?: { stack?: string } }>;
      pageErrors: string[];
    };
    const full = formatInspectionReport(report, { verbosity: 'full' }) as {
      targets: Array<{ error?: { stack?: string } }>;
      pageErrors: string[];
    };

    expect(compact.targets[0]?.failureCategory).toBe('webgpu-validation');
    expect(compact.targets[0]?.error?.stack).toBeUndefined();
    expect(compact.pageErrors[0]).toBe('Error: Pipeline validation failed.');
    expect(full.targets[0]?.error?.stack).toContain('generated.test');
    expect(full.pageErrors[0]).toContain('generated.test');
  });

  it('suppresses WGSL and calls for diagnostics-only output', () => {
    const formatted = formatInspectionReport(sampleReport(), {
      diagnosticsOnly: true,
      includeWgsl: true,
      includeCalls: true,
      verbosity: 'full',
    }) as {
      diagnostics: Record<string, unknown>;
      targets: Array<Record<string, unknown>>;
      calls?: unknown;
    };

    expect(formatted.diagnostics.compilationWarningCount).toBe(1);
    expect(formatted.targets[0]?.wgsl).toBeUndefined();
    expect(formatted.calls).toBeUndefined();
  });

  it('reports successful diagnostic-only module imports without requiring targets', () => {
    const report = {
      ...sampleReport(),
      moduleImport: {
        sourceKind: 'modulePath' as const,
        moduleImported: true,
        inspectExportFound: false,
        importOnly: true,
        exportName: 'inspect',
      },
      targets: [],
      stats: {
        ...sampleReport().stats,
        shaderModuleCount: 0,
        computePipelineCount: 0,
        pipelineCount: 0,
        compilationMessageCount: 0,
        compilationWarningCount: 0,
        compilationMessages: {
          total: 0,
          errorCount: 0,
          warningCount: 0,
          infoCount: 0,
          byType: {},
        },
      },
      calls: [],
    };

    const formatted = formatInspectionReport(report, {
      diagnosticsOnly: true,
    }) as {
      ok: boolean;
      moduleImport?: TypeGpuInspectionReport['moduleImport'];
    };

    expect(formatted.ok).toBe(true);
    expect(formatted.moduleImport?.moduleImported).toBe(true);
    expect(formatted.moduleImport?.inspectExportFound).toBe(false);
    expect(formatted.moduleImport?.importOnly).toBe(true);
  });
});

describe('sanitizeForJson code-bearing fields', () => {
  const LONG_WGSL = `${SAMPLE_WGSL}\n${'// filler comment\n'.repeat(4_000)}`;

  it('keeps WGSL and shader-module code intact past the generic string cap', () => {
    expect(LONG_WGSL.length).toBeGreaterThan(16_000);

    const sanitized = sanitizeForJson({
      targets: [{ wgsl: LONG_WGSL, wgslSize: LONG_WGSL.length }],
      calls: [{ id: 1, descriptor: { label: 'sample', code: LONG_WGSL } }],
    }) as {
      targets: Array<{ wgsl: string; wgslTruncated?: boolean }>;
      calls: Array<{ descriptor: { code: string; codeTruncated?: boolean } }>;
    };

    expect(sanitized.targets[0]?.wgsl).toBe(LONG_WGSL);
    expect(sanitized.targets[0]?.wgslTruncated).toBeUndefined();
    expect(sanitized.calls[0]?.descriptor.code).toBe(LONG_WGSL);
    expect(sanitized.calls[0]?.descriptor.codeTruncated).toBeUndefined();
  });

  it('still caps ordinary strings at the generic limit', () => {
    const sanitized = sanitizeForJson({ message: 'x'.repeat(20_000) }) as {
      message: string;
      messageTruncated?: boolean;
    };

    expect(sanitized.message).toContain('[truncated 4000 chars]');
    expect(sanitized.messageTruncated).toBeUndefined();
  });

  it('flags code fields explicitly when the code budget is actually exceeded', () => {
    const sanitized = sanitizeForJson({ wgsl: LONG_WGSL }, new WeakSet(), 0, 8, {
      maxCodeLength: 20_000,
    }) as { wgsl: string; wgslTruncated?: boolean };

    expect(sanitized.wgslTruncated).toBe(true);
    expect(sanitized.wgsl.startsWith(SAMPLE_WGSL)).toBe(true);
    expect(sanitized.wgsl).toContain('[truncated');
  });

  it('lets a large maxWgslBytes still reach the Node-side shaping', () => {
    const report = sampleReport();
    report.targets[0]!.wgsl = LONG_WGSL;
    report.targets[0]!.wgslSize = LONG_WGSL.length;
    report.calls[0]!.descriptor = { label: 'sample', code: LONG_WGSL };

    const transferred = sanitizeForJson(
      report,
      new WeakSet(),
      0,
      16,
    ) as TypeGpuInspectionReport;

    const formatted = formatInspectionReport(transferred, {
      verbosity: 'full',
      maxWgslBytes: 2_000_000,
    }) as { targets: Array<{ wgsl?: string }> };

    expect(formatted.targets[0]?.wgsl).toBe(LONG_WGSL);
    expect(formatted.targets[0]?.wgsl).not.toContain('[truncated');
  });
});

describe('sanitizeForJson array truncation', () => {
  it('uses a structural marker for repeated references', () => {
    const shared = { value: 1 };
    const sanitized = sanitizeForJson({ first: shared, second: shared }) as {
      first: { value: number };
      second: { __repeatedReference: string };
    };

    expect(sanitized.first).toEqual({ value: 1 });
    expect(sanitized.second).toEqual({ __repeatedReference: 'Object' });
  });

  it('uses a structural sentinel rather than a bare string', () => {
    const sanitized = sanitizeForJson({
      entries: Array.from({ length: 90 }, (_, index) => ({ index })),
    }) as { entries: unknown[] };

    expect(sanitized.entries).toHaveLength(81);
    expect(sanitized.entries[80]).toEqual({ __truncated: 10 });
    expect(typeof sanitized.entries[80]).toBe('object');
  });

  it('gives payload arrays a much larger budget than GPU descriptor arrays', () => {
    const makeEntries = () =>
      Array.from({ length: 500 }, (_, index) => ({
        id: index,
        name: 'device.createShaderModule',
      }));
    const sanitized = sanitizeForJson({
      calls: makeEntries(),
      targets: makeEntries(),
      descriptorish: { entries: makeEntries() },
    }) as {
      calls: unknown[];
      targets: unknown[];
      descriptorish: { entries: unknown[] };
    };

    expect(MAX_SERIALIZED_LARGE_ARRAY_ENTRIES).toBeGreaterThan(500);
    expect(sanitized.calls).toHaveLength(500);
    expect(sanitized.targets).toHaveLength(500);
    expect(sanitized.descriptorish.entries).toHaveLength(81);
  });
});

describe('formatCalls', () => {
  const options = normalizeReportOptions({ verbosity: 'full', includeCalls: true });

  it('drops non-record entries instead of spreading them into character keys', () => {
    const formatted = formatCalls(
      [
        {
          id: 1,
          name: 'device.createShaderModule',
          ok: true,
          startedAtMs: 0,
          durationMs: 1,
          descriptor: { code: SAMPLE_WGSL },
        },
        '[... 5 more items]' as unknown as RecordedGpuCall,
        null as unknown as RecordedGpuCall,
      ],
      options,
    );

    expect(formatted).toHaveLength(1);
    expect(formatted[0]?.id).toBe(1);
    expect(Object.keys(formatted[0] ?? {})).not.toContain('0');
  });

  it('passes the structural truncation sentinel through unchanged', () => {
    const formatted = formatCalls(
      [{ __truncated: 5 } as unknown as RecordedGpuCall],
      options,
    );

    expect(formatted).toEqual([{ __truncated: 5 }]);
  });

  it('reports out-of-band omitted call counts', () => {
    const report = {
      ...sampleReport(),
      omittedCallCount: 12,
    } as TypeGpuInspectionReport;

    const formatted = formatInspectionReport(report) as {
      summary: { omittedCallCount?: number };
    };

    expect(formatted.summary.omittedCallCount).toBe(12);
  });
});

describe('truncateUtf8', () => {
  it('never splits a multi-byte character', () => {
    expect(truncateUtf8('héllo', 1)).toBe('h');
    expect(truncateUtf8('héllo', 2)).toBe('h');
    expect(truncateUtf8('héllo', 3)).toBe('hé');

    expect(truncateUtf8('😀😀', 3)).toBe('');
    expect(truncateUtf8('😀😀', 4)).toBe('😀');
    expect(truncateUtf8('😀😀', 7)).toBe('😀');
    expect(truncateUtf8('😀😀', 8)).toBe('😀😀');

    for (const maxBytes of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
      const truncated = truncateUtf8('aé😀b', maxBytes);
      expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(maxBytes);
      expect(truncated).not.toContain('�');
    }
  });

  it('keeps truncated WGSL valid UTF-8 in formatted reports', () => {
    const wgsl = `// 😀😀😀😀\n${SAMPLE_WGSL}`;
    const report = sampleReport();
    report.targets[0]!.wgsl = wgsl;

    const formatted = formatInspectionReport(report, {
      verbosity: 'full',
      maxWgslBytes: 10,
    }) as { targets: Array<{ wgsl?: string }> };

    const truncated = formatted.targets[0]?.wgsl ?? '';
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(10);
    expect(truncated).not.toContain('�');
    expect(truncated).toBe('// /*…*/');
  });
});

function sampleReport(): TypeGpuInspectionReport {
  return {
    ok: true,
    environment: {
      userAgent: 'test-agent',
      browserVersion: 'test-browser',
      adapterInfo: { vendor: 'test' },
      gpuType: 'software',
      requestedFeatures: [],
      enabledFeatures: ['core-features-and-limits'],
      limits: { maxBindGroups: 4 },
    },
    targets: [
      {
        label: 'sample compute',
        kind: 'compute-pipeline',
        ok: true,
        wgsl: SAMPLE_WGSL,
        wgslSize: SAMPLE_WGSL.length,
        compilationMessages: [{ type: 'warning', message: 'sample warning' }],
        compilationSummary: {
          total: 1,
          errorCount: 0,
          warningCount: 1,
          infoCount: 0,
          byType: { warning: 1 },
        },
        pipelineCreation: {
          attempted: true,
          ok: true,
          callIds: [1],
        },
        callIds: [1],
      },
    ],
    stats: {
      shaderModuleCount: 1,
      computePipelineCount: 1,
      renderPipelineCount: 0,
      pipelineCount: 1,
      bindGroupLayoutCount: 0,
      explicitBindGroupLayoutCount: 0,
      inferredCatchallBindGroupLayoutCount: 0,
      bindingCounts: {
        total: 0,
        byResourceType: {},
        byVisibility: {},
      },
      compilationMessageCount: 1,
      compilationErrorCount: 0,
      compilationWarningCount: 1,
      compilationInfoCount: 0,
      compilationMessages: {
        total: 1,
        errorCount: 0,
        warningCount: 1,
        infoCount: 0,
        byType: { warning: 1 },
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
      timings: {
        totalMs: 123.4,
        prepareInputMs: 4.2,
        startViteMs: 20.1,
        acquireBrowserMs: 30,
        openPageMs: 10,
        loadHarnessMs: 25,
        browserInspectionMs: 34.1,
      },
    },
    calls: [
      {
        id: 1,
        name: 'device.createShaderModule',
        ok: true,
        startedAtMs: 0,
        durationMs: 1,
        descriptor: { label: 'sample', code: SAMPLE_WGSL },
        resultId: 'GPUShaderModule#1',
        compilationMessages: [{ type: 'warning', message: 'sample warning' }],
      },
    ],
    console: [],
    pageErrors: [],
  };
}
