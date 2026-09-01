export type HoverDetailLevel = 'wgsl' | 'compact' | 'standard' | 'deep';
export type InlayDetailLevel = 'compact' | 'summary' | 'detailed';
export type LegacyDetailLevel = 'minimal' | 'default' | 'verbose';
export type HoverSectionId =
  | 'wgslPreview'
  | 'shaderFacts'
  | 'bindings'
  | 'datasheet'
  | 'resource'
  | 'schema'
  | 'pipelineState'
  | 'pipelineContext'
  | 'declarations'
  | 'compilerMessages'
  | 'inspectionNotes'
  | 'assumptions'
  | 'runtime';

export type HoverPresentationSettings = {
  sections: Partial<Record<HoverSectionId, 'auto' | 'show' | 'hide'>>;
  sectionOrder: HoverSectionId[];
  /** Widest table a hover renders, in visible characters. */
  maxColumns?: number;
  wgslPreviewLines?: number;
  collectionItems?: number;
  declarations?: number;
  compilerMessages?: number;
  inspectionNotes?: number;
  assumptions?: number;
};

export type InspectorSettings = {
  inspectOn: 'save' | 'hover' | 'save-and-hover' | 'off';
  /**
   * Inspect the first TypeGPU document opened while the runtime is cold, so
   * Chromium/Vite are established without inspecting every restored tab.
   */
  warmUpOnOpen: boolean;
  inspectorPackage: string;
  timeoutMs: number;
  maxWgslBytes: number;
  strictNames: boolean;
  features: string[];
  projectRoot?: string;
  hover: boolean;
  inlayHints: boolean;
  diagnostics: boolean;
  documentLinks: boolean;
  /** Diagnostic → authored-statement mapping (exact on TypeGPU 0.12+, heuristic below). */
  sourceMapping: boolean;
  schemaLayoutHealth: boolean;
  schemaPackingSuggestions: boolean;
  hoverDetailLevel: HoverDetailLevel;
  inlayDetailLevel: InlayDetailLevel;
  hoverPresentation: HoverPresentationSettings;
  /** Deprecated compatibility input, normalized by settings.ts. */
  detailLevel?: LegacyDetailLevel;
};

export const defaultSettings: InspectorSettings = {
  inspectOn: 'save',
  warmUpOnOpen: true,
  inspectorPackage: 'bundled',
  timeoutMs: 45_000,
  maxWgslBytes: 2_000_000,
  strictNames: true,
  features: [],
  hover: true,
  inlayHints: true,
  diagnostics: true,
  documentLinks: true,
  sourceMapping: true,
  schemaLayoutHealth: true,
  schemaPackingSuggestions: true,
  hoverDetailLevel: 'standard',
  inlayDetailLevel: 'compact',
  hoverPresentation: { sections: {}, sectionOrder: [] },
};

export const settingsBounds = {
  timeoutMs: { min: 1_000, max: 600_000 },
  maxWgslBytes: { min: 16_384, max: 64_000_000 },
  maxColumns: { min: 40, max: 200 },
  wgslPreviewLines: { min: 0, max: 400 },
  collectionItems: { min: 1, max: 100 },
  declarations: { min: 1, max: 100 },
  compilerMessages: { min: 1, max: 100 },
  inspectionNotes: { min: 1, max: 50 },
  assumptions: { min: 1, max: 50 },
} as const;

export type CompilerMessage = {
  type: string;
  message: string;
  lineNum?: number;
  linePos?: number;
  offset?: number;
  length?: number;
};

/** Index into a block, or the named child slot of a compound statement. */
export type StatementPathSegment = number | 'then' | 'else' | 'init' | 'update' | 'body';

/**
 * Statement-level map from generated WGSL lines back to the authored
 * `'use gpu'` bodies, recorded by the runtime while TypeGPU generated the
 * code. Runtimes on TypeGPU < 0.12 omit it.
 */
export type InspectorStatementMap = {
  functions: Array<{
    name: string;
    /** 0-based line of the function header in `wgsl`. */
    line: number;
    statements: Array<{
      path: StatementPathSegment[];
      line: number;
      lineCount: number;
    }>;
  }>;
  /** The function and statement whose resolution aborted the target. */
  failure?: {
    fn: string;
    path: StatementPathSegment[];
  };
};

