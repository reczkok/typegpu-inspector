import { Buffer } from 'node:buffer';
import type {
  InspectReportOptions,
  RecordedGpuCall,
  TypeGpuInspectionReport,
  TypeGpuTargetReport,
} from './types.ts';
import { omitUndefined } from './shared.ts';

export type NormalizedReportOptions = {
  verbosity: NonNullable<InspectReportOptions['verbosity']>;
  includeWgsl: boolean;
  includeCalls: boolean;
  diagnosticsOnly: boolean;
  maxWgslBytes?: number | undefined;
};

export function formatInspectionReport(
  report: TypeGpuInspectionReport,
  options: InspectReportOptions = {},
): unknown {
  const normalized = normalizeReportOptions(options);

  if (normalized.diagnosticsOnly) {
    return createDiagnosticsReport(report);
  }

  if (normalized.verbosity === 'full') {
    return createFullReport(report, normalized);
  }

  if (normalized.verbosity === 'normal') {
    return createNormalReport(report, normalized);
  }

  return createSummaryReport(report, normalized);
}

export function normalizeReportOptions(options: InspectReportOptions): NormalizedReportOptions {
  const verbosity = options.verbosity ?? 'summary';
  const diagnosticsOnly = options.diagnosticsOnly ?? false;

  return {
    verbosity,
    diagnosticsOnly,
    includeWgsl: diagnosticsOnly ? false : (options.includeWgsl ?? verbosity === 'full'),
    includeCalls: diagnosticsOnly ? false : (options.includeCalls ?? verbosity === 'full'),
    maxWgslBytes:
      options.maxWgslBytes === undefined ? undefined : Math.max(0, options.maxWgslBytes),
  };
}

function createSummaryReport(
  report: TypeGpuInspectionReport,
  options: NormalizedReportOptions,
) {
  return omitUndefined({
    ok: report.ok,
    ledger: report.ledger,
    causes: report.causes,
    moduleImport: report.moduleImport,
    summary: {
      targetCount: report.targets.length,
      passedTargetCount: report.targets.filter((target) => target.ok).length,
      failedTargetCount: report.targets.filter((target) => !target.ok).length,
      assumedTargetCount: report.targets.filter((target) =>
        target.outcome === 'passed-with-assumptions'
      ).length,
      unsupportedTargetCount: report.targets.filter((target) =>
        target.outcome === 'unsupported'
      ).length,
      blockedTargetCount: report.targets.filter((target) =>
        target.outcome === 'blocked'
      ).length,
      gpuType: report.environment.gpuType,
      browserVersion: report.environment.browserVersion,
      shaderModuleCount: report.stats.shaderModuleCount,
      pipelineCount: report.stats.pipelineCount,
      computePipelineCount: report.stats.computePipelineCount,
      renderPipelineCount: report.stats.renderPipelineCount,
      bindGroupLayoutCount: report.stats.bindGroupLayoutCount,
      compilationErrorCount: report.stats.compilationErrorCount,
      compilationWarningCount: report.stats.compilationWarningCount,
      consoleErrorCount: report.stats.consoleErrorCount,
      consoleWarningCount: report.stats.consoleWarningCount,
      pageErrorCount: report.pageErrors.length,
      omittedCallCount: readOmittedCallCount(report),
      totalMs: report.stats.timings?.totalMs,
    },
    targets: report.targets.map((target) => summarizeTarget(target, options)),
    console: report.console.length > 0 ? report.console : undefined,
    pageErrors: report.pageErrors.length > 0 ? report.pageErrors : undefined,
    calls: options.includeCalls ? formatCalls(report.calls, options) : undefined,
  });
}

function createNormalReport(
  report: TypeGpuInspectionReport,
  options: NormalizedReportOptions,
) {
  return omitUndefined({
    ok: report.ok,
    ledger: report.ledger,
    causes: report.causes,
    moduleImport: report.moduleImport,
    environment: report.environment,
    targets: report.targets.map((target) => describeTarget(target, options)),
    stats: report.stats,
    console: report.console,
    pageErrors: report.pageErrors,
    omittedCallCount: readOmittedCallCount(report),
    calls: options.includeCalls ? formatCalls(report.calls, options) : undefined,
  });
}

function readOmittedCallCount(report: TypeGpuInspectionReport): number | undefined {
  return report.omittedCallCount !== undefined && report.omittedCallCount > 0
    ? report.omittedCallCount
    : undefined;
}

function createFullReport(
  report: TypeGpuInspectionReport,
  options: NormalizedReportOptions,
) {
  return omitUndefined({
    ...report,
    targets: report.targets.map((target) => formatTargetWgsl(target, options)),
    calls: options.includeCalls ? formatCalls(report.calls, options) : undefined,
  });
}

