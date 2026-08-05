import { z } from 'zod';
import { DEFAULT_INSPECTION_TIMEOUT_MS } from './shared.ts';

export const targetKindSchema = z.enum([
  'compute-pipeline',
  'render-pipeline',
  'resolvable',
  'resource',
]);

export const staticAssetRouteSchema = z.object({
  urlPrefix: z.string().describe("URL path prefix to serve, such as '/' or '/TypeGPU'."),
  directory: z
    .string()
    .describe('Filesystem directory to serve for that URL prefix, resolved relative to cwd when not absolute.'),
});

const reportOptionsSchema = {
  verbosity: z
    .enum(['summary', 'normal', 'full'])
    .optional()
    .default('summary')
    .describe(
      "Controls MCP response size. 'summary' returns compact target/status data, 'normal' includes full stats/environment, and 'full' includes the full report unless includeWgsl/includeCalls override it.",
    ),
  includeWgsl: z
    .boolean()
    .optional()
    .describe(
      'Include WGSL source in target reports and shader-module call descriptors. Defaults to true only when verbosity is full.',
    ),
  includeCalls: z
    .boolean()
    .optional()
    .describe('Include recorded GPU calls. Defaults to true only when verbosity is full.'),
  maxWgslBytes: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Truncate each included WGSL source string to at most this many UTF-8 bytes.'),
  diagnosticsOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('Return only diagnostics, target status, console messages, and page errors.'),
};

const runtimeOptionsSchema = {
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory for resolving relative paths and project-local TypeGPU dependencies. Defaults to the MCP client process cwd.',
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(DEFAULT_INSPECTION_TIMEOUT_MS)
    .describe(
      'Maximum wall-clock time in milliseconds for one inspection, including Vite startup, browser import, shader resolution, and WebGPU validation.',
    ),
  viteConfigPath: z
    .string()
    .optional()
    .describe(
      'Optional Vite config path, resolved relative to cwd. Omit unless the inspected module needs project-specific Vite plugins or aliases.',
    ),
  features: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      'WebGPU feature names to request from the adapter before creating the inspector device. Inspection fails early if any requested feature is unsupported.',
    ),
  strictNames: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Use TypeGPU strict generated names for deterministic WGSL and diagnostics. Set false only when random names are needed to avoid name collisions in unusual probes.',
    ),
  dependencyAliases: z
    .record(z.string())
    .optional()
    .default({})
    .describe(
      'Optional Vite aliases for helper dependencies. Values may be absolute paths, cwd-relative paths, or package specifiers resolvable from cwd/server.',
    ),
  fsAllow: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Extra directories Vite may serve, useful for local helper packages.'),
  documentHtml: z
    .string()
    .optional()
    .describe(
      'Optional HTML assigned to document.body before the inspected module is imported. Useful for app entrypoints that query canvas or DOM nodes at import time.',
    ),
  browserSetup: z
    .string()
    .optional()
    .describe(
      'Optional plain browser JavaScript executed before the inspected module is imported. It runs as an async function with root, device, tgpu, d, std, and common parameters, and is intended for DOM/global mocks rather than shader declarations. Use actual newlines in this source body; double-escaped strings such as "\\nconst x = 1" are treated as JavaScript source text.',
    ),
  staticAssetRoutes: z
    .array(staticAssetRouteSchema)
    .optional()
    .default([])
    .describe('Optional static file routes served by the inspector Vite server for project assets or mocked fixtures.'),
  autoBind: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Automatically bind missing default-less slots/accessors during shader resolution: zero values derived from accessor schemas first, then bindings borrowed from module-exported render pipelines and bound functions. Auto-applied bindings are reported through a slot-bindings-auto-applied note. Set false to surface missing bindings as failures.',
    ),
};

const agentProjectSchema = z
  .object({
    root: z
      .string()
      .optional()
      .describe('Optional project/workspace root. Omit to let the MCP infer it from roots, target paths, and cwd.'),
    nodeModulesDir: z
      .string()
      .optional()
      .describe('Optional node_modules directory used only as a dependency resolution hint. The MCP never installs packages.'),
    dependencyAliases: z
      .record(z.string())
      .optional()
      .default({})
      .describe(
        'Optional package-root dependency aliases resolved before node_modules. In TypeGPU monorepos, prefer { "typegpu": "packages/typegpu/src" } instead of aliases for typegpu/data, typegpu/std, or typegpu/common.',
      ),
    packageVersions: z
      .record(z.string())
      .optional()
      .default({})
      .describe('Optional expected package versions by package name or specifier, used for warnings only.'),
    viteConfigPath: z
      .string()
      .optional()
      .describe(
        'Optional Vite config path. Omit unless the project needs custom aliases/plugins beyond TypeGPU. Relative paths are resolved from the target package first, then project root, workspace root, and cwd.',
      ),
  })
  .optional()
  .default({})
  .describe('Optional project context hints. Explicit values override inferred roots and dependency discovery.');

