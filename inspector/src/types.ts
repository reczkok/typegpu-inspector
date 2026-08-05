import type { z } from 'zod';
import type {
  agentInspectionInputObjectSchema,
  listTypegpuExportsInputObjectSchema,
  moduleInputObjectSchema,
  resolveTypegpuContextInputObjectSchema,
  reportOptionsObjectSchema,
  staticAssetRouteSchema,
  symbolBindingSchema,
  symbolInputObjectSchema,
  symbolTargetSchema,
  targetKindSchema,
} from './mcpSchemas.ts';
import type { PackageResolutionOptions } from './inspect/paths.ts';

export type InspectReportOptions = z.input<typeof reportOptionsObjectSchema>;

export type StaticAssetRoute = z.input<typeof staticAssetRouteSchema>;

export type InspectTypegpuModuleInput = z.input<typeof moduleInputObjectSchema> & {
  reuseBrowser?: boolean | undefined;
  dependencyResolution?: PackageResolutionOptions | undefined;
};

export type TypegpuSymbolBinding = z.input<typeof symbolBindingSchema>;

export type TypegpuSymbolTarget = z.input<typeof symbolTargetSchema>;

export type InspectTypegpuSymbolsInput = z.input<typeof symbolInputObjectSchema> & {
  reuseBrowser?: boolean | undefined;
  dependencyResolution?: PackageResolutionOptions | undefined;
};

export type AgentInspectionInput = z.input<typeof agentInspectionInputObjectSchema>;

export type ResolveTypegpuContextInput = z.input<typeof resolveTypegpuContextInputObjectSchema>;

export type ListTypegpuExportsInput = z.input<typeof listTypegpuExportsInputObjectSchema>;

export type BrowserInspectRequest = Required<
  Pick<InspectTypegpuModuleInput, 'exportName' | 'timeoutMs' | 'features' | 'strictNames' | 'autoBind'>
> & {
  moduleUrl: string;
  sourceKind: 'modulePath' | 'inlineCode';
  diagnosticsOnly: boolean;
  typegpuVersion?: string | undefined;
  documentHtml?: string | undefined;
  browserSetup?: string | undefined;
  /** In-page serialization budget for WGSL/code fields. */
  maxWgslBytes?: number | undefined;
};

export type InspectionTargetKind = z.input<typeof targetKindSchema>;

export type SerializedError = {
  name?: string | undefined;
  message: string;
  stack?: string | undefined;
  cause?: unknown;
};

export type TargetDiagnostic = {
  code: string;
  message: string;
  hint?: string | undefined;
  valueSummary?: unknown;
  /**
   * 'note' marks context about how inspection was set up rather than an
   * explanation of a failure. Consumers must not present notes as the reason
   * a target failed. Absent severity means failure-explaining.
   */
  severity?: 'note' | 'error' | undefined;
};

export type RequirementKind =
  | 'slot-value'
  | 'argument-values'
  | 'vertex-attribs'
  | 'fragment-targets'
  | 'pipeline-descriptor'
  | 'dom-setup'
  | 'media-stream'
  | 'static-asset'
  | 'module-load'
  | 'device-session'
  | 'dependency-resolution';

export type InspectionTier = 'environment' | 'module' | 'target' | 'resource';

export type TargetOutcome =
  | 'passed'
  | 'passed-with-assumptions'
  | 'failed'
  | 'unsupported'
  | 'blocked';

export type ProviderId =
  | 'user-explicit'
  | 'recorded-app-bindings'
  | 'module-scope'
  | 'import-scope'
  | 'importer-scope'
  | 'synthesis'
  | 'browser-native'
  | 'project-toolchain'
  | 'bundled-fallback';

/**
 * One record of the requirement engine's provenance ledger: something the
 * target needed that the inspector satisfied (and from where) or could not.
 * The serialization-safe projection of engine activity — reports carry these
 * so nothing the inspector fabricates is invisible.
 */
export type LedgerEntry = {
  /** Lifecycle tier that owned this decision. Optional for older reports. */
  tier?: InspectionTier | undefined;
  kind: RequirementKind;
  key: string;
  status: 'satisfied' | 'unsatisfied';
  discoveredBy: 'shape' | 'failure';
  provider?: ProviderId | undefined;
  provenance?: string | undefined;
  detail?: Record<string, unknown> | undefined;
  valueSummary?: unknown;
};

/** One failure shared by every target that it prevented from running. */
export type InspectionCause = {
  id: string;
  tier: Extract<InspectionTier, 'environment' | 'module'>;
  code: string;
  message: string;
  error?: SerializedError | undefined;
  diagnostics?: TargetDiagnostic[] | undefined;
  ledger?: LedgerEntry[] | undefined;
};

export type ShaderCompilationMessage = {
  type: string;
  message: string;
  lineNum?: number | undefined;
  linePos?: number | undefined;
  offset?: number | undefined;
  length?: number | undefined;
};

export type CompilationMessageStats = {
  total: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  byType: Record<string, number>;
};

export type RecordedGpuCall = {
  id: number;
  name: string;
  ok: boolean;
  startedAtMs: number;
  durationMs: number;
  descriptor?: unknown;
  resultId?: string | undefined;
  error?: SerializedError | undefined;
  compilationMessages?: ShaderCompilationMessage[] | undefined;
  targetLabel?: string | undefined;
  targetKind?: InspectionTargetKind | undefined;
};