function createDiagnosticsReport(report: TypeGpuInspectionReport) {
  return {
    ok: isDiagnosticsOk(report),
    ledger: report.ledger,
    causes: report.causes,
    moduleImport: report.moduleImport,
    environment: {
      gpuType: report.environment.gpuType,
      browserVersion: report.environment.browserVersion,
      requestedFeatures: report.environment.requestedFeatures,
      enabledFeatures: report.environment.enabledFeatures,
    },
    diagnostics: {
      compilationMessageCount: report.stats.compilationMessageCount,
      compilationErrorCount: report.stats.compilationErrorCount,
      compilationWarningCount: report.stats.compilationWarningCount,
      consoleMessageCount: report.stats.consoleMessageCount,
      consoleErrorCount: report.stats.consoleErrorCount,
      consoleWarningCount: report.stats.consoleWarningCount,
      pageErrorCount: report.pageErrors.length,
      moduleImport: report.moduleImport,
    },
    targets: report.targets.map((target) =>
      omitUndefined({
        label: target.label,
        kind: target.kind,
        ok: target.ok,
        outcome: target.outcome,
        causeId: target.causeId,
        error: target.error,
        diagnostics: target.diagnostics,
        ledger: target.ledger,
        compilationSummary: target.compilationSummary,
        compilationMessages:
          target.compilationMessages.length > 0 ? target.compilationMessages : undefined,
      }),
    ),
    console: report.console,
    pageErrors: report.pageErrors,
  };
}

function isDiagnosticsOk(report: TypeGpuInspectionReport): boolean {
  return (
    report.ok &&
    report.stats.compilationErrorCount === 0 &&
    report.stats.consoleErrorCount === 0 &&
    report.pageErrors.length === 0 &&
    report.targets.every((target) => target.ok)
  );
}

function summarizeTarget(
  target: TypeGpuTargetReport,
  options: NormalizedReportOptions,
) {
  return omitUndefined({
    label: target.label,
    kind: target.kind,
    ok: target.ok,
    outcome: target.outcome,
    causeId: target.causeId,
    error: target.error,
    diagnostics: target.diagnostics,
    ledger: target.ledger,
    resource: target.resource,
    bindGroupLayouts: target.bindGroupLayouts,
    wgslSize: target.wgslSize,
    resolutionMs: target.resolutionMs,
    pipelineCreation: target.pipelineCreation,
    compilationSummary: target.compilationSummary,
    compilationMessages:
      target.compilationMessages.length > 0 ? target.compilationMessages : undefined,
    wgsl: options.includeWgsl ? formatWgsl(target.wgsl, options) : undefined,
  });
}

function describeTarget(
  target: TypeGpuTargetReport,
  options: NormalizedReportOptions,
) {
  return omitUndefined({
    ...summarizeTarget(target, options),
    callIds: target.callIds,
  });
}

function formatTargetWgsl(
  target: TypeGpuTargetReport,
  options: NormalizedReportOptions,
): TypeGpuTargetReport {
  const { wgsl, ...rest } = target;
  return omitUndefined({
    ...rest,
    wgsl: options.includeWgsl ? formatWgsl(wgsl, options) : undefined,
  }) as TypeGpuTargetReport;
}

export function formatCalls(
  calls: RecordedGpuCall[],
  options: NormalizedReportOptions,
): RecordedGpuCall[] {
  // In-page serialization can cap long arrays and replace the tail with a
  // structural `{ __truncated: n }` sentinel. Spreading a non-record entry
  // (an older string sentinel, a hole) would produce an object of numeric
  // character keys, so anything that is not a record is dropped here.
  return (calls as unknown[]).flatMap((call) => {
    if (!isRecordLike(call)) {
      return [];
    }
    return [
      omitUndefined({
        ...call,
        descriptor: formatCallDescriptor(
          (call as RecordedGpuCall).descriptor,
          options,
        ),
      }) as RecordedGpuCall,
    ];
  });
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatCallDescriptor(
  value: unknown,
  options: NormalizedReportOptions,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => formatCallDescriptor(entry, options, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'code' && typeof nestedValue === 'string') {
      out[key] = options.includeWgsl
        ? formatWgsl(nestedValue, options)
        : `[WGSL omitted: ${byteLength(nestedValue)} bytes]`;
    } else {
      out[key] = formatCallDescriptor(nestedValue, options, seen);
    }
  }
  return out;
}

function formatWgsl(
  wgsl: string | undefined,
  options: NormalizedReportOptions,
): string | undefined {
  if (wgsl === undefined) {
    return undefined;
  }

  if (options.maxWgslBytes === undefined || byteLength(wgsl) <= options.maxWgslBytes) {
    return wgsl;
  }

  const truncated = truncateUtf8(wgsl, options.maxWgslBytes);
  const omittedBytes = byteLength(wgsl) - byteLength(truncated);
  return `${truncated}\n/* ... truncated ${omittedBytes} bytes; increase maxWgslBytes to include more WGSL ... */`;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  let usedBytes = 0;
  let endIndex = 0;

  for (const char of value) {
    const charBytes = byteLength(char);
    if (usedBytes + charBytes > maxBytes) {
      break;
    }
    usedBytes += charBytes;
    endIndex += char.length;
  }

  return value.slice(0, endIndex);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
