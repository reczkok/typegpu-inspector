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
  includeCallWgsl: boolean;
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
    includeCallWgsl: diagnosticsOnly ? false : (options.includeCallWgsl ?? false),
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
    causes: formatCauses(report.causes, false, true),
    moduleImport: report.moduleImport,
    summary: createReportSummary(report),
    targets: report.targets.map((target) => summarizeTarget(target, options)),
    console: report.console.length > 0 ? report.console : undefined,
    pageErrors: report.pageErrors.length > 0
      ? report.pageErrors.map(compactBrowserError)
      : undefined,
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
    causes: formatCauses(report.causes, false),
    moduleImport: report.moduleImport,
    summary: createReportSummary(report),
    environment: report.environment,
    targets: report.targets.map((target) => describeTarget(target, options)),
    stats: report.stats,
    console: report.console,
    pageErrors: report.pageErrors.map(compactBrowserError),
    omittedCallCount: readOmittedCallCount(report),
    calls: options.includeCalls ? formatCalls(report.calls, options) : undefined,
  });
}

function readOmittedCallCount(report: TypeGpuInspectionReport): number | undefined {
  return report.omittedCallCount !== undefined && report.omittedCallCount > 0
    ? report.omittedCallCount
    : undefined;
}

function createReportSummary(report: TypeGpuInspectionReport) {
  return omitUndefined({
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
  });
}

function createFullReport(
  report: TypeGpuInspectionReport,
  options: NormalizedReportOptions,
) {
  return omitUndefined({
    ...report,
    summary: createReportSummary(report),
    targets: report.targets.map((target) => formatTargetWgsl(target, options)),
    calls: options.includeCalls ? formatCalls(report.calls, options) : undefined,
  });
}