const agentEnvironmentSchema = z
  .object({
    documentHtml: runtimeOptionsSchema.documentHtml,
    browserSetup: runtimeOptionsSchema.browserSetup,
    staticAssetRoutes: runtimeOptionsSchema.staticAssetRoutes,
    features: runtimeOptionsSchema.features,
    strictNames: runtimeOptionsSchema.strictNames,
    autoBind: runtimeOptionsSchema.autoBind,
  })
  .optional()
  .default({})
  .describe('Optional browser/runtime setup for app entrypoints.');

const agentOutputOptionsSchema = z
  .object({
    timeoutMs: runtimeOptionsSchema.timeoutMs,
    verbosity: reportOptionsSchema.verbosity,
    includeWgsl: reportOptionsSchema.includeWgsl,
    includeCalls: reportOptionsSchema.includeCalls,
    maxWgslBytes: reportOptionsSchema.maxWgslBytes,
    diagnosticsOnly: reportOptionsSchema.diagnosticsOnly,
  })
  .optional()
  .default({})
  .describe('Optional response and timeout controls.');

export const moduleSourceSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('modulePath'),
      modulePath: z
        .string()
        .describe('Absolute inspection module path, or a path relative to cwd.'),
    }),
    z.object({
      kind: z.literal('inlineCode'),
      inlineCode: z
        .string()
        .describe(
          'Full inline TypeScript inspection module source. It must export async function inspect(ctx). Use this when imports or top-level helpers are needed.',
        ),
      inlineSourcePath: z
        .string()
        .optional()
        .describe(
          'Optional virtual source path for inlineCode. Relative imports inside the probe resolve as if the code lived at this path.',
        ),
    }),
    z.object({
      kind: z.literal('inspectBody'),
      inspectBody: z
        .string()
        .describe(
          "Lowest-friction inline mode: the body of async inspect({ root, device, tgpu, d, std, common }). Return a target or array of targets. compute-pipeline targets may return TypeGPU compute entrypoints directly; use common.fullScreenTriangle for fullscreen render probes and create: () => root.create... for target-owned render pipeline creation. GPU callbacks still need a 'use gpu' directive. Use actual newlines in this source body; double-escaped strings such as \"\\nconst x = 1\" are treated as JavaScript source text.",
        ),
      inlineSourcePath: z
        .string()
        .optional()
        .describe(
          'Optional virtual source path for inspectBody. Relative imports inside the generated probe resolve as if the code lived at this path.',
        ),
    }),
  ])
  .describe('Inspection source. Pass exactly one source variant.');

export const moduleInputSchema = {
  source: moduleSourceSchema,
  exportName: z.string().optional().default('inspect'),
  ...runtimeOptionsSchema,
  ...reportOptionsSchema,
};

export const reportOptionsObjectSchema = z.object(reportOptionsSchema);
export const moduleInputObjectSchema = z.object(moduleInputSchema);

const compilationMessageStatsSchema = z
  .object({
    total: z.number(),
    errorCount: z.number(),
    warningCount: z.number(),
    infoCount: z.number(),
    byType: z.record(z.number()),
  })
  .passthrough();

const targetDiagnosticOutputSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    valueSummary: z.unknown().optional(),
  })
  .passthrough();

const targetReportOutputSchema = z
  .object({
    label: z.string(),
    kind: targetKindSchema,
    ok: z.boolean(),
    outcome: z
      .enum(['passed', 'passed-with-assumptions', 'failed', 'unsupported', 'blocked'])
      .optional(),
    causeId: z.string().optional(),
    error: z.unknown().optional(),
    diagnostics: z.array(targetDiagnosticOutputSchema).optional(),
    wgslSize: z.number().optional(),
    resolutionMs: z.number().optional(),
    pipelineCreation: z
      .object({
        attempted: z.boolean(),
        ok: z.boolean(),
        callIds: z.array(z.number()),
      })
      .passthrough()
      .optional(),
    compilationSummary: compilationMessageStatsSchema.optional(),
    compilationMessages: z.array(z.unknown()).optional(),
    wgsl: z.string().optional(),
    resource: z.record(z.unknown()).optional(),
    bindGroupLayouts: z.array(z.record(z.unknown())).optional(),
    callIds: z.array(z.number()).optional(),
  })
  .passthrough();