export type InspectorDiagnostic = {
  code: string;
  message: string;
  hint?: string;
  /** 'note' marks setup context that must not be presented as a failure reason. */
  severity?: 'note' | 'error';
};

/**
 * One provenance-ledger record: something the target needed that the
 * inspector satisfied (and from where) or could not. Newer runtimes attach
 * these; older runtimes simply omit the field.
 */
export type InspectorLedgerEntry = {
  tier?: 'environment' | 'module' | 'target' | 'resource';
  kind: string;
  key: string;
  status: 'satisfied' | 'unsatisfied';
  discoveredBy?: 'shape' | 'failure';
  provider?: string;
  provenance?: string;
  detail?: Record<string, unknown>;
};

export type InspectorTargetReport = {
  label: string;
  kind: string;
  ok: boolean;
  outcome?: 'passed' | 'passed-with-assumptions' | 'failed' | 'unsupported' | 'blocked';
  causeId?: string;
  wgsl?: string;
  wgslSize?: number;
  resolutionMs?: number;
  ledger?: InspectorLedgerEntry[];
  resource?: InspectorResourceReport;
  bindGroupLayouts?: Array<{
    group: number;
    label?: string;
    source?: string;
    entries: Array<{
      binding: number;
      name?: string;
      visibility?: string[];
      resource?: Record<string, unknown>;
    }>;
  }>;
  compilationMessages?: CompilerMessage[];
  statementMap?: InspectorStatementMap;
  compilationSummary?: {
    total?: number;
    errorCount?: number;
    warningCount?: number;
    infoCount?: number;
  };
  pipelineCreation?: {
    attempted?: boolean;
    ok?: boolean;
  };
  callIds?: number[];
  diagnostics?: InspectorDiagnostic[];
  error?: unknown;
};

export type InspectorResourceReport = {
  resourceType: string;
  count?: number;
  schema?: InspectorSchemaReport;
  sizeBytes?: number;
  alignmentBytes?: number;
  usages?: string[];
  properties?: Record<string, unknown>;
  bindings?: Array<Record<string, unknown>>;
  attributes?: Array<Record<string, unknown>>;
  itemNames?: string[];
  items?: InspectorResourceReport[];
};

export type InspectorSchemaReport = {
  type: string;
  sizeBytes?: number;
  alignmentBytes?: number;
  fieldCount?: number;
  elementCount?: number;
  elementStrideBytes?: number;
  element?: InspectorSchemaReport;
  /** Wrapped schema for decorated and atomic TypeGPU data types. */
  inner?: InspectorSchemaReport;
  fields?: Array<{
    name: string;
    offsetBytes?: number;
    schema: InspectorSchemaReport;
  }>;
  properties?: Record<string, unknown>;
};

export type RecordedGpuCall = {
  id?: number;
  name?: string;
  ok?: boolean;
  descriptor?: unknown;
  error?: unknown;
  compilationMessages?: Array<{ type?: string; message?: string; lineNum?: number; linePos?: number }>;
  targetLabel?: string;
  targetKind?: string;
};

export type InspectorOutput = {
  ok: boolean;
  causes?: Array<{
    id: string;
    tier: 'environment' | 'module';
    code: string;
    message: string;
    error?: unknown;
  }>;
  summary?: {
    targetCount?: number;
    passedTargetCount?: number;
    failedTargetCount?: number;
    gpuType?: string;
    browserVersion?: string;
    shaderModuleCount?: number;
    pipelineCount?: number;
    computePipelineCount?: number;
    renderPipelineCount?: number;
    bindGroupLayoutCount?: number;
    compilationErrorCount?: number;
    compilationWarningCount?: number;
    totalMs?: number;
  };
  targets?: InspectorTargetReport[];
  stats?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  calls?: RecordedGpuCall[];
  console?: Array<{ type?: string; text?: string; count?: number }>;
  pageErrors?: string[];
  warnings?: string[];
  error?: unknown;
  nextActions?: string[];
};