function createDiagnosticsReport(report: TypeGpuInspectionReport) {
  return {
    ok: isDiagnosticsOk(report),
    causes: formatCauses(report.causes, false, true),
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
    },
    targets: report.targets.map((target) =>
      omitUndefined({
        label: target.label,
        kind: target.kind,
        ok: target.ok,
        outcome: target.outcome,
        causeId: target.causeId,
        error: formatSerializedError(target.error, false),
        failureCategory: inferFailureCategory(target),
        diagnostics: target.diagnostics,
        compilationSummary: target.compilationSummary,
        compilationMessages:
          target.compilationMessages.length > 0 ? target.compilationMessages : undefined,
      }),
    ),
    console: report.console.length > 0 ? report.console : undefined,
    pageErrors: report.pageErrors.length > 0
      ? report.pageErrors.map(compactBrowserError)
      : undefined,
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
  const compact = options.verbosity === 'summary';
  return omitUndefined({
    label: target.label,
    kind: target.kind,
    ok: target.ok,
    outcome: target.outcome,
    causeId: target.causeId,
    error: formatSerializedError(target.error, false),
    failureCategory: inferFailureCategory(target),
    diagnostics: target.diagnostics,
    ledger: compact ? undefined : target.ledger,
    resource: compact ? undefined : target.resource,
    bindGroupLayouts: compact ? undefined : target.bindGroupLayouts,
    wgslSize: target.wgslSize,
    resolutionMs: target.resolutionMs,
    pipelineCreation: target.pipelineCreation,
    compilationSummary: target.compilationSummary,
    compilationMessages: compact
      ? undefined
      : target.compilationMessages.length > 0
      ? target.compilationMessages
      : undefined,
    statementMap: compact ? undefined : target.statementMap,
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
    failureCategory: inferFailureCategory(target),
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
    return {
      __repeatedReference: value.constructor?.name ?? 'Object',
    };
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => formatCallDescriptor(entry, options, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'code' && typeof nestedValue === 'string') {
      out[key] = options.includeWgsl && options.includeCallWgsl
        ? formatWgsl(nestedValue, options)
        : options.includeWgsl
        ? `[WGSL omitted from call descriptor: ${byteLength(nestedValue)} bytes; see target.wgsl or set includeCallWgsl]`
        : `[WGSL omitted: ${byteLength(nestedValue)} bytes]`;
    } else {
      out[key] = formatCallDescriptor(nestedValue, options, seen);
    }
  }
  return out;
}

type FailureCategory =
  | 'source'
  | 'shader-compiler'
  | 'webgpu-validation'
  | 'environment'
  | 'timeout'
  | 'harness';

const TIMEOUT_DIAGNOSTIC_CODES = new Set([
  'inspection-timeout',
  'webgpu-validation-timeout',
]);
const ENVIRONMENT_DIAGNOSTIC_CODES = new Set([
  'browser-capability-unavailable',
  'canvas-dom-setup-required',
  'module-import-failed',
  'webgpu-device-lost',
]);
const SOURCE_DIAGNOSTIC_CODES = new Set([
  'cpu-function-not-inspectable',
  'not-shader-resolvable',
  'plain-object-not-inspectable',
  'reference-wrapper-required',
  'selector-not-resolved',
  'slot-binding-required',
  'unsupported-internal-resource',
  'value-not-inspectable',
  'wrapper-required',
]);

function inferFailureCategory(target: TypeGpuTargetReport): FailureCategory | undefined {
  if (target.ok) return undefined;

  const codes = new Set(
    (target.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.severity !== 'note')
      .map((diagnostic) => diagnostic.code),
  );
  const message = `${target.error?.message ?? ''} ${[...codes].join(' ')}`;
  if (
    [...codes].some((code) => TIMEOUT_DIAGNOSTIC_CODES.has(code)) ||
    /\btime(?:d)?\s*out\b|\btimeout\b/i.test(message)
  ) {
    return 'timeout';
  }
  if ([...codes].some((code) => ENVIRONMENT_DIAGNOSTIC_CODES.has(code))) {
    return 'environment';
  }
  if (target.compilationSummary.errorCount > 0) {
    return 'shader-compiler';
  }
  if (
    (target.pipelineCreation?.attempted && !target.pipelineCreation.ok) ||
    [...codes].some((code) => /webgpu|pipeline-(?:creation|validation)|validation/.test(code))
  ) {
    return 'webgpu-validation';
  }
  if (
    [...codes].some((code) => SOURCE_DIAGNOSTIC_CODES.has(code)) ||
    isResolutionFailure(target.error)
  ) {
    return 'source';
  }
  return 'harness';
}

/** TypeGPU rejected the authored shader code while resolving it to WGSL. */
function isResolutionFailure(error: TypeGpuTargetReport['error']): boolean {
  if (!isRecordLike(error)) return false;
  const message = typeof error.message === 'string' ? error.message : '';
  const cause = isRecordLike(error.cause) ? error.cause : undefined;
  const causeName = typeof cause?.__object === 'string'
    ? cause.__object
    : typeof cause?.name === 'string'
    ? cause.name
    : '';
  return message.includes('Resolution of the following tree failed') ||
    /^Wgsl\w*Error$|^ResolutionError$/.test(causeName) ||
    /^Wgsl\w*Error$|^ResolutionError$/.test(typeof error.name === 'string' ? error.name : '');
}

function formatSerializedError<T>(error: T, includeStack: boolean): T {
  if (includeStack || !isRecordLike(error)) return error;
  const { stack: _stack, ...rest } = error;
  return rest as T;
}

function formatCauses<T>(
  causes: T,
  includeStacks: boolean,
  compact = false,
): T {
  if (!Array.isArray(causes) || includeStacks) return causes;
  return causes.map((cause) => {
    if (!isRecordLike(cause)) return cause;
    const { ledger: _ledger, ...withoutLedger } = cause;
    return {
      ...(compact ? withoutLedger : cause),
      ...(cause.error !== undefined
        ? { error: formatSerializedError(cause.error, false) }
        : {}),
    };
  }) as T;
}

function compactBrowserError(error: string): string {
  const lines = error.split('\n');
  const stackStart = lines.findIndex((line, index) =>
    index > 0 && /^\s*at\s+/.test(line)
  );
  return stackStart < 0 ? error : lines.slice(0, stackStart).join('\n');
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

  const totalBytes = byteLength(wgsl);
  const shortMarker = '/*…*/';
  if (options.maxWgslBytes <= byteLength(shortMarker)) {
    return truncateUtf8(shortMarker, options.maxWgslBytes);
  }

  let marker = `\n/* truncated ${totalBytes} bytes */`;
  if (byteLength(marker) >= options.maxWgslBytes) {
    const body = truncateUtf8(
      wgsl,
      options.maxWgslBytes - byteLength(shortMarker),
    );
    return `${body}${shortMarker}`;
  }

  // The omitted-byte count changes the marker width at decimal boundaries.
  // Recompute until both the prefix and marker fit inside the public byte cap.
  let body = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    body = truncateUtf8(
      wgsl,
      options.maxWgslBytes - byteLength(marker),
    );
    const omittedBytes = totalBytes - byteLength(body);
    const nextMarker = `\n/* truncated ${omittedBytes} bytes */`;
    if (nextMarker === marker) break;
    marker = nextMarker;
  }
  body = truncateUtf8(
    wgsl,
    Math.max(0, options.maxWgslBytes - byteLength(marker)),
  );
  return `${body}${marker}`;
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