const summaryOutputSchema = z
  .object({
    targetCount: z.number(),
    passedTargetCount: z.number(),
    failedTargetCount: z.number(),
    assumedTargetCount: z.number().optional(),
    unsupportedTargetCount: z.number().optional(),
    blockedTargetCount: z.number().optional(),
    gpuType: z.enum(['hardware', 'software', 'unknown']).optional(),
    browserVersion: z.string().optional(),
    shaderModuleCount: z.number(),
    pipelineCount: z.number(),
    computePipelineCount: z.number(),
    renderPipelineCount: z.number(),
    bindGroupLayoutCount: z.number(),
    compilationErrorCount: z.number(),
    compilationWarningCount: z.number(),
    consoleErrorCount: z.number(),
    consoleWarningCount: z.number(),
    pageErrorCount: z.number(),
  })
  .passthrough();

const consoleMessageOutputSchema = z
  .object({
    type: z.string(),
    text: z.string(),
    count: z.number().optional(),
  })
  .passthrough();

const moduleImportOutputSchema = z
  .object({
    sourceKind: z.enum(['modulePath', 'inlineCode']),
    moduleImported: z.boolean(),
    inspectExportFound: z.boolean(),
    importOnly: z.boolean(),
    exportName: z.string(),
  })
  .passthrough();

export const inspectionReportOutputSchema = z
  .object({
    ok: z.boolean(),
    causes: z.array(z.record(z.unknown())).optional(),
    ledger: z.array(z.record(z.unknown())).optional(),
    moduleImport: moduleImportOutputSchema.optional(),
    summary: summaryOutputSchema.optional(),
    targets: z.array(targetReportOutputSchema).optional(),
    console: z.array(consoleMessageOutputSchema).optional(),
    pageErrors: z.array(z.string()).optional(),
    environment: z.record(z.unknown()).optional(),
    stats: z.record(z.unknown()).optional(),
    diagnostics: z.record(z.unknown()).optional(),
    calls: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .describe('Formatted TypeGPU inspection report.');

export const symbolBindingSchema = z.object({
  slot: z
    .string()
    .describe(
      'Selector for a TypeGPU slot or accessor to bind on the root before creating an inspector-owned pipeline.',
    ),
  value: z
    .string()
    .describe(
      'Selector for the TypeGPU value/resource to bind. Create fixture resources in setupBody when the inspected module does not export one.',
    ),
});

export const probeBindingSchema = z.object({
  slot: z
    .string()
    .describe('Selector for an accessor to receive an inspection-only zero value.'),
  schema: z
    .string()
    .describe('Schema selector used to construct the inspection-only zero value.'),
});

export const probeArgumentPlanEntrySchema = z.union([
  z.object({
    refSchema: z
      .string()
      .describe('Schema selector used to initialize a mutable local passed as a TGSL reference.'),
  }),
  z.object({
    schema: z
      .string()
      .describe('Schema selector used to synthesize a zero-valued argument.'),
  }),
  z.object({
    value: z
      .string()
      .describe('Selector for an existing concrete shader argument, such as a sampler view.'),
  }),
]);

const symbolTargetLabelSchema = {
  label: z.string().optional(),
};

const selectorTargetBaseSchema = {
  ...symbolTargetLabelSchema,
  unwrap: z
    .boolean()
    .optional()
    .describe(
      'When false, resolve the selected value as WGSL instead of unwrapping/validating it as a pipeline target.',
    ),
};

export const selectorTargetSchema = z.object({
  ...selectorTargetBaseSchema,
  selector: z.string().describe('Dot-path selector from the inspected module, or setup./ctx.'),
  kind: targetKindSchema.optional(),
  probeArguments: z
    .array(z.string())
    .optional()
    .describe(
      'Schema selectors used to synthesize zero-valued arguments and call a parameterized GPU helper from a zero-argument probe.',
    ),
  probeArgumentPlan: z
    .array(probeArgumentPlanEntrySchema)
    .optional()
    .describe(
      'Ordered helper arguments. Each entry synthesizes a value, creates a mutable reference local, or reads an existing concrete value selector. Takes precedence over probeArguments.',
    ),
  probeBindings: z
    .array(probeBindingSchema)
    .optional()
    .describe(
      'Accessor/schema selector pairs to bind with synthesized zero values while resolving a GPU helper.',
    ),
});

export const computePipelineTargetSchema = z.object({
  ...symbolTargetLabelSchema,
  kind: z.literal('compute-pipeline'),
  compute: z.string().describe('Selector for a TypeGPU compute entrypoint.'),
  descriptor: z
    .record(z.unknown())
    .optional()
    .describe(
      'Additional root.createComputePipeline descriptor fields to merge with the selected compute entrypoint. Use only JSON-serializable descriptor data.',
    ),
  with: z
    .array(symbolBindingSchema)
    .optional()
    .describe(
      'Explicit slot/accessor bindings applied with root.with(...) before creating the pipeline. Each binding must include slot and value selectors. Explicit bindings take precedence over automatic slot binding.',
    ),
});

export const renderPipelineTargetSchema = z.object({
  ...symbolTargetLabelSchema,
  kind: z.literal('render-pipeline'),
  vertex: z.string().describe('Selector for a TypeGPU vertex entrypoint.'),
  fragment: z.string().optional().describe('Selector for a TypeGPU fragment entrypoint.'),
  attribs: z
    .union([z.string(), z.record(z.string())])
    .optional()
    .describe(
      'Selector for a complete vertex attribs object, or a map from shader attribute names to vertex layout attrib selectors.',
    ),
  descriptor: z
    .record(z.unknown())
    .optional()
    .describe(
      'Additional root.createRenderPipeline descriptor fields to merge with selected vertex/fragment/attribs values, typically including targets/depthStencil/layout.',
    ),
  with: z
    .array(symbolBindingSchema)
    .optional()
    .describe(
      'Explicit slot/accessor bindings applied with root.with(...) before creating the render pipeline. Each binding must include slot and value selectors. Explicit bindings take precedence over automatic slot binding.',
    ),
  synthesizeMissing: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Synthesize vertex attributes and fragment color targets from TypeGPU shell metadata when they are omitted. Defaults to true.',
    ),
});

export const symbolTargetSchema = z.union([
  selectorTargetSchema,
  computePipelineTargetSchema,
  renderPipelineTargetSchema,
]);

export const agentTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('probe'),
    body: z
      .string()
      .describe(
        "Body of async inspect({ root, device, tgpu, d, std, common }). Return an inspection target or array. Include 'use gpu' inside shader callbacks.",
      ),
    virtualPath: z
      .string()
      .optional()
      .describe(
        'Optional virtual path for resolving relative imports used by the probe. Relative values resolve from project.root or advertised MCP roots before server cwd; use an absolute path when roots are unavailable.',
      ),
  }),
  z.object({
    kind: z.literal('module'),
    path: z.string().describe('Inspection module path. Relative paths are resolved from inferred project context.'),
    exportName: z.string().optional().default('inspect'),
  }),
  z.object({
    kind: z.literal('symbols'),
    modulePath: z.string().describe('TypeScript module containing exported TypeGPU symbols.'),
    targets: z
      .array(symbolTargetSchema)
      .min(1)
      .describe('Exported symbol targets to inspect. Use list_typegpu_exports first when unsure.'),
    setupBody: z
      .string()
      .optional()
      .describe(
        'Optional setup closure body that runs after importing the module and before target creation. It can use root, device, tgpu, d, std, common, module, and inspectedModule.',
      ),
    includePrivate: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Expose selected top-level local declarations by inlining the module into the generated editor probe.',
      ),
  }),
]);

