import { join, resolve } from 'node:path';
import {
  resolveTypegpuContext,
  type ClientRoot,
  type ResolvedTypegpuContext,
} from './context.ts';
import {
  createDependencySummary,
  createInspectionSurface,
  createPublicResolvedContext,
  sanitizeForAgent,
} from './agentOutput.ts';
import { listTypegpuExportsFromFile } from './exportScanner.ts';
import { inspectTypegpuModule, inspectTypegpuSymbols } from './inspect.ts';
import { formatInspectionReport } from './report.ts';
import { isAbortError } from './shared.ts';
import type {
  AgentInspectionInput,
  InspectReportOptions,
  InspectTypegpuModuleInput,
  InspectTypegpuSymbolsInput,
  ListTypegpuExportsInput,
  ResolveTypegpuContextInput,
  TypeGpuInspectionReport,
} from './types.ts';

export type AgentToolResult = {
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

type AgentToolContext = {
  clientRoots?: ClientRoot[] | undefined;
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
};

export async function resolveTypegpuContextTool(
  input: ResolveTypegpuContextInput,
  context: AgentToolContext = {},
): Promise<AgentToolResult> {
  try {
    const resolvedContext = await resolveTypegpuContext({
      project: input.project,
      targetPath: input.targetPath,
      targetPathKind: 'file',
      cwd: context.cwd,
      clientRoots: context.clientRoots,
    });
    const missingTargetPath = input.targetPath && resolvedContext.targetPathExists === false;
    const dependencyActions = createDependencyResolutionNextActions(resolvedContext);
    const nextActions = [
      ...(missingTargetPath ? createMissingTargetPathNextActions(input.targetPath) : []),
      ...dependencyActions,
    ];
    return {
      structuredContent: sanitizeForAgent({
        ok: !missingTargetPath,
        resolvedContext: createPublicResolvedContext(resolvedContext),
        dependencySummary: createDependencySummary(resolvedContext),
        warnings: resolvedContext.warnings.length > 0 ? resolvedContext.warnings : undefined,
        error: missingTargetPath
          ? { message: `Target path does not exist: ${resolvedContext.targetPath}` }
          : undefined,
        nextActions: nextActions.length > 0 ? nextActions : undefined,
      }, resolvedContext) as Record<string, unknown>,
      isError: Boolean(missingTargetPath),
    };
  } catch (error) {
    return createAgentErrorResult(error, [
      'Pass project.root when the target is outside the MCP client workspace.',
      'Pass project.nodeModulesDir only when dependency resolution should use a specific install tree.',
    ]);
  }
}

export async function listTypegpuExportsTool(
  input: ListTypegpuExportsInput,
  context: AgentToolContext = {},
): Promise<AgentToolResult> {
  let resolvedContext: ResolvedTypegpuContext | undefined;
  try {
    resolvedContext = await resolveTypegpuContext({
      project: input.project,
      targetPath: input.modulePath,
      targetPathKind: 'file',
      cwd: context.cwd,
      clientRoots: context.clientRoots,
    });
    if (resolvedContext.targetPathExists === false) {
      return createAgentErrorResult(
        new Error(`Module path does not exist: ${resolvedContext.targetPath}`),
        [
          ...createMissingTargetPathNextActions(input.modulePath),
          'Use an absolute modulePath when the MCP server cwd is different from the project root.',
        ],
        resolvedContext,
      );
    }
    const modulePath = resolvedContext.targetPath ?? resolve(resolvedContext.cwd, input.modulePath);
    const scan = await listTypegpuExportsFromFile(modulePath);
    const nextActions = createDependencyResolutionNextActions(resolvedContext);
    return {
      structuredContent: sanitizeForAgent({
        ok: true,
        resolvedContext: createPublicResolvedContext(resolvedContext, {
          includeDependencies: false,
        }),
        dependencySummary: createDependencySummary(resolvedContext, { compact: true }),
        ...scan,
        nextActions: nextActions.length > 0 ? nextActions : undefined,
      }, resolvedContext) as Record<string, unknown>,
      isError: false,
    };
  } catch (error) {
    return createAgentErrorResult(
      error,
      [
        'Check that modulePath points to a TypeScript/JavaScript module that exists.',
        'Run resolve_typegpu_context with the same project hints to verify root inference.',
      ],
      resolvedContext,
    );
  }
}

export async function inspectTypegpuTool(
  input: AgentInspectionInput,
  context: AgentToolContext = {},
): Promise<AgentToolResult> {
  let resolvedContext: ResolvedTypegpuContext | undefined;
  try {
    resolvedContext = await resolveTypegpuContext({
      project: input.project,
      targetPath: getTargetPath(input.target),
      targetPathKind: getTargetPathKind(input.target),
      cwd: context.cwd,
      clientRoots: context.clientRoots,
    });
    if (input.target.kind !== 'probe' && resolvedContext.targetPathExists === false) {
      return createAgentErrorResult(
        new Error(`Target module path does not exist: ${resolvedContext.targetPath}`),
        [
          ...createMissingTargetPathNextActions(getTargetPath(input.target)),
          'Use an absolute modulePath/path when the MCP server cwd is different from the project root.',
        ],
        resolvedContext,
      );
    }
    const report = attachContextLedger(
      await runAgentInspection(input, resolvedContext, context.signal),
      resolvedContext,
    );
    const formatted = formatInspectionReport(report, createReportOptions(input));
    const nextActions = [
      ...(report.ok
        ? createSuccessfulInspectionNextActions(report) ?? []
        : createInspectionNextActions(report, input)),
      ...createDependencyResolutionNextActions(resolvedContext),
    ];
    const diagnosticsOnly = input.output?.diagnosticsOnly === true;

    return {
      structuredContent: sanitizeForAgent({
        ok: report.ok,
        ...createInspectionSurface(formatted),
        resolvedContext: diagnosticsOnly
          ? undefined
          : createPublicResolvedContext(resolvedContext, {
              includeDependencies: false,
            }),
        dependencySummary: diagnosticsOnly
          ? undefined
          : createDependencySummary(resolvedContext, { compact: true }),
        warnings: !diagnosticsOnly && resolvedContext.warnings.length > 0
          ? resolvedContext.warnings
          : undefined,
        inspection: input.output?.includeLegacyInspection ? formatted : undefined,
        nextActions: !diagnosticsOnly && nextActions.length > 0 ? nextActions : undefined,
      }, resolvedContext) as Record<string, unknown>,
      isError: !report.ok,
    };
  } catch (error) {
    if (isAbortError(error)) {
      // A cancelled inspection has no result to report; let the MCP layer drop it.
      throw error;
    }
    return createAgentErrorResult(
      error,
      [
        'Run resolve_typegpu_context with the same target/project hints to inspect inferred roots and dependencies.',
        'Run list_typegpu_exports before symbol inspection when selector names are uncertain.',
      ],
      resolvedContext,
    );
  }
}

function attachContextLedger(
  report: TypeGpuInspectionReport,
  context: ResolvedTypegpuContext,
): TypeGpuInspectionReport {
  const entries = Object.values(context.dependencies).map((dependency) => ({
    tier: 'module' as const,
    kind: 'dependency-resolution' as const,
    key: `dependency:${dependency.specifier}`,
    status: dependency.source === 'unresolved' ? 'unsatisfied' as const : 'satisfied' as const,
    discoveredBy: 'shape' as const,
    provider: dependency.source === 'bundled'
      ? 'bundled-fallback' as const
      : 'project-toolchain' as const,
    provenance: dependency.source === 'bundled'
      ? `${dependency.specifier} was substituted from the MCP package.`
      : `${dependency.specifier} resolved from ${dependency.source}.`,
    detail: {
      specifier: dependency.specifier,
      source: dependency.source,
      version: dependency.version,
      path: dependency.path,
    },
  }));
  return { ...report, ledger: [...(report.ledger ?? []), ...entries] };
}

async function runAgentInspection(
  input: AgentInspectionInput,
  context: ResolvedTypegpuContext,
  signal?: AbortSignal | undefined,
): Promise<TypeGpuInspectionReport> {
  const commonInput = createCommonInspectionInput(input, context);
  if (input.target.kind === 'symbols') {
    const symbolInput: InspectTypegpuSymbolsInput = {
      ...commonInput,
      modulePath: context.targetPath ?? resolve(context.cwd, input.target.modulePath),
      targets: input.target.targets,
      setupBody: input.target.setupBody,
      includePrivate: input.target.includePrivate,
    };
    return await inspectTypegpuSymbols(symbolInput, {
      addDirectSymbolDiagnostic: false,
      signal,
    });
  }

  const moduleInput: InspectTypegpuModuleInput = {
    ...commonInput,
    exportName: input.target.kind === 'module' ? (input.target.exportName ?? 'inspect') : 'inspect',
    source:
      input.target.kind === 'probe'
        ? {
            kind: 'inspectBody',
            inspectBody: input.target.body,
            inlineSourcePath: resolveProbeVirtualPath(input, context),
          }
        : {
            kind: 'modulePath',
            modulePath: context.targetPath ?? resolve(context.cwd, input.target.path),
          },
  };
  return await inspectTypegpuModule(moduleInput, { signal });
}

function createCommonInspectionInput(
  input: AgentInspectionInput,
  context: ResolvedTypegpuContext,
): Omit<InspectTypegpuModuleInput, 'source'> {
  const environment = input.environment ?? {};
  const output = input.output ?? {};
  return {
    cwd: context.cwd,
    timeoutMs: output.timeoutMs,
    viteConfigPath: context.viteConfigPath,
    features: environment.features,
    strictNames: environment.strictNames,
    autoBind: environment.autoBind,
    documentHtml: environment.documentHtml,
    browserSetup: environment.browserSetup,
    quiescent: environment.quiescent,
    staticAssetRoutes: environment.staticAssetRoutes,
    reuseBrowser: true,
    dependencyResolution: context.dependencyResolution,
    verbosity: output.verbosity,
    includeWgsl: output.includeWgsl,
    includeCallWgsl: output.includeCallWgsl,
    includeCalls: output.includeCalls,
    maxWgslBytes: output.maxWgslBytes,
    diagnosticsOnly: output.diagnosticsOnly,
  };
}

function createReportOptions(input: AgentInspectionInput): InspectReportOptions {
  const output = input.output ?? {};
  return {
    verbosity: output.verbosity,
    includeWgsl: output.includeWgsl,
    includeCallWgsl: output.includeCallWgsl,
    includeCalls: output.includeCalls,
    maxWgslBytes: output.maxWgslBytes,
    diagnosticsOnly: output.diagnosticsOnly,
  };
}

function getTargetPath(target: AgentInspectionInput['target']): string | undefined {
  if (target.kind === 'module') {
    return target.path;
  }
  if (target.kind === 'symbols') {
    return target.modulePath;
  }
  return target.virtualPath;
}

function getTargetPathKind(
  target: AgentInspectionInput['target'],
): 'file' | 'virtual' {
  return target.kind === 'probe' ? 'virtual' : 'file';
}

function resolveProbeVirtualPath(
  input: AgentInspectionInput,
  context: ResolvedTypegpuContext,
): string {
  if (input.target.kind !== 'probe') {
    return join(context.cwd, '__typegpu_mcp_probe.ts');
  }
  if (input.target.virtualPath) {
    return context.targetPath ?? resolve(context.cwd, input.target.virtualPath);
  }
  return join(context.cwd, '__typegpu_mcp_probe.ts');
}

function createMissingTargetPathNextActions(targetPath: string | undefined): string[] {
  const pathText = targetPath ? ` "${targetPath}"` : '';
  return [
    `Check that target path${pathText} exists from the intended project root.`,
    'Pass project.root when using paths relative to a workspace/package and the MCP server was launched from another directory.',
    'Use an absolute path when roots are unavailable or ambiguous.',
  ];
}

function collectReportDiagnosticCodes(report: TypeGpuInspectionReport): Set<string> {
  return new Set(
    report.targets.flatMap((target) =>
      (target.diagnostics ?? []).map((diagnostic) => diagnostic.code),
    ),
  );
}

function collectReportLedger(report: TypeGpuInspectionReport) {
  return report.targets.flatMap((target) => target.ledger ?? []);
}

const AUTO_BOUND_SLOT_ACTION = 'Auto-bound slot values are inspection-only (placeholder or borrowed); the WGSL reflects them. Bind real values via `with`/`probeBindings` when production-accurate output matters.';

function createInspectionNextActions(
  report: TypeGpuInspectionReport,
  input: AgentInspectionInput,
): string[] {
  const codes = collectReportDiagnosticCodes(report);
  const ledger = collectReportLedger(report);
  const actions = new Set<string>();
  actions.add('Inspect the returned diagnostics before changing the TypeGPU code.');
  if (input.target.kind !== 'symbols') {
    actions.add('Use list_typegpu_exports when an existing module target is easier than a handwritten probe.');
  }
  if (input.target.kind === 'symbols') {
    actions.add('Use list_typegpu_exports on the same module to verify selector names and TypeGPU role hints.');
  }
  if (codes.has('cpu-function-not-inspectable')) {
    actions.add('If the selected export is a pipeline factory, retry with a probe or setupBody that calls the factory and returns the created pipeline target.');
  }
  if (
    codes.has('wrapper-required') ||
    ledger.some((entry) => entry.kind === 'argument-values' && entry.status === 'unsatisfied')
  ) {
    actions.add('Retry with target.kind="probe" to call the helper with concrete arguments, then return the wrapper function or created pipeline.');
  }
  if (codes.has('not-shader-resolvable')) {
    actions.add('Layout, accessor, and slot exports are usually setup resources. Use them in setupBody, target.with bindings, or render-pipeline attribs instead of inspecting them directly; consumers of a slot/accessor are auto-bound with zero or borrowed values when possible.');
  }
  if (codes.has('selector-not-resolved')) {
    actions.add('Retry with selector names from list_typegpu_exports; selector paths are case-sensitive dot paths.');
  }
  if (codes.has('webgpu-validation-timeout')) {
    actions.add('Retry with a narrower target, diagnosticsOnly output, or a higher output.timeoutMs; complex pipelines may validate more slowly in browser software WebGPU.');
  }
  if (report.pageErrors.some((error) => /canvas|getContext|document\.querySelector/.test(error))) {
    actions.add('Retry with environment.documentHtml that provides the expected canvas or DOM nodes.');
  }
  if (codes.has('module-import-failed')) {
    actions.add('Retry with project.root, project.viteConfigPath, or environment.staticAssetRoutes if imports/assets are app-specific.');
    actions.add('For probe targets with relative imports, pass target.virtualPath as an absolute path inside the project or relative to project.root.');
  }
  if (
    codes.has('slot-binding-required') ||
    ledger.some((entry) => entry.kind === 'slot-value' && entry.status === 'unsatisfied')
  ) {
    actions.add('The inspector auto-binds missing slots when a matching accessor or bound value exists in the module or its imports; this slot could not be auto-bound. Bind it through a symbols target `with` entry, `probeBindings`, or a wrapper probe with root.with(...).');
  }
  if (codes.has('slot-bindings-auto-applied')) {
    actions.add(AUTO_BOUND_SLOT_ACTION);
  }
  return [...actions];
}

function createSuccessfulInspectionNextActions(report: TypeGpuInspectionReport): string[] | undefined {
  if (report.moduleImport?.importOnly || report.targets.length === 0) {
    return [
      'The module imported successfully but no inspection target ran. Use list_typegpu_exports plus target.kind="symbols", or retry with target.kind="probe" to wrap an exported function or app entrypoint.',
    ];
  }
  if (collectReportDiagnosticCodes(report).has('slot-bindings-auto-applied')) {
    return [AUTO_BOUND_SLOT_ACTION];
  }
  return undefined;
}

function createDependencyResolutionNextActions(context: ResolvedTypegpuContext): string[] {
  const actions = new Set<string>();
  const coreTypegpuDependencies = [
    context.dependencies.typegpu,
    context.dependencies['typegpu/data'],
    context.dependencies['typegpu/std'],
    context.dependencies['typegpu/common'],
  ];
  if (coreTypegpuDependencies.some((dependency) => dependency?.source === 'bundled')) {
    actions.add(
      'resolvedContext shows core TypeGPU imports fell back to the MCP package. In monorepos, retry with project.root set to the workspace root and project.dependencyAliases using a package-root alias such as { "typegpu": "packages/typegpu/src" }.',
    );
  }
  if (
    context.warnings.some((warning) =>
      warning.includes('TypeGPU subpath dependency aliases were provided'),
    )
  ) {
    actions.add(
      'Replace TypeGPU subpath dependency aliases with one root "typegpu" alias so typegpu, typegpu/data, typegpu/std, and typegpu/common resolve together.',
    );
  }
  return [...actions];
}

function createAgentErrorResult(
  error: unknown,
  nextActions: string[],
  resolvedContext?: ResolvedTypegpuContext | undefined,
): AgentToolResult {
  return {
    structuredContent: sanitizeForAgent({
      ok: false,
      resolvedContext: resolvedContext
        ? createPublicResolvedContext(resolvedContext)
        : undefined,
      dependencySummary: resolvedContext
        ? createDependencySummary(resolvedContext)
        : undefined,
      error: serializeAgentError(error),
      nextActions,
    }, resolvedContext) as Record<string, unknown>,
    isError: true,
  };
}

function serializeAgentError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: String(error) };
}