export type BindingStats = {
  total: number;
  byResourceType: Record<string, number>;
  byVisibility: Record<string, number>;
};

export type InspectionTimings = {
  totalMs: number;
  sessionReused?: boolean | undefined;
  prepareInputMs?: number | undefined;
  startViteMs?: number | undefined;
  acquireBrowserMs?: number | undefined;
  openPageMs?: number | undefined;
  loadHarnessMs?: number | undefined;
  browserInspectionMs?: number | undefined;
};

export type InspectionStats = {
  shaderModuleCount: number;
  computePipelineCount: number;
  renderPipelineCount: number;
  pipelineCount: number;
  bindGroupLayoutCount: number;
  explicitBindGroupLayoutCount: number;
  inferredCatchallBindGroupLayoutCount: number;
  bindingCounts: BindingStats;
  compilationMessageCount: number;
  compilationErrorCount: number;
  compilationWarningCount: number;
  compilationInfoCount: number;
  compilationMessages: CompilationMessageStats;
  consoleMessageCount: number;
  consoleWarningCount: number;
  consoleErrorCount: number;
  consoleInfoCount: number;
  consoleDebugCount: number;
  consoleMessages: CompilationMessageStats;
  timings?: InspectionTimings | undefined;
};

export type TypeGpuTargetReport = {
  label: string;
  kind: InspectionTargetKind;
  ok: boolean;
  /** Rich disposition; `ok` remains for backwards compatibility. */
  outcome?: TargetOutcome | undefined;
  /** Shared run-level cause when this target never got a chance to execute. */
  causeId?: string | undefined;
  error?: SerializedError | undefined;
  diagnostics?: TargetDiagnostic[] | undefined;
  wgsl?: string | undefined;
  wgslSize?: number | undefined;
  /** Set when `wgsl` was cut by the in-page serialization budget. */
  wgslTruncated?: boolean | undefined;
  resolutionMs?: number | undefined;
  /** Provenance ledger: everything the engine satisfied or could not. */
  ledger?: LedgerEntry[] | undefined;
  resource?: TypeGpuResourceReport | undefined;
  /** Bind group layouts discovered while resolving this target's WGSL. */
  bindGroupLayouts?: TypeGpuBindGroupLayoutReport[] | undefined;
  compilationMessages: ShaderCompilationMessage[];
  compilationSummary: CompilationMessageStats;
  pipelineCreation?: {
    attempted: boolean;
    ok: boolean;
    callIds: number[];
  };
  callIds: number[];
};

export type TypeGpuBindGroupLayoutReport = {
  group: number;
  label?: string | undefined;
  source: 'resolution';
  entries: Array<{
    binding: number;
    name?: string | undefined;
    visibility: string[];
    /** Descriptor-shaped resource metadata (`buffer`, `texture`, etc.). */
    resource: Record<string, unknown>;
  }>;
};

export type TypeGpuResourceReport = {
  resourceType: string;
  count?: number | undefined;
  schema?: TypeGpuSchemaReport | undefined;
  sizeBytes?: number | undefined;
  alignmentBytes?: number | undefined;
  usages?: string[] | undefined;
  properties?: Record<string, unknown> | undefined;
  bindings?: Array<Record<string, unknown>> | undefined;
  attributes?: Array<Record<string, unknown>> | undefined;
  itemNames?: string[] | undefined;
  items?: TypeGpuResourceReport[] | undefined;
};

export type TypeGpuSchemaReport = {
  type: string;
  sizeBytes?: number | undefined;
  alignmentBytes?: number | undefined;
  fieldCount?: number | undefined;
  elementCount?: number | undefined;
  elementStrideBytes?: number | undefined;
  element?: TypeGpuSchemaReport | undefined;
  /** Wrapped schema for decorated and atomic TypeGPU data types. */
  inner?: TypeGpuSchemaReport | undefined;
  fields?: Array<{
    name: string;
    offsetBytes?: number | undefined;
    schema: TypeGpuSchemaReport;
  }> | undefined;
  properties?: Record<string, unknown> | undefined;
};

export type TypeGpuInspectionReport = {
  ok: boolean;
  /** Cross-target provenance for environment and module decisions. */
  ledger?: LedgerEntry[] | undefined;
  /** Run-level failures referenced by blocked target reports. */
  causes?: InspectionCause[] | undefined;
  moduleImport?: {
    sourceKind: 'modulePath' | 'inlineCode';
    moduleImported: boolean;
    inspectExportFound: boolean;
    importOnly: boolean;
    exportName: string;
  } | undefined;
  environment: {
    userAgent?: string | undefined;
    browserVersion?: string | undefined;
    adapterInfo?: unknown;
    gpuType?: 'hardware' | 'software' | 'unknown' | undefined;
    requestedFeatures: string[];
    enabledFeatures: string[];
    typegpuVersion?: string | undefined;
    limits?: Record<string, number> | undefined;
  };
  targets: TypeGpuTargetReport[];
  stats: InspectionStats;
  calls: RecordedGpuCall[];
  /** Number of recorded GPU calls dropped by the in-page reporting cap. */
  omittedCallCount?: number | undefined;
  console: Array<{ type: string; text: string; count?: number | undefined }>;
  pageErrors: string[];
};

export type BrowserInspectResult = Omit<TypeGpuInspectionReport, 'environment'> & {
  environment: Omit<TypeGpuInspectionReport['environment'], 'browserVersion'>;
};