export const agentInspectionInputSchema = {
  target: agentTargetSchema,
  project: agentProjectSchema,
  environment: agentEnvironmentSchema,
  output: agentOutputOptionsSchema,
};

export const resolveTypegpuContextInputSchema = {
  targetPath: z
    .string()
    .optional()
    .describe('Optional target path used to infer the nearest package/workspace context.'),
  project: agentProjectSchema,
};

export const listTypegpuExportsInputSchema = {
  modulePath: z.string().describe('TypeScript module path to scan for exported symbols.'),
  project: agentProjectSchema,
};

const dependencyOutputSchema = z
  .object({
    specifier: z.string(),
    packageName: z.string(),
    path: z.string().optional(),
    version: z.string().optional(),
    source: z.string(),
    warning: z.string().optional(),
  })
  .passthrough();

const dependencySummaryOutputSchema = z
  .object({
    coreTypegpu: z.record(z.unknown()).optional(),
    bundledFallbacks: z.array(z.string()).optional(),
    packageAliases: z.array(z.string()).optional(),
    hasBundledTypegpuFallback: z.boolean().optional(),
    allCoreTypegpuFromPackageAlias: z.boolean().optional(),
  })
  .passthrough();

export const resolvedContextOutputSchema = z
  .object({
    cwd: z.string(),
    projectRoot: z.string(),
    packageRoot: z.string().optional(),
    workspaceRoot: z.string().optional(),
    workspaceKind: z.string().optional(),
    packageName: z.string().optional(),
    packageManager: z.string().optional(),
    nodeModulesDir: z.string().optional(),
    dependencyAliases: z.record(z.string()).optional(),
    viteConfigPath: z.string().optional(),
    targetPath: z.string().optional(),
    targetPathExists: z.boolean().optional(),
    targetPathKind: z.enum(['file', 'virtual']).optional(),
    targetPathSource: z.string().optional(),
    targetPathBase: z.string().optional(),
    rootSource: z.string(),
    dependencies: z.record(dependencyOutputSchema),
    dependencySummary: dependencySummaryOutputSchema.optional(),
    warnings: z.array(z.string()),
    pathAliases: z.record(z.string()).optional(),
  })
  .passthrough();

export const agentInspectionOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: summaryOutputSchema.optional(),
    targets: z.array(targetReportOutputSchema).optional(),
    moduleImport: moduleImportOutputSchema.optional(),
    diagnostics: z.record(z.unknown()).optional(),
    environment: z.record(z.unknown()).optional(),
    stats: z.record(z.unknown()).optional(),
    console: z.array(consoleMessageOutputSchema).optional(),
    pageErrors: z.array(z.string()).optional(),
    calls: z.array(z.unknown()).optional(),
    resolvedContext: resolvedContextOutputSchema.optional(),
    dependencySummary: dependencySummaryOutputSchema.optional(),
    warnings: z.array(z.string()).optional(),
    inspection: inspectionReportOutputSchema.optional(),
    error: z.unknown().optional(),
    nextActions: z.array(z.string()).optional(),
  })
  .passthrough();

export const exportInfoOutputSchema = z
  .object({
    name: z.string(),
    exportKind: z.string(),
    likelyTypegpu: z.boolean(),
    typegpuRole: z
      .enum([
        'compute-entrypoint',
        'vertex-entrypoint',
        'fragment-entrypoint',
        'pipeline-factory',
        'resource-factory',
        'bind-group-layout',
        'vertex-layout',
        'binding-resource',
        'schema',
        'shader-helper',
        'shader-constant',
        'unknown',
      ])
      .optional(),
    suggestedTargetKind: z.enum(['compute-pipeline', 'render-pipeline', 'resolvable', 'probe']).optional(),
    usageHint: z.string().optional(),
    line: z.number(),
    character: z.number(),
    source: z.string().optional(),
  })
  .passthrough();

export const listTypegpuExportsOutputSchema = z
  .object({
    ok: z.boolean(),
    modulePath: z.string().optional(),
    resolvedContext: resolvedContextOutputSchema.optional(),
    dependencySummary: dependencySummaryOutputSchema.optional(),
    exports: z.array(exportInfoOutputSchema).optional(),
    likelyTypegpuExports: z.array(exportInfoOutputSchema).optional(),
    suggestedSymbolTargets: z.array(z.record(z.unknown())).optional(),
    error: z.unknown().optional(),
    nextActions: z.array(z.string()).optional(),
  })
  .passthrough();

export const resolveTypegpuContextOutputSchema = z
  .object({
    ok: z.boolean(),
    resolvedContext: resolvedContextOutputSchema.optional(),
    dependencySummary: dependencySummaryOutputSchema.optional(),
    warnings: z.array(z.string()).optional(),
    error: z.unknown().optional(),
    nextActions: z.array(z.string()).optional(),
  })
  .passthrough();

export const symbolInputSchema = {
  modulePath: z
    .string()
    .describe('Absolute TypeScript module path, or a path relative to cwd, that contains TypeGPU symbols.'),
  targets: z
    .array(symbolTargetSchema)
    .min(1)
    .describe('Symbol selectors to resolve or wrap into inspector-owned pipelines. Selectors target exported module values, setup.* values, or ctx.* values.'),
  setupBody: z
    .string()
    .optional()
    .describe(
      'Optional body of an async setup closure that runs after importing the inspected module and before target creation. It can use root, device, tgpu, d, std, common, module, and inspectedModule; returned object keys are addressable through setup.* and as top-level selector roots. Use actual newlines in this source body; double-escaped strings such as "\\nconst x = 1" are treated as JavaScript source text.',
    ),
  includePrivate: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Inline the source module and expose selected top-level local declarations to the inspection wrapper. Intended for editor integrations that inspect non-exported shaders and pipelines.',
    ),
  ...runtimeOptionsSchema,
  ...reportOptionsSchema,
};

export const symbolInputObjectSchema = z.object(symbolInputSchema);
export const agentInspectionInputObjectSchema = z.object(agentInspectionInputSchema);
export const resolveTypegpuContextInputObjectSchema = z.object(resolveTypegpuContextInputSchema);
export const listTypegpuExportsInputObjectSchema = z.object(listTypegpuExportsInputSchema);
