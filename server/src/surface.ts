import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodeActionKind,
  DiagnosticSeverity,
  type CodeAction,
  type CodeActionContext,
  type Diagnostic,
  type DiagnosticRelatedInformation,
  type DocumentLink,
  type Hover,
  type InlayHint,
  type MarkupContent,
  MarkupKind,
  type Position,
  type Range,
} from 'vscode-languageserver';
import type {
  DiscoveredModule,
  DiscoveredSymbol,
  InspectionTarget,
  ShaderSourceToken,
  TypeGpuRole,
} from './discovery.js';
import type {
  HoverDetailLevel,
  HoverPresentationSettings,
  HoverSectionId,
  InlayDetailLevel,
  InspectorOutput,
  InspectorResourceReport,
  InspectorSchemaReport,
  InspectorDiagnostic,
  InspectorLedgerEntry,
  InspectorTargetReport,
} from './protocol.js';
import { settingsBounds } from './protocol.js';
import {
  code,
  escapeCell,
  escapeInline,
  escapeMarkdown,
  formatInspectableValue,
  section,
  tableCode,
  tableRowWidth,
  tableText,
  valueText,
} from './markdown.js';
import {
  extractGpuBindGroupLayouts,
  extractGpuPipelineState,
  type GpuBindGroupLayout,
  type GpuPipelineState,
} from './surfaceData.js';
import { analyzeSchemaLayout } from './schemaLayout.js';
import { analyzeWgsl, formatByteSize, type WgslAnalysis } from './wgsl.js';
import type { ExternalShaderSymbol } from './moduleGraph.js';
import {
  compilerGeneratedRange,
  mapResolutionFailure,
  mapWgslDiagnostic,
  type WgslDiagnosticMapping,
} from './sourceMapping.js';

const MAX_INLAY_LABEL_LENGTH = 36;
const MAX_RUNTIME_NOTES = 4;

export type MaterializedTarget = {
  target: InspectionTarget;
  report: InspectorTargetReport;
  analysis?: WgslAnalysis;
  layouts?: GpuBindGroupLayout[];
  pipelineState?: GpuPipelineState;
  generatedUri?: string;
  generatedReportUri?: string;
};

export type DocumentInspection = {
  sourceVersion: number;
  completedAt: number;
  output: InspectorOutput;
  targets: Map<string, MaterializedTarget>;
  failure?: string;
  targetFailures?: Map<string, string>;
  /**
   * Target IDs that were sent to the runtime but came back without a matching
   * report. Tracked so hover-triggered inspection does not retry them in a
   * loop within the same saved version.
   */
  unreported?: Set<string>;
};

export type SurfaceOptions = {
  /** Set per hover; enables the VS Code command links that need it. */
  documentUri?: string;
  sourceMapping: boolean;
  schemaLayoutHealth: boolean;
  schemaPackingSuggestions: boolean;
  saveAffordance: boolean;
  /**
   * Hover rendering profile. 'zed' keeps the popup-tuned markdown as-is;
   * 'vscode' converts tables to aligned mono grids (VS Code hovers render
   * markdown tables almost unstyled), adds section separators, and promotes
   * the WGSL preview.
   */
  presentation: 'zed' | 'vscode';
  hoverDetailLevel?: HoverDetailLevel;
  inlayDetailLevel?: InlayDetailLevel;
  hoverPresentation?: HoverPresentationSettings;
  /** Width budget used when `hoverPresentation.maxColumns` is unset. */
  defaultMaxColumns?: number;
};

export const defaultSurfaceOptions: SurfaceOptions = {
  sourceMapping: true,
  schemaLayoutHealth: true,
  schemaPackingSuggestions: true,
  saveAffordance: true,
  presentation: 'zed',
  hoverDetailLevel: 'standard',
  inlayDetailLevel: 'compact',
  hoverPresentation: { sections: {}, sectionOrder: [] },
};

export const WIDE_MAX_COLUMNS = 96;
export const ZED_MAX_COLUMNS = 72;

/** Zed's hover popup clips instead of scrolling, so it gets the narrower budget. */
export function defaultMaxColumnsForClient(clientName: string | undefined): number {
  return /zed/i.test(clientName ?? '') ? ZED_MAX_COLUMNS : WIDE_MAX_COLUMNS;
}

export async function materializeInspection(
  workspaceRoot: string,
  modulePath: string,
  sourceVersion: number,
  discovered: DiscoveredModule,
  output: InspectorOutput,
  requestedTargetIds?: readonly string[],
): Promise<DocumentInspection> {
  const reports = new Map(
    (output.targets ?? []).map((report) => [report.label, report]),
  );
  const targets = new Map<string, MaterializedTarget>();

  const materializedTargets = await Promise.all(discovered.targets.map(async (target) => {
    const report = reports.get(target.label);
    if (!report) return undefined;
    const analysis = report.wgsl ? analyzeWgsl(report.wgsl) : undefined;
    const layouts = extractGpuBindGroupLayouts(output, report);
    const pipelineState = extractGpuPipelineState(output, report);
    const generatedUri = report.wgsl
      ? await writeGeneratedWgsl(workspaceRoot, modulePath, target, report.wgsl)
      : undefined;
    const materialized: MaterializedTarget = {
      target,
      report,
      ...(analysis ? { analysis } : {}),
      ...(layouts.length > 0 ? { layouts } : {}),
      ...(pipelineState ? { pipelineState } : {}),
      ...(generatedUri ? { generatedUri } : {}),
    };
    try {
      materialized.generatedReportUri = await writeGeneratedReport(
        workspaceRoot,
        modulePath,
        materialized,
        output,
      );
    } catch {
      // A failed report write only costs the hover its link.
    }
    return [target.id, materialized] as const;
  }));
  for (const entry of materializedTargets) {
    if (entry) targets.set(...entry);
  }

  const requested = requestedTargetIds ??
    discovered.targets.map((target) => target.id);
  const unreported = new Set(
    requested.filter((targetId) => !targets.has(targetId)),
  );

  return {
    sourceVersion,
    completedAt: Date.now(),
    output: compactInspectorOutput(output),
    targets,
    ...(unreported.size > 0 ? { unreported } : {}),
  };
}

/**
 * The raw runtime envelope contains recorded GPU descriptors, console output,
 * and environment evidence used only while materializing targets and writing
 * the full report artifact. Keeping those payloads for every open document can
 * retain large object graphs. Preserve exactly what editor surfaces consume;
 * target reports remain shared with MaterializedTarget rather than copied.
 */
function compactInspectorOutput(output: InspectorOutput): InspectorOutput {
  const timings = isRecord(output.stats?.timings)
    ? output.stats.timings
    : undefined;
  const environment = output.environment;
  const compactEnvironment = environment
    ? {
        ...(environment.gpuType !== undefined
          ? { gpuType: environment.gpuType }
          : {}),
        ...(environment.browserVersion !== undefined
          ? { browserVersion: environment.browserVersion }
          : {}),
        ...(environment.limits !== undefined
          ? { limits: environment.limits }
          : {}),
      }
    : undefined;
  return {
    ok: output.ok,
    ...(output.summary ? { summary: output.summary } : {}),
    ...(output.targets ? { targets: output.targets } : {}),
    ...(timings ? { stats: { timings } } : {}),
    ...(compactEnvironment && Object.keys(compactEnvironment).length > 0
      ? { environment: compactEnvironment }
      : {}),
    ...(output.warnings ? { warnings: output.warnings } : {}),
    ...(output.pageErrors ? { pageErrors: output.pageErrors } : {}),
  };
}

export function failedTargetInspection(
  sourceVersion: number,
  targetIds: readonly string[],
  message: string,
): DocumentInspection {
  return {
    sourceVersion,
    completedAt: Date.now(),
    output: { ok: false },
    targets: new Map(),
    targetFailures: new Map(targetIds.map((targetId) => [targetId, message])),
  };
}

/** Merge a partial runtime pass without erasing valid same-version targets. */
export function mergeDocumentInspections(
  previous: DocumentInspection | undefined,
  next: DocumentInspection,
  requestedTargetIds: readonly string[],
): DocumentInspection {
  if (!previous || previous.sourceVersion !== next.sourceVersion) return next;

  const targets = new Map(previous.targets);
  for (const [targetId, target] of next.targets) targets.set(targetId, target);

  const targetFailures = new Map(previous.targetFailures ?? []);
  for (const targetId of requestedTargetIds) targetFailures.delete(targetId);
  for (const [targetId, failure] of next.targetFailures ?? []) {
    targetFailures.set(targetId, failure);
  }

  const unreported = new Set(previous.unreported ?? []);
  for (const targetId of requestedTargetIds) unreported.delete(targetId);
  for (const targetId of next.unreported ?? []) unreported.add(targetId);
  for (const targetId of targets.keys()) unreported.delete(targetId);

  return {
    sourceVersion: next.sourceVersion,
    completedAt: Math.max(previous.completedAt, next.completedAt),
    output: mergeInspectorOutputs(previous.output, next.output),
    targets,
    ...(next.failure ? { failure: next.failure } : {}),
    ...(targetFailures.size > 0 ? { targetFailures } : {}),
    ...(unreported.size > 0 ? { unreported } : {}),
  };
}

export function createHover(
  symbol: DiscoveredSymbol,
  _discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
  currentVersion: number,
  inspectingTargetIds: ReadonlySet<string> = new Set(),
  options: SurfaceOptions = defaultSurfaceOptions,
): Hover {
  const level = effectiveHoverLevel(options);
  const lines: string[] = [
    `### TypeGPU · ${humanRole(symbol.role)} \`${escapeInline(symbol.name)}\``,
  ];
  if (symbol.specializationSynthesis) {
    const synthesis = symbol.specializationSynthesis;
    // Preamble only when the list is truncated.
    if (synthesis.truncated) {
      lines.push(
        '',
        `_Showing the first ${synthesis.emitted} specializations ` +
          `(limit ${synthesis.limit}); additional finite combinations were omitted._`,
      );
    } else if (level === 'deep') {
      lines.push(
        '',
        `_Showing ${plural(synthesis.emitted, 'specialization')} inferred ` +
          'from finite parameter types._',
      );
    }
  }
  const inspecting = symbol.targetIds.some((id) => inspectingTargetIds.has(id));
  if (inspecting) {
    lines.push('', '> ◌ **Inspecting this target…**');
  }

  if (!inspection) {
    lines.push(
      '',
      symbol.targetIds.length > 0
        ? inspecting
          ? 'The runtime report will appear when inspection completes.'
          : 'Save the file to resolve this target in Chromium and inspect its generated shader.'
        : staticRoleDescription(symbol.role),
    );
    return hover(lines, symbol.range, options);
  }

  const stale = inspection.sourceVersion !== currentVersion;
  if (stale) {
    lines.push('', '> Inspection is from the previous saved version.');
  }
  const targetFailure = symbol.targetIds
    .map((id) => inspection.targetFailures?.get(id))
    .find((failure) => failure !== undefined);
  const failure = targetFailure ?? inspection.failure;
  if (failure) {
    lines.push('', `> **Inspection failed:** ${valueText(failure)}`);
    return hover(lines, symbol.range, options);
  }

  const materialized = symbol.targetIds
    .map((id) => inspection.targets.get(id))
    .filter((target): target is MaterializedTarget => target !== undefined);

  if (materialized.length === 0) {
    lines.push(
      '',
      symbol.targetIds.length > 0
        ? inspecting
          ? 'The runtime report will appear when inspection completes.'
          : stale
          ? 'This target changed since the previous inspection. Save the file to inspect the current version.'
          : 'An inspection target was derived, but the last runtime pass returned no matching report. Save the file to retry it.'
        : staticRoleDescription(symbol.role),
    );
    appendRuntimeSummary(lines, inspection.output);
    return hover(lines, symbol.range, options);
  }

  for (const [index, target] of materialized.entries()) {
    if (materialized.length > 1) {
      lines.push(
        '',
        `#### Context ${index + 1} of ${materialized.length} · ${escapeMarkdown(target.target.label)}`,
      );
    } else if (target.target.label !== symbol.name) {
      if (target.target.id.startsWith('factory-result:')) {
        lines.push('', `_Using concrete factory result \`${escapeInline(target.target.label)}\`._`);
      } else if (isPipelineKind(target.report.kind)) {
        lines.push('', `_Using authored pipeline context \`${escapeInline(target.target.label)}\`._`);
      }
    }
    appendTarget(lines, target, inspection.output, options);
  }
  const hasRuntimeIssues = (inspection.output.warnings?.length ?? 0) > 0 ||
    (inspection.output.pageErrors?.length ?? 0) > 0;
  if (hoverSectionEnabled(options, 'runtime', level === 'deep' || hasRuntimeIssues)) {
    appendRuntimeSummary(
      lines,
      inspection.output,
      level === 'deep',
      level === 'deep' ? editorDefaultLedgerEntries(materialized) : [],
    );
  }
  return hover(lines, symbol.range, options);
}

/** Command links need trusted markdown; the VS Code client allow-lists these commands. */
function commandArguments(...values: unknown[]): string {
  return encodeURIComponent(JSON.stringify(values));
}

export function createInlayHints(
  discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
  currentVersion: number,
  requestedRange: Range,
  inspectingTargetIds: ReadonlySet<string> = new Set(),
  options: SurfaceOptions = defaultSurfaceOptions,
): InlayHint[] {
  const stale = inspection && inspection.sourceVersion !== currentVersion;
  return discovered.symbols
    .filter((symbol) =>
      symbol.targetIds.length > 0 &&
      rangesOverlap(symbol.range, requestedRange)
    )
    .flatMap((symbol) => {
      const inspecting = symbol.targetIds.some((id) =>
        inspectingTargetIds.has(id)
      );
      const firstTarget = symbol.targetIds
        .map((id) => inspection?.targets.get(id))
        .find((target) => target !== undefined);
      let label: string;
      let tooltip = 'Hover for TypeGPU inspection details.';

      if (inspecting) {
        label = '◌ inspecting…';
        tooltip = 'Runtime inspection is in progress. Hover again for the completed report.';
      } else if (firstTarget) {
        const analysis = firstTarget.analysis;
        const resource = firstTarget.report.resource;
        const pipelineState = firstTarget.pipelineState;
        const structural = firstTarget.report.ok
          ? undefined
          : uninspectableTargetDiagnostic(firstTarget.report);
        const details = uniqueStrings([
          resource?.bindings?.length
            ? plural(resource.bindings.length, 'binding')
            : analysis?.bindings.length
            ? plural(analysis.bindings.length, 'binding')
            : undefined,
          resource?.sizeBytes !== undefined
            ? formatByteSize(resource.sizeBytes)
            : undefined,
          pipelineState?.targets
            ? plural(pipelineState.targets.length, 'color target')
            : undefined,
          typeof pipelineState?.multisample?.count === 'number' &&
              pipelineState.multisample.count > 1
            ? `${pipelineState.multisample.count}× MSAA`
            : undefined,
          resource?.usages?.length
            ? resource.usages.join(' + ')
            : undefined,
          typeof pipelineState?.depthStencil?.format === 'string'
            ? `depth/stencil ${pipelineState.depthStencil.format}`
            : undefined,
          analysis ? formatByteSize(analysis.utf8Bytes) : undefined,
          firstTarget.report.resolutionMs !== undefined
            ? `resolve ${Math.round(firstTarget.report.resolutionMs)} ms`
            : undefined,
        ]);
        const inspectedKind = resource
          ? analysis ? 'resource + WGSL' : resource.resourceType
          : pipelineState?.kind === 'render'
          ? 'render pipeline'
          : pipelineState?.kind === 'compute'
          ? 'compute pipeline'
          : analysis
          ? 'WGSL'
          : shortRole(symbol.role);
        const inlayLevel = effectiveInlayLevel(options);
        const factLimit = inlayLevel === 'compact' ? 0 : inlayLevel === 'summary' ? 1 : 2;
        const compactDetails = inlayFacts(symbol, firstTarget, details).slice(0, factLimit);
        const hintStatus = stale
          ? '◌ stale'
          : firstTarget.report.ok
          ? '✓'
          : structural
          ? `◌ ${structuralHintLabel(structural.code)}`
          : '✗ inspect';
        label = compactHintLabel(
          `${hintStatus}${compactDetails.length > 0 ? ` ${compactDetails.join(' · ')}` : ''}`,
        );
        tooltip = [
          stale
            ? 'Showing the previous saved inspection.'
            : firstTarget.report.ok
            ? 'Runtime inspection passed.'
            : structural
            ? `Not inspectable standalone: ${formatTargetDiagnostic(structural)}`
            : `Runtime inspection failed: ${targetFailure(firstTarget.report)}`,
          `${inspectedKind}${details.length > 0 ? `: ${details.join(', ')}` : ''}.`,
          'Hover the symbol for the full resource, pipeline, WGSL, binding, and validation report.',
        ].join(' ');
      } else {
        if (!options.saveAffordance) return [];
        label = '◌ save';
        tooltip = 'A runtime target was derived. Save the file to inspect it.';
      }

      return [{
        position: symbol.range.end,
        label,
        paddingLeft: true,
        tooltip,
      }];
    });
}

export function createDocumentLinks(
  discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
): DocumentLink[] {
  if (!inspection) return [];
  const links: DocumentLink[] = [];
  for (const symbol of discovered.symbols) {
    for (const id of symbol.targetIds) {
      const target = inspection.targets.get(id);
      if (!target?.generatedUri) continue;
      links.push({
        range: symbol.range,
        target: target.generatedUri,
        tooltip: `Open generated WGSL for ${target.target.label}`,
      });
    }
  }
  return links;
}

export function createDiagnostics(
  sourceUri: string,
  discovered: DiscoveredModule,
  inspection: DocumentInspection,
  options: SurfaceOptions = defaultSurfaceOptions,
  externalSymbols: ExternalShaderSymbol[] = [],
): Diagnostic[] {
  if (inspection.failure) {
    const first = discovered.symbols[0];
    if (!first) return [];
    return [{
      range: first.range,
      severity: DiagnosticSeverity.Error,
      source: 'TypeGPU Inspector',
      code: 'runtime-inspection',
      message: inspection.failure,
    }];
  }

  const diagnostics: Diagnostic[] = [];
  for (const [id, runtimeFailure] of inspection.targetFailures ?? []) {
    const fallbackSymbol = discovered.symbols.find((symbol) =>
      symbol.targetIds.includes(id)
    );
    if (!fallbackSymbol) continue;
    diagnostics.push({
      range: fallbackSymbol.range,
      severity: DiagnosticSeverity.Error,
      source: 'TypeGPU Inspector',
      code: 'runtime-inspection',
      message: runtimeFailure,
      data: { sourceUri, targetId: id },
    });
  }

  const mappedEntries: MappedDiagnosticEntry[] = [];
  for (const [id, target] of inspection.targets) {
    const targetSymbols = discovered.symbols.filter((symbol) =>
      target.target.symbolNames.includes(symbol.name) || symbol.targetIds.includes(id)
    );
    const fallbackSymbol = targetSymbols[0];
    if (!fallbackSymbol) continue;
    // Compiler notes (Tint's uniformity chains, "value passed here", ...)
    // explain the error or warning before them; they join it as related
    // information instead of scattering as diagnostics of their own.
    let anchor: Diagnostic | undefined;
    for (const message of target.report.compilationMessages ?? []) {
      const severity = compilerSeverity(message.type);
      if (!severity) continue;
      const mapping = options.sourceMapping && target.report.wgsl
        ? mapWgslDiagnostic(
            target.report.wgsl,
            message,
            target.target,
            discovered.symbols,
            target.report.statementMap,
            externalSymbols,
          )
        : undefined;
      const generatedRange = mapping?.generatedRange ??
        (target.report.wgsl
          ? compilerGeneratedRange(target.report.wgsl, message)
          : undefined);
      if (severity === DiagnosticSeverity.Information && anchor) {
        const noteRange = mapping?.sourceRange !== undefined &&
            mapping.strategy !== 'declaration-name'
          ? mapping.relatedSource?.range ?? mapping.sourceRange
          : undefined;
        const location = noteRange
          ? { uri: mapping?.relatedSource?.uri ?? sourceUri, range: noteRange }
          : target.generatedUri && generatedRange
          ? { uri: target.generatedUri, range: generatedRange }
          : { uri: sourceUri, range: anchor.range };
        anchor.relatedInformation = [
          ...(anchor.relatedInformation ?? []),
          { location, message: message.message },
        ];
        continue;
      }
      const relatedInformation: DiagnosticRelatedInformation[] = [];
      if (mapping?.relatedSource) {
        relatedInformation.push(relatedSourceInformation(mapping.relatedSource, sourceUri));
      }
      if (target.generatedUri && generatedRange) {
        relatedInformation.push({
          location: { uri: target.generatedUri, range: generatedRange },
          message: mapping?.generatedDeclaration
            ? `in ${mapping.generatedDeclaration.kind} ${mapping.generatedDeclaration.name}`
            : 'generated WGSL',
        });
      }
      // High-confidence mappings pin the exact authored token. Medium
      // confidence (ordinal/inline heuristics that passed the ambiguity
      // refusals in sourceMapping.ts) still points at the guessed token, but
      // the diagnostic says so. A declaration-level fallback is not a guess:
      // the related location carries the generated line, and only when there
      // is none does the message name it.
      const pinned = mapping?.sourceRange !== undefined &&
        mapping.strategy !== 'declaration-name';
      const suffix = pinned && mapping.confidence === 'medium'
        ? ' (approximate source location)'
        : !pinned && relatedInformation.length === 0 && message.lineNum
        ? ` (generated WGSL line ${message.lineNum})`
        : '';
      const diagnostic: Diagnostic = {
        range: mapping?.sourceRange ?? fallbackSymbol.range,
        severity,
        source: 'TypeGPU Inspector',
        code: 'wgsl-compilation',
        message: `${target.target.label}: ${message.message}${suffix}${
          crossFileSuffix(mapping?.relatedSource)
        }`,
        ...(relatedInformation.length > 0 ? { relatedInformation } : {}),
        data: {
          sourceUri,
          targetId: id,
          ...(target.generatedUri ? { generatedUri: target.generatedUri } : {}),
          ...(generatedRange ? { generatedRange } : {}),
          ...crossFileData(mapping?.relatedSource),
          ...(mapping
            ? {
                mapping: {
                  confidence: mapping.confidence,
                  strategy: mapping.strategy,
                  ...(mapping.sourceSymbol
                    ? { sourceSymbol: mapping.sourceSymbol }
                    : {}),
                  ...(mapping.generatedToken
                    ? { generatedToken: mapping.generatedToken }
                    : {}),
                  ...(mapping.generatedDeclaration
                    ? { generatedDeclaration: mapping.generatedDeclaration }
                    : {}),
                },
              }
            : {}),
        },
      };
      diagnostics.push(diagnostic);
      mappedEntries.push(mappedEntry(diagnostic, `wgsl:${message.message}`, mapping, target, fallbackSymbol));
      if (severity !== DiagnosticSeverity.Information) anchor = diagnostic;
    }

    if (!target.report.ok && (target.report.compilationMessages?.length ?? 0) === 0) {
      // The runtime's statement map names the statement that aborted the
      // resolution exactly; a quoted snippet then only refines the column
      // within it. Without the map, a resolution trace names the failing
      // item (e.g. `asin`); when a trace name appears exactly once in the
      // authored shader tokens, point the diagnostic at that call instead of
      // the whole declaration. The path is walked deepest-first, so an
      // ambiguous leaf still maps to the nearest uniquely identifiable
      // enclosing helper.
      const failure = target.report.statementMap?.failure;
      const failureMapping = options.sourceMapping && failure
        ? mapResolutionFailure(failure, target.target, discovered.symbols, externalSymbols)
        : undefined;
      const trace = options.sourceMapping && !failureMapping
        ? parseResolutionTrace(target.report.error)
        : undefined;
      const tokenRange = failureMapping?.sourceRange
        ? (failureMapping.relatedSource
            ? undefined
            : quotedErrorSnippetRange(
                targetSymbols,
                target.report.error,
                failureMapping.sourceRange,
              )) ?? failureMapping.sourceRange
        : (trace
          ? resolutionTraceTokenRange(targetSymbols, trace)
          : undefined) ??
          (options.sourceMapping
            ? quotedErrorSnippetRange(targetSymbols, target.report.error)
            : undefined);
      const failureRelated: DiagnosticRelatedInformation[] = failureMapping?.relatedSource
        ? [relatedSourceInformation(failureMapping.relatedSource, sourceUri)]
        : [];
      // A structural condition (unbound slot, needs a wrapper, ...) means the
      // target just cannot be inspected standalone — the code is not wrong.
      // Hint severity keeps it out of the Problems panel and off the red path.
      const structural = structuralTargetDiagnostic(target.report);
      const environmental = structural ? undefined : environmentTargetDiagnostic(target.report);
      const diagnostic: Diagnostic = {
        range: tokenRange ?? fallbackSymbol.range,
        severity: structural || environmental
          ? DiagnosticSeverity.Hint
          : DiagnosticSeverity.Error,
        source: 'TypeGPU Inspector',
        code: structural
          ? 'target-not-standalone'
          : environmental
          ? 'inspection-unavailable'
          : 'target-resolution',
        message: structural
          ? `${target.target.label} is not inspectable standalone: ${targetFailure(target.report)}`
          : environmental
          ? `${target.target.label} could not be inspected here: ${targetFailure(target.report)}`
          : `${target.target.label}: ${targetFailure(target.report)}${
            crossFileSuffix(failureMapping?.relatedSource)
          }`,
        ...(failureRelated.length > 0 ? { relatedInformation: failureRelated } : {}),
        data: {
          sourceUri,
          targetId: id,
          ...crossFileData(failureMapping?.relatedSource),
          ...(failureMapping
            ? {
                mapping: {
                  confidence: failureMapping.confidence,
                  strategy: failureMapping.strategy,
                  ...(failureMapping.sourceSymbol
                    ? { sourceSymbol: failureMapping.sourceSymbol }
                    : {}),
                },
              }
            : {}),
        },
      };
      diagnostics.push(diagnostic);
      mappedEntries.push(mappedEntry(diagnostic, 'resolution', failureMapping, target, fallbackSymbol));
    }
  }
  settleCallSiteDiagnostics(mappedEntries, sourceUri);
  const dropped = collapseFanOut(mappedEntries);
  return deduplicateDiagnostics(diagnostics.filter((diagnostic) => !dropped.has(diagnostic)));
}

type MappedDiagnosticEntry = {
  diagnostic: Diagnostic;
  /** Diagnostics with the same key on the same statement report one finding. */
  coverageKey: string;
  /** The authored statement in another symbol of this file, when the diagnostic sits on its call site. */
  statement?: Range;
  targetLabel: string;
  targetRange: Range;
  /** The statement the diagnostic is about, in whichever file. */
  finding?: { range: Range; uri?: string };
  /** Whether the target declares the statement itself. */
  ownsStatement: boolean;
  anchor: 'statement' | 'call-site' | 'declaration';
  confidence?: 'high' | 'medium' | 'none';
  /** Helpers between the anchored call and the statement. */
  viaDepth: number;
};

function mappedEntry(
  diagnostic: Diagnostic,
  coverageKey: string,
  mapping: WgslDiagnosticMapping | undefined,
  target: { target: { label: string; symbolNames: string[] } },
  fallbackSymbol: DiscoveredSymbol,
): MappedDiagnosticEntry {
  const relatedSource = mapping?.relatedSource;
  return {
    diagnostic,
    coverageKey,
    ...(relatedSource && !relatedSource.uri ? { statement: relatedSource.range } : {}),
    targetLabel: target.target.label,
    targetRange: fallbackSymbol.range,
    ...(mapping?.authoredStatement ? { finding: mapping.authoredStatement } : {}),
    ownsStatement: mapping?.sourceSymbol !== undefined &&
      target.target.symbolNames.includes(mapping.sourceSymbol),
    anchor: mapping?.sourceRange === undefined
      ? 'declaration'
      : mapping.strategy === 'statement-call-site'
      ? 'call-site'
      : 'statement',
    ...(mapping ? { confidence: mapping.confidence } : {}),
    viaDepth: relatedSource?.via?.length ?? 0,
  };
}

/**
 * One finding, one diagnostic. Every target that inlines a helper reports
 * the helper's problem; after settling, the best-anchored report stays —
 * on the statement, else a direct call site, else the call site nearest to
 * the statement through other helpers, else the target's declaration — and
 * the targets of the others are recorded on it (`data.affectedTargets`, shown
 * in the finding hover). They get no related entries: their own inlay hints
 * and hovers already say they failed, and Zed would turn such entries into
 * hint markers on every one of them. Returns the diagnostics folded away.
 */
function collapseFanOut(entries: MappedDiagnosticEntry[]): Set<Diagnostic> {
  const groups = new Map<string, MappedDiagnosticEntry[]>();
  for (const entry of entries) {
    if (!entry.finding) continue;
    const { range, uri } = entry.finding;
    const key = `${entry.coverageKey}|${uri ?? ''}|${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const dropped = new Set<Diagnostic>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = group
      .map((entry, index) => ({ entry, rank: anchorRank(entry), index }))
      .sort((left, right) =>
        left.rank - right.rank ||
        Number(right.entry.ownsStatement) - Number(left.entry.ownsStatement) ||
        left.index - right.index
      );
    const best = ranked[0]!.rank;
    // Declarations say nothing about where the finding is reached; one is enough.
    const single = best === DECLARATION_ANCHOR_RANK;
    const kept: MappedDiagnosticEntry[] = [];
    const folded: MappedDiagnosticEntry[] = [];
    for (const { entry, rank } of ranked) {
      const duplicate = kept.some((keeper) =>
        rangeEquals(keeper.diagnostic.range, entry.diagnostic.range)
      );
      if (rank === best && !duplicate && !(single && kept.length > 0)) kept.push(entry);
      else folded.push(entry);
    }
    const primary = kept[0]!.diagnostic;
    primary.data = {
      ...(primary.data as object),
      affectedTargets: folded.map((entry) => entry.targetLabel),
    };
    for (const entry of folded) dropped.add(entry.diagnostic);
  }
  return dropped;
}

const DECLARATION_ANCHOR_RANK = 1000;

function anchorRank(entry: MappedDiagnosticEntry): number {
  const finding = entry.finding!;
  if (!finding.uri && rangeWithin(entry.diagnostic.range, finding.range)) return 0;
  if (entry.anchor === 'statement') return 0;
  if (entry.anchor === 'call-site') return 1 + entry.viaDepth;
  return DECLARATION_ANCHOR_RANK;
}

type RelatedSource = NonNullable<WgslDiagnosticMapping['relatedSource']>;

/** The helper statement behind a call-site diagnostic; the editor shows the location itself. */
function relatedSourceInformation(
  relatedSource: RelatedSource,
  sourceUri: string,
): DiagnosticRelatedInformation {
  return {
    location: { uri: relatedSource.uri ?? sourceUri, range: relatedSource.range },
    message: `in ${relatedSource.sourceSymbol}${viaSuffix(relatedSource)}`,
  };
}

/** `in shade (pbr.ts:98) via evaluateLight` — the file and line only when it is another file. */
function describeRelatedSource(relatedSource: RelatedSource): string {
  const where = relatedSource.uri
    ? ` (${basename(fileURLToPath(relatedSource.uri))}:${relatedSource.range.start.line + 1})`
    : '';
  return `in ${relatedSource.sourceSymbol}${where}${viaSuffix(relatedSource)}`;
}

function viaSuffix(relatedSource: RelatedSource): string {
  return relatedSource.via?.length ? ` via ${relatedSource.via.join(' → ')}` : '';
}

/**
 * A statement in another file is named in the message itself: related
 * locations in other files are not rendered by every editor (Zed drops
 * them), and the message is shown by all.
 */
function crossFileSuffix(relatedSource: RelatedSource | undefined): string {
  return relatedSource?.uri ? ` — ${describeRelatedSource(relatedSource)}` : '';
}

function crossFileData(relatedSource: RelatedSource | undefined): { relatedSource?: RelatedSource } {
  return relatedSource?.uri ? { relatedSource } : {};
}

/** `file:///…/pbr.ts#L98,3` — the fragment both VS Code and Zed follow from hover markdown. */
function locationLink(uri: string, range: Range): string {
  return `[${basename(fileURLToPath(uri))}:${range.start.line + 1}](${uri}#L${
    range.start.line + 1
  },${range.start.character + 1})`;
}

/**
 * Hover for a position inside a diagnostic whose statement lives in another
 * file: the finding with a link to that statement. Hover markdown links are
 * followed by every editor, unlike cross-file related information.
 */
export function createFindingHover(
  diagnostics: readonly Diagnostic[],
  position: Position,
): Hover | undefined {
  const findings = diagnostics.filter((diagnostic) =>
    containsPosition(diagnostic.range, position) &&
    (diagnostic.data as { relatedSource?: RelatedSource } | undefined)?.relatedSource?.uri
  );
  if (findings.length === 0) return undefined;
  const lines: string[] = [];
  for (const diagnostic of findings) {
    const data = diagnostic.data as {
      relatedSource: RelatedSource & { uri: string };
      affectedTargets?: string[];
    };
    const relatedSource = data.relatedSource;
    const message = String(diagnostic.message).replace(crossFileSuffix(relatedSource), '');
    if (lines.length > 0) lines.push('');
    lines.push(
      `**${escapeInline(message)}**`,
      '',
      `in \`${escapeInline(relatedSource.sourceSymbol)}\` — ${
        locationLink(relatedSource.uri, relatedSource.range)
      }${escapeInline(viaSuffix(relatedSource))}`,
    );
    const affected = data.affectedTargets ?? [];
    if (affected.length > 0) {
      lines.push(
        '',
        `Also affects ${plural(affected.length, 'target')}: ${
          affected.map((name) => `\`${escapeInline(name)}\``).join(', ')
        }.`,
      );
    }
  }
  return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n') } };
}

/** Appends `extra` under `hover`'s own content. */
export function appendHover(hover: Hover, extra: Hover | undefined): Hover {
  if (!extra) return hover;
  const value = (contents: Hover['contents']): string =>
    typeof contents === 'string'
      ? contents
      : Array.isArray(contents)
      ? contents.map((entry) => (typeof entry === 'string' ? entry : entry.value)).join('\n\n')
      : contents.value;
  return {
    ...hover,
    contents: {
      kind: MarkupKind.Markdown,
      value: `${value(hover.contents)}\n\n---\n\n${value(extra.contents)}`,
    },
  };
}

/**
 * A diagnostic parked on a call site moves onto the helper's statement when
 * nothing else reports that statement: a helper that passes standalone (a
 * uniformity error only exists in the caller's context, a slot only binds
 * there) would otherwise never get a squiggle on the offending line.
 */
function settleCallSiteDiagnostics(
  entries: MappedDiagnosticEntry[],
  sourceUri: string,
): void {
  for (const entry of entries) {
    const statement = entry.statement;
    if (!statement) continue;
    const covered = entries.some((other) =>
      other !== entry &&
      other.statement === undefined &&
      other.coverageKey === entry.coverageKey &&
      rangeWithin(other.diagnostic.range, statement)
    );
    if (covered) continue;
    const callSite = entry.diagnostic.range;
    entry.diagnostic.range = statement;
    entry.diagnostic.relatedInformation = (entry.diagnostic.relatedInformation ?? []).map(
      (info) =>
        info.location.uri === sourceUri && rangeEquals(info.location.range, statement)
          ? {
              location: { uri: sourceUri, range: callSite },
              message: `called from ${entry.targetLabel ?? 'here'}`,
            }
          : info,
    );
  }
}

function containsPosition(range: Range, position: Position): boolean {
  return comparePosition(position, range.start) >= 0 &&
    comparePosition(position, range.end) <= 0;
}

function rangeWithin(inner: Range, outer: Range): boolean {
  return comparePosition(outer.start, inner.start) <= 0 &&
    comparePosition(inner.end, outer.end) <= 0;
}

function rangeEquals(left: Range, right: Range): boolean {
  return comparePosition(left.start, right.start) === 0 &&
    comparePosition(left.end, right.end) === 0;
}

function mergeInspectorOutputs(
  previous: InspectorOutput,
  next: InspectorOutput,
): InspectorOutput {
  const targets = new Map<string, InspectorTargetReport>();
  for (const report of previous.targets ?? []) targets.set(report.label, report);
  for (const report of next.targets ?? []) targets.set(report.label, report);
  const mergedTargets = [...targets.values()];
  const passedTargetCount = mergedTargets.filter((target) => target.ok).length;
  const failedTargetCount = mergedTargets.length - passedTargetCount;

  return {
    ...previous,
    ...next,
    ok: mergedTargets.length > 0
      ? failedTargetCount === 0
      : previous.ok && next.ok,
    summary: {
      ...previous.summary,
      ...next.summary,
      targetCount: mergedTargets.length,
      passedTargetCount,
      failedTargetCount,
    },
    targets: mergedTargets,
    stats: { ...previous.stats, ...next.stats },
    environment: { ...previous.environment, ...next.environment },
    warnings: uniqueStrings([
      ...(previous.warnings ?? []),
      ...(next.warnings ?? []),
    ]),
    pageErrors: uniqueStrings([
      ...(previous.pageErrors ?? []),
      ...(next.pageErrors ?? []),
    ]),
  };
}

export const DETAIL_LEVELS = ['wgsl', 'compact', 'standard', 'deep'] as const;
export const INLAY_DETAIL_LEVELS = ['compact', 'summary', 'detailed'] as const;

const DETAIL_LEVEL_SUMMARIES: Record<HoverDetailLevel, string> = {
  wgsl: 'generated WGSL only',
  compact: 'core shape',
  standard: 'role-focused detail',
  deep: 'everything',
};

/**
 * Verbosity switcher for editors without their own settings UI affordance
 * (Zed reaches server features through the code-actions menu). VS Code users
 * get the richer QuickPick command instead, so the client decides whether to
 * surface these.
 */
export function createDetailLevelActions(
  current: HoverDetailLevel,
): CodeAction[] {
  return DETAIL_LEVELS.filter((level) => level !== current).map((level) => ({
    title: `TypeGPU hover detail: ${level} (${DETAIL_LEVEL_SUMMARIES[level]})`,
    kind: 'source.typegpuInspector',
    command: {
      title: `Set TypeGPU hover detail to ${level}`,
      command: 'typegpuInspector.setHoverDetailLevel',
      arguments: [level],
    },
  }));
}

export function createInlayDetailLevelActions(
  current: InlayDetailLevel,
): CodeAction[] {
  const summaries: Record<InlayDetailLevel, string> = {
    compact: 'status only',
    summary: 'one role-specific fact',
    detailed: 'two role-specific facts',
  };
  return INLAY_DETAIL_LEVELS.filter((level) => level !== current).map((level) => ({
    title: `TypeGPU inlays: ${level} (${summaries[level]})`,
    kind: 'source.typegpuInspector',
    command: {
      title: `Set TypeGPU inlays to ${level}`,
      command: 'typegpuInspector.setInlayDetailLevel',
      arguments: [level],
    },
  }));
}

function effectiveHoverLevel(options: SurfaceOptions): HoverDetailLevel {
  return options.hoverDetailLevel ?? 'standard';
}

function effectiveInlayLevel(options: SurfaceOptions): InlayDetailLevel {
  return options.inlayDetailLevel ?? 'compact';
}

function presentationSettings(options: SurfaceOptions): HoverPresentationSettings {
  return options.hoverPresentation ?? { sections: {}, sectionOrder: [] };
}

// Old section ids map onto the datasheet block.
const HOVER_SECTION_ALIASES: Partial<Record<HoverSectionId, HoverSectionId>> = {
  resource: 'datasheet',
  schema: 'datasheet',
  pipelineState: 'datasheet',
  pipelineContext: 'datasheet',
};

function canonicalSectionId(id: HoverSectionId): HoverSectionId {
  return HOVER_SECTION_ALIASES[id] ?? id;
}

function hoverSectionMode(
  options: SurfaceOptions,
  id: HoverSectionId,
): 'auto' | 'show' | 'hide' {
  const sections = presentationSettings(options).sections;
  const direct = sections[id];
  if (direct !== undefined) return direct;
  for (const [alias, canonical] of Object.entries(HOVER_SECTION_ALIASES)) {
    if (canonical !== id) continue;
    const mode = sections[alias as HoverSectionId];
    if (mode !== undefined) return mode;
  }
  return 'auto';
}

function hoverSectionEnabled(
  options: SurfaceOptions,
  id: HoverSectionId,
  auto: boolean,
): boolean {
  const mode = hoverSectionMode(options, id);
  return mode === 'show' || (mode === 'auto' && auto);
}

function columnBudget(options: SurfaceOptions): number {
  return presentationSettings(options).maxColumns ??
    options.defaultMaxColumns ?? WIDE_MAX_COLUMNS;
}

function previewLineBudget(options: SurfaceOptions, level: HoverDetailLevel): number {
  return presentationSettings(options).wgslPreviewLines ??
    (level === 'wgsl' ? WGSL_ONLY_PREVIEW_LINES : level === 'compact' ? 0 : level === 'standard' ? 6 : 12);
}

function collectionBudget(options: SurfaceOptions, level: HoverDetailLevel): number {
  return presentationSettings(options).collectionItems ??
    (level === 'deep' ? 50 : 12);
}

function declarationBudget(options: SurfaceOptions, level: HoverDetailLevel): number {
  return presentationSettings(options).declarations ??
    (level === 'deep' ? 24 : 8);
}

function noteBudget(options: SurfaceOptions, level: HoverDetailLevel): number {
  return presentationSettings(options).inspectionNotes ??
    (level === 'deep' ? 12 : 6);
}

function compilerMessageBudget(options: SurfaceOptions, level: HoverDetailLevel): number {
  return presentationSettings(options).compilerMessages ??
    (level === 'deep' ? 24 : 10);
}

function assumptionBudget(options: SurfaceOptions, level: HoverDetailLevel): number {
  return presentationSettings(options).assumptions ??
    (level === 'deep' ? 16 : 6);
}

const WGSL_ONLY_PREVIEW_LINES = 120;

const ALL_HOVER_SECTIONS: HoverSectionId[] = [
  'wgslPreview', 'datasheet', 'bindings', 'shaderFacts', 'declarations',
  'compilerMessages', 'inspectionNotes', 'assumptions', 'runtime',
];

function orderedHoverSections(options: SurfaceOptions): HoverSectionId[] {
  return uniqueSectionIds([
    ...presentationSettings(options).sectionOrder.map(canonicalSectionId),
    ...ALL_HOVER_SECTIONS,
  ]);
}

function uniqueSectionIds(values: HoverSectionId[]): HoverSectionId[] {
  return [...new Set(values)];
}

function inlayFacts(
  symbol: DiscoveredSymbol,
  target: MaterializedTarget,
  fallback: string[],
): string[] {
  const analysis = target.analysis;
  const resource = target.report.resource;
  const pipeline = target.pipelineState;
  const facts: Array<string | undefined> = [];
  if (symbol.specializationSynthesis) {
    facts.push(plural(
      symbol.specializationSynthesis.emitted,
      'specialization',
    ));
  }
  if (resource?.resourceType === 'collection') {
    const topLevelKind = resource.itemNames?.length ? 'field' : 'item';
    facts.push(
      resource.count !== undefined ? plural(resource.count, topLevelKind) : undefined,
      plural(flattenResourceCollection(resource).length, 'resource'),
    );
  } else if (symbol.role === 'compute-entrypoint' || symbol.role === 'compute-pipeline') {
    const invocations = analysis?.entryPoints.find((entry) => entry.stage === 'compute')
      ?.workgroupInvocations;
    facts.push(invocations !== undefined ? `${invocations} threads` : undefined);
  } else if (symbol.role === 'render-pipeline') {
    const format = pipeline?.targets?.[0]?.format;
    facts.push(typeof format === 'string' ? format : undefined);
    const samples = pipeline?.multisample?.count;
    facts.push(typeof samples === 'number' && samples > 1 ? `${samples}× MSAA` : undefined);
  } else if (symbol.role === 'schema') {
    facts.push(resource?.schema?.sizeBytes !== undefined
      ? formatByteSize(resource.schema.sizeBytes)
      : resource?.sizeBytes !== undefined ? formatByteSize(resource.sizeBytes) : undefined);
    const fields = resource?.schema?.fields?.length ?? resource?.schema?.fieldCount;
    facts.push(fields !== undefined ? plural(fields, 'field') : undefined);
  } else if (symbol.role === 'texture-resource' || symbol.role === 'texture-view') {
    facts.push(textureDimensions(resource?.properties));
    const format = resource?.properties?.format;
    facts.push(typeof format === 'string' ? format : undefined);
  } else if (symbol.role === 'buffer-resource' || symbol.role === 'gpu-variable') {
    facts.push(resource?.sizeBytes !== undefined ? formatByteSize(resource.sizeBytes) : undefined);
    facts.push(resource?.usages?.[0]);
  }
  return uniqueStrings([...facts, ...fallback]);
}

function textureDimensions(properties: Record<string, unknown> | undefined): string | undefined {
  const width = numberProperty(properties, 'width');
  const height = numberProperty(properties, 'height');
  const depth = numberProperty(properties, 'depthOrArrayLayers');
  if (width === undefined || height === undefined) return undefined;
  return [width, height, depth && depth > 1 ? depth : undefined].filter(Boolean).join('×');
}

export function createCodeActions(
  context: CodeActionContext,
): CodeAction[] {
  const actions: CodeAction[] = [];
  const seen = new Set<string>();
  for (const diagnostic of context.diagnostics) {
    if (diagnostic.source !== 'TypeGPU Inspector') continue;
    const data = isRecord(diagnostic.data) ? diagnostic.data : {};
    const generatedUri = typeof data.generatedUri === 'string'
      ? data.generatedUri
      : undefined;
    if (diagnostic.code === 'wgsl-compilation' && generatedUri) {
      const generatedRange = isRange(data.generatedRange)
        ? data.generatedRange
        : undefined;
      const key = `${generatedUri}:${JSON.stringify(generatedRange)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push({
        title: 'Open generated WGSL at compiler message',
        kind: CodeActionKind.QuickFix,
        diagnostics: [diagnostic],
        command: {
          title: 'Open generated WGSL',
          command: 'typegpuInspector.openGeneratedWgsl',
          arguments: [{ uri: generatedUri, selection: generatedRange }],
        },
      });
    }
  }
  return actions;
}

function appendTarget(
  lines: string[],
  target: MaterializedTarget,
  output: InspectorOutput,
  options: SurfaceOptions = defaultSurfaceOptions,
): void {
  const { report, analysis } = target;
  const level = effectiveHoverLevel(options);
  const structural = report.ok ? undefined : uninspectableTargetDiagnostic(report);
  const status = report.ok
    ? report.resource && analysis
      ? '✓ Resource inspected and WGSL validated'
      : report.resource
      ? '✓ Resource inspected'
      : target.pipelineState?.kind === 'render'
      ? '✓ Render pipeline validated'
      : target.pipelineState?.kind === 'compute'
      ? '✓ Compute pipeline validated'
      : '✓ WGSL validated'
    : structural
    ? ENVIRONMENT_TARGET_DIAGNOSTIC_CODES.has(structural.code)
      ? '◌ Inspection unavailable here'
      : '◌ Not inspectable standalone'
    : '✗ Inspection failed';
  lines.push('', `**${status}**`);

  const failureBannerDiagnostic = report.ok
    ? undefined
    : appendFailure(lines, report);

  const assumptionsMode = hoverSectionMode(options, 'assumptions');
  const assumptions = hoverAssumptions(report);
  const listAssumptions = assumptionsMode !== 'hide' &&
    (assumptionsMode === 'show' || level === 'deep');
  if (
    !listAssumptions &&
    assumptionsMode !== 'hide' &&
    level === 'standard' &&
    assumptions.length > 0
  ) {
    lines.push('', assumptionSummaryLine(assumptions));
  }
  const enabled = (id: HoverSectionId, auto: boolean) =>
    hoverSectionEnabled(options, id, auto);
  const maxColumns = columnBudget(options);
  const listDeclarations = Boolean(analysis?.declarations.length) &&
    enabled('declarations', level === 'deep');
  appendArtifactLinks(
    lines,
    target,
    options,
    listDeclarations ? undefined : analysis?.declarations.length,
  );

  const blocks = new Map<HoverSectionId, string[]>();
  const addBlock = (id: HoverSectionId, render: (block: string[]) => void) => {
    const block: string[] = [];
    render(block);
    if (block.length > 0) blocks.set(id, block);
  };

  const wgslOnly = level === 'wgsl' && Boolean(report.wgsl);
  const datasheet = buildDatasheet(target, output, level, options);
  if (!wgslOnly && enabled('datasheet', true)) {
    addBlock('datasheet', (block) => {
      appendDatasheet(block, datasheet.rows, maxColumns);
      if (report.resource) {
        appendResourceTables(
          block,
          report.resource,
          options,
          level === 'deep',
          collectionBudget(options, level),
          maxColumns,
        );
      }
    });
  }
  if (analysis && enabled('wgslPreview', level !== 'compact')) {
    addBlock('wgslPreview', (block) =>
      appendWgslPreview(block, report, previewLineBudget(options, level), wgslOnly));
  }
  if (analysis && enabled('shaderFacts', level !== 'compact')) {
    addBlock('shaderFacts', (block) =>
      appendShaderFacts(
        block,
        analysis,
        output,
        level !== 'compact',
        datasheet.statedEntryPoints,
      ));
  }
  if (enabled('bindings', hasAnyBindings(target))) {
    addBlock('bindings', (block) =>
      appendCorrelatedBindings(block, target, level === 'deep', maxColumns));
  }
  if (analysis && listDeclarations) {
    addBlock('declarations', (block) =>
      appendDeclarations(block, analysis, declarationBudget(options, level)));
  }
  if ((report.compilationMessages?.length ?? 0) > 0 && enabled('compilerMessages', true)) {
    addBlock('compilerMessages', (block) =>
      appendCompilerMessages(block, report, compilerMessageBudget(options, level)));
  }
  const listNotes = hoverSectionMode(options, 'inspectionNotes') === 'show' ||
    level === 'deep';
  const remainingDiagnostics = (report.diagnostics ?? []).filter((diagnostic) =>
    diagnostic !== failureBannerDiagnostic &&
    (listNotes || !isInformationalDiagnostic(diagnostic)));
  if (
    remainingDiagnostics.length > 0 &&
    enabled('inspectionNotes', level !== 'compact')
  ) {
    addBlock('inspectionNotes', (block) =>
      appendInspectionNotes(block, remainingDiagnostics, noteBudget(options, level)));
  }
  if (listAssumptions && assumptions.length > 0) {
    addBlock('assumptions', (block) =>
      appendAssumptions(
        block,
        assumptions,
        assumptionBudget(options, level),
        level === 'deep',
      ));
  }
  for (const id of orderedHoverSections(options)) {
    if (wgslOnly && id !== 'wgslPreview' && id !== 'compilerMessages') continue;
    const block = blocks.get(id);
    if (block) lines.push(...block);
  }
}

type TableFallback = (cells: readonly string[]) => string;

/** Renders rows as a table, or as key/value lines when a row exceeds maxColumns. */
function appendTable(
  lines: string[],
  header: readonly string[],
  alignment: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  maxColumns: number,
  fallback: TableFallback,
): void {
  if (rows.length === 0) return;
  if ([header, ...rows].every((row) => tableRowWidth(row) <= maxColumns)) {
    lines.push(`| ${header.map(escapeCell).join(' | ')} |`, `| ${alignment.join(' | ')} |`);
    for (const row of rows) lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
    return;
  }
  const rendered = rows.map(fallback);
  for (const [index, line] of rendered.entries()) {
    // Trailing two spaces are a hard break; without one the lines reflow into a paragraph.
    lines.push(index < rendered.length - 1 ? `${line}  ` : line);
  }
}

type DatasheetRow = {
  key: string;
  value: string;
  indent?: boolean;
};

// GFM trims leading ASCII spaces in cells; NBSP survives.
const ROW_INDENT = '\u00a0\u00a0';

function datasheetKeyCell(row: DatasheetRow): string {
  return `${row.indent ? ROW_INDENT : ''}**${escapeMarkdown(row.key)}**`;
}

function appendDatasheet(
  lines: string[],
  rows: readonly DatasheetRow[],
  maxColumns: number,
): void {
  if (rows.length === 0) return;
  lines.push('');
  appendTable(
    lines,
    ['', ''],
    ['---', '---'],
    rows.map((row) => [datasheetKeyCell(row), row.value]),
    maxColumns,
    (cells) => `${cells[0]!.replace(/\*\*$/, ':**')} ${cells[1]}`,
  );
}

/** Repeats the key across further rows so a long list stays inside maxColumns. */
function splitRow(
  key: string,
  parts: readonly string[],
  maxColumns: number,
): DatasheetRow[] {
  const budget = Math.max(8, maxColumns - key.length - ROW_INDENT.length - 3);
  const rows: DatasheetRow[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    rows.push({ key, value: current.join(' · '), ...(rows.length > 0 ? { indent: true } : {}) });
    current = [];
  };
  for (const part of parts) {
    const candidate = [...current, part].join(' · ');
    if (current.length > 0 && tableRowWidth([candidate]) > budget) flush();
    current.push(part);
  }
  flush();
  return rows;
}

type Datasheet = {
  rows: DatasheetRow[];
  statedEntryPoints: ReadonlySet<string>;
};

function buildDatasheet(
  target: MaterializedTarget,
  output: InspectorOutput,
  level: HoverDetailLevel,
  options: SurfaceOptions,
): Datasheet {
  const rows: DatasheetRow[] = [];
  const stated = new Set<string>();
  const { analysis, pipelineState, report } = target;
  const source = target.target.pipelineSource;
  const maxColumns = columnBudget(options);

  const entryStages = (analysis?.entryPoints ?? []).map((entry) =>
    `${entry.stage} ${code(entry.name)}`);
  const contextStages = [
    source?.compute ? `compute ${code(source.compute)}` : undefined,
    source?.vertex ? `vertex ${code(source.vertex)}` : undefined,
    source?.fragment ? `fragment ${code(source.fragment)}` : undefined,
  ].filter((stage): stage is string => Boolean(stage));
  const stages = entryStages.length > 0 ? entryStages : contextStages;
  if (stages.length > 0) {
    rows.push({
      key: stages.length > 1 ? 'Stages' : 'Entry',
      value: stages.join(' → '),
    });
    if (entryStages.length > 0) {
      for (const entry of analysis!.entryPoints) stated.add(entry.name);
    }
  }

  const limits = isRecord(output.environment?.limits)
    ? output.environment.limits
    : undefined;
  for (const entry of analysis?.entryPoints ?? []) {
    if (!entry.workgroupSize) continue;
    const dimensions = entry.workgroupSize.map(String).join(' × ');
    const limitSummary = workgroupLimitSummary(entry, limits);
    rows.push({
      key: (analysis?.entryPoints.length ?? 0) > 1
        ? `Workgroup ${entry.name}`
        : 'Workgroup',
      value: [
        `${dimensions}${
          entry.workgroupInvocations !== undefined
            ? ` = ${plural(entry.workgroupInvocations, 'invocation')}`
            : ''
        }`,
        ...limitSummary,
      ].join(' · '),
    });
  }

  if (pipelineState?.kind === 'render') {
    rows.push(...renderStateRows(pipelineState));
  }

  for (const binding of source?.bindings ?? []) {
    rows.push({
      key: 'Slot',
      value: binding.value
        ? `${code(binding.source)} ← ${code(binding.value)}`
        : code(binding.source),
    });
  }
  if (
    level === 'deep' && entryStages.length > 0 && contextStages.length > 0 &&
    contextStages.join(' → ') !== entryStages.join(' → ')
  ) {
    rows.push({ key: 'Context', value: contextStages.join(' → ') });
  }

  if (report.resource) {
    rows.push(
      ...resourceRows(report.resource, level === 'deep', maxColumns),
    );
    if (report.resource.schema) {
      rows.push(...schemaRows(report.resource.schema, options, maxColumns));
    }
  }
  return { rows, statedEntryPoints: stated };
}

function renderStateRows(state: GpuPipelineState): DatasheetRow[] {
  const rows: DatasheetRow[] = [];
  const primitive = state.primitive ?? {};
  const multisample = state.multisample ?? {};
  rows.push({
    key: 'Primitive',
    value: [
      term(primitive.topology ?? 'triangle-list'),
      term(primitive.frontFace ?? 'ccw'),
      `cull ${term(primitive.cullMode ?? 'none')}`,
      plural(
        typeof multisample.count === 'number' ? multisample.count : 1,
        'sample',
      ),
    ].join(' · '),
  });

  for (const [index, target] of (state.targets ?? []).entries()) {
    const blend = isRecord(target.blend) ? target.blend : undefined;
    rows.push({
      key: `Target ${index}`,
      value: [
        term(target.format ?? '—'),
        `write ${term(target.writeMask ?? 'all')}`,
        blend ? 'blend on' : 'blend off',
      ].join(' · '),
    });
    for (const [label, component] of [
      ['color blend', blend?.color],
      ['alpha blend', blend?.alpha],
    ] as const) {
      if (!isRecord(component)) continue;
      rows.push({
        key: label,
        indent: true,
        value: [
          `src ${term(component.srcFactor ?? 'one')}`,
          `dst ${term(component.dstFactor ?? 'zero')}`,
          term(component.operation ?? 'add'),
        ].join(' · '),
      });
    }
  }

  const depth = state.depthStencil;
  if (depth) {
    rows.push({
      key: 'Depth',
      value: [
        term(depth.format ?? '—'),
        depth.depthWriteEnabled === true ? 'write enabled' : 'write disabled',
        `compare ${term(depth.depthCompare ?? 'always')}`,
      ].join(' · '),
    });
    for (const [label, face] of [
      ['stencil front', depth.stencilFront],
      ['stencil back', depth.stencilBack ?? depth.stencilFront],
    ] as const) {
      if (!isRecord(face)) continue;
      rows.push({
        key: label,
        indent: true,
        value: [
          `compare ${term(face.compare ?? 'always')}`,
          `fail ${term(face.failOp ?? 'keep')}`,
          `depth fail ${term(face.depthFailOp ?? 'keep')}`,
          `pass ${term(face.passOp ?? 'keep')}`,
        ].join(' · '),
      });
    }
  }

  for (const [index, buffer] of (state.vertexBuffers ?? []).entries()) {
    rows.push({
      key: `Vertex slot ${index}`,
      value: [
        typeof buffer.arrayStride === 'number'
          ? `stride ${formatByteSize(buffer.arrayStride)}`
          : 'unknown stride',
        buffer.stepMode === 'instance' ? 'per-instance' : 'per-vertex',
      ].join(' · '),
    });
    const attributes = Array.isArray(buffer.attributes) ? buffer.attributes : [];
    if (attributes.length === 0) {
      rows.push({ key: 'no attributes', indent: true, value: '—' });
      continue;
    }
    for (const attribute of attributes) {
      if (!isRecord(attribute)) {
        rows.push({ key: 'attribute', indent: true, value: valueText(attribute) });
        continue;
      }
      rows.push({
        key: `@location(${String(attribute.shaderLocation ?? '?')})`,
        indent: true,
        value: [
          term(attribute.format ?? '?'),
          typeof attribute.offset === 'number'
            ? `offset ${formatByteSize(attribute.offset)}`
            : 'offset —',
        ].join(' · '),
      });
    }
  }
  return rows;
}

/** A vocabulary value: plain text, never a code span. */
function term(value: unknown): string {
  return valueText(value);
}

function appendWgslPreview(
  lines: string[],
  report: InspectorTargetReport,
  maxLines: number,
  fromTop = false,
): void {
  if (!report.wgsl || maxLines <= 0) return;
  const excerpt = fromTop ? leadingWgslExcerpt(report.wgsl, maxLines) : smartWgslExcerpt(report, maxLines);
  section(lines, 'Generated WGSL');
  lines.push('```wgsl', ...excerpt.lines, '```');
  if (excerpt.omitted > 0) lines.push(`_${plural(excerpt.omitted, 'WGSL line')} omitted._`);
}

function appendArtifactLinks(
  lines: string[],
  target: MaterializedTarget,
  options: SurfaceOptions,
  declarationCount?: number,
): void {
  const links: string[] = [];
  if (target.generatedUri) {
    const facts = target.analysis
      ? [
          plural(target.analysis.lines, 'line'),
          formatByteSize(target.analysis.utf8Bytes),
          declarationCount ? plural(declarationCount, 'declaration') : undefined,
        ].filter(Boolean).map((fact) => ` · ${fact}`).join('')
      : '';
    // VS Code opens the WGSL in its own live view; Zed gets the file on disk.
    if (options.presentation === 'vscode' && options.documentUri) {
      const args = commandArguments({
        uri: options.documentUri,
        targetId: target.target.id,
      });
      links.push(
        `[Open WGSL](command:typegpuInspector.openWgsl?${args} "Open the generated WGSL beside this editor")` +
          `  ·  [Peek](command:typegpuInspector.peekWgsl?${args} "Peek the generated WGSL inline")${facts}`,
      );
    } else {
      links.push(`[Open generated WGSL](${target.generatedUri})${facts}`);
    }
  }
  if (target.generatedReportUri) {
    links.push(`[Open full inspection report](${target.generatedReportUri})`);
  }
  if (links.length > 0) lines.push('', links.join('  ·  '));
}

function smartWgslExcerpt(
  report: InspectorTargetReport,
  maxLines: number,
): { lines: string[]; omitted: number } {
  const sourceLines = report.wgsl?.split(/\r?\n/) ?? [];
  if (sourceLines.length <= maxLines) return { lines: sourceLines, omitted: 0 };
  const compilerLine = (report.compilationMessages ?? [])
    .find((message) => message.type.toLowerCase() === 'error' && message.lineNum)?.lineNum ??
    (report.compilationMessages ?? []).find((message) => message.lineNum)?.lineNum;
  if (compilerLine) {
    const start = Math.max(0, compilerLine - 1 - Math.floor(maxLines / 2));
    const selected = sourceLines.slice(start, start + maxLines);
    return { lines: selected, omitted: sourceLines.length - selected.length };
  }
  const entryPoints = analyzeWgsl(report.wgsl ?? '').entryPoints.slice(0, 2);
  if (entryPoints.length > 1 && maxLines >= 5) {
    const perEntry = Math.max(2, Math.floor((maxLines - 1) / entryPoints.length));
    const selected: string[] = [];
    let sourceCount = 0;
    for (const [index, entry] of entryPoints.entries()) {
      if (index > 0) selected.push('…');
      const start = Math.max(0, entry.line - 1);
      const chunk = sourceLines.slice(start, start + perEntry);
      selected.push(...chunk);
      sourceCount += chunk.length;
    }
    return {
      lines: selected.slice(0, maxLines),
      omitted: Math.max(0, sourceLines.length - sourceCount),
    };
  }
  const start = entryPoints[0]
    ? Math.max(0, entryPoints[0].line - 1)
    : Math.max(0, sourceLines.findIndex((line) => line.trim() !== ''));
  const selected = sourceLines.slice(start, start + maxLines);
  return { lines: selected, omitted: sourceLines.length - selected.length };
}

function hasAnyBindings(target: MaterializedTarget): boolean {
  return (target.analysis?.bindings.length ?? 0) > 0 ||
    (target.report.resource?.bindings?.length ?? 0) > 0 ||
    (target.layouts?.some((layout) => layout.entries.length > 0) ?? false);
}

type CorrelatedBinding = {
  group: number;
  binding: number;
  name?: string;
  visibility?: string;
  wgsl?: string;
  webgpu?: string;
};

function appendCorrelatedBindings(
  lines: string[],
  target: MaterializedTarget,
  includeRawSources: boolean,
  maxColumns: number,
): void {
  const rows = new Map<string, CorrelatedBinding>();
  const row = (group: number, binding: number) => {
    const key = `${group}:${binding}`;
    const existing = rows.get(key);
    if (existing) return existing;
    const created: CorrelatedBinding = { group, binding };
    rows.set(key, created);
    return created;
  };
  for (const binding of target.analysis?.bindings ?? []) {
    const current = row(binding.group, binding.binding);
    current.name = binding.name;
    // `var<storage, read_write>` is one address space.
    current.wgsl = [binding.addressSpace?.replaceAll(/,\s*/g, ' '), binding.type]
      .filter(Boolean).join(' ');
  }
  for (const binding of target.report.resource?.bindings ?? []) {
    if (typeof binding.binding !== 'number') continue;
    const group = typeof binding.group === 'number' ? binding.group : 0;
    const current = row(group, binding.binding);
    if (typeof binding.name === 'string') current.name ??= binding.name;
    const visibility = formatShaderStages(binding.visibility);
    if (visibility !== '—') current.visibility ??= visibility;
    const declared = [binding.kind, formatBindingDetails(binding)]
      .filter((value) => value !== undefined && value !== '—')
      .map(String).join(' · ');
    if (declared) current.webgpu ??= declared;
  }
  for (const layout of target.layouts ?? []) {
    for (const entry of layout.entries) {
      const current = row(layout.group, entry.binding);
      if (entry.visibility !== '—') current.visibility = entry.visibility;
      current.webgpu = entry.resource;
    }
  }
  const sorted = [...rows.values()].sort((left, right) =>
    left.group - right.group || left.binding - right.binding);
  if (sorted.length === 0) return;
  section(lines, 'Bindings');
  const header = includeRawSources
    ? ['Binding', 'Type', 'Stages', 'WebGPU']
    : ['Binding', 'Type', 'Stages'];
  appendTable(
    lines,
    header,
    header.map(() => '---'),
    sorted.map((binding) => {
      const cells = [
        [
          tableCode(`@${binding.group}:${binding.binding}`),
          binding.name ? tableCode(binding.name) : undefined,
        ].filter(Boolean).join(' '),
        // A layout inspected without WGSL only knows its WebGPU description.
        tableText(binding.wgsl ?? binding.webgpu ?? '—'),
        tableText(binding.visibility ?? '—'),
      ];
      return includeRawSources
        ? [...cells, tableText(binding.webgpu ?? '—')]
        : cells;
    }),
    maxColumns,
    (cells) => `**${cells[0]}:** ${cells.slice(1).join(' · ')}`,
  );
  if (!includeRawSources) return;

  if ((target.analysis?.bindings.length ?? 0) > 0) {
    section(lines, 'Generated WGSL binding source');
    for (const binding of target.analysis!.bindings) {
      lines.push(`- ${code(`@${binding.group}:${binding.binding}`)} ${code(binding.name)} · ${term(binding.addressSpace ?? 'handle')} · ${term(binding.type)}`);
    }
  }
  if ((target.layouts?.length ?? 0) > 0) {
    section(lines, 'Recorded WebGPU layout source');
    for (const layout of target.layouts!) {
      for (const entry of layout.entries) {
        lines.push(`- ${code(`@${layout.group}:${entry.binding}`)} ${code(layout.label)} · ${valueText(entry.visibility)} · ${valueText(entry.resource)}`);
      }
    }
  }
}

function appendDeclarations(
  lines: string[],
  analysis: WgslAnalysis,
  limit: number,
): void {
  const preview = analysis.declarations.slice(0, limit);
  section(lines, `Declarations (${analysis.declarations.length})`);
  lines.push(preview.map((declaration) =>
    `\`${declaration.kind} ${escapeInline(declaration.name)}\` (line ${declaration.line})`)
    .join(' · '));
  if (preview.length < analysis.declarations.length) {
    lines.push(`_…and ${analysis.declarations.length - preview.length} more declarations. Open the full inspection report for all._`);
  }
}

function appendCompilerMessages(
  lines: string[],
  report: InspectorTargetReport,
  limit: number,
): void {
  section(lines, 'WGSL compiler messages');
  const messages = report.compilationMessages ?? [];
  for (const message of messages.slice(0, limit)) {
    const location = message.lineNum
      ? `line ${message.lineNum}${message.linePos ? `:${message.linePos}` : ''}: `
      : '';
    lines.push(`- **${escapeMarkdown(message.type)}** ${location}${valueText(message.message)}`);
  }
  if (messages.length > limit) {
    lines.push(`_…and ${messages.length - limit} more compiler messages. Open the full inspection report for all._`);
  }
}

function appendInspectionNotes(
  lines: string[],
  diagnostics: InspectorDiagnostic[],
  limit: number,
): void {
  section(lines, 'Inspection notes');
  for (const diagnostic of diagnostics.slice(0, limit)) {
    lines.push(`- ${valueText(diagnostic.message)} ${code(diagnostic.code)}`);
  }
  if (diagnostics.length > limit) {
    lines.push(`_…and ${diagnostics.length - limit} more notes. Open the full inspection report for all._`);
  }
}

/** Environment-tier entries describe the run itself and are never listed as assumptions. */
const EDITOR_DEFAULT_LEDGER_KEYS = new Set(['device-session:quiescent-run']);

function hoverAssumptions(
  report: InspectorTargetReport,
): NonNullable<InspectorTargetReport['ledger']> {
  return (report.ledger ?? []).filter((entry) =>
    !EDITOR_DEFAULT_LEDGER_KEYS.has(entry.key));
}

function editorDefaultLedgerEntries(
  targets: readonly MaterializedTarget[],
): InspectorLedgerEntry[] {
  return targets.flatMap((target) =>
    (target.report.ledger ?? []).filter((entry) =>
      EDITOR_DEFAULT_LEDGER_KEYS.has(entry.key)));
}

const LEDGER_KIND_LABELS: Record<string, string> = {
  'slot-value': 'slot values',
  'argument-values': 'arguments',
  'vertex-attribs': 'vertex attribs',
  'fragment-targets': 'targets',
  'pipeline-descriptor': 'pipeline descriptor',
  'dom-setup': 'DOM',
  'media-stream': 'media stream',
  'static-asset': 'static assets',
  'module-load': 'module load',
  'device-session': 'device session',
  'dependency-resolution': 'dependencies',
};

const MAX_SUMMARIZED_LEDGER_KINDS = 3;

/** One line naming the synthesized input categories. */
function assumptionSummaryLine(
  ledger: NonNullable<InspectorTargetReport['ledger']>,
): string {
  const satisfied = ledgerKindLabels(
    ledger.filter((entry) => entry.status !== 'unsatisfied'),
  );
  const unsatisfied = ledgerKindLabels(
    ledger.filter((entry) => entry.status === 'unsatisfied'),
  );
  const parts = [
    satisfied.length > 0
      ? `${plural(satisfied.length, 'synthesized input')} (${joinKindLabels(satisfied)})`
      : undefined,
    unsatisfied.length > 0
      ? `${plural(unsatisfied.length, 'unmet requirement')} (${joinKindLabels(unsatisfied)})`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return `_Inspected with ${parts.join(' and ')} — see deep hover or the full report._`;
}

function ledgerKindLabels(
  entries: NonNullable<InspectorTargetReport['ledger']>,
): string[] {
  return uniqueStrings(entries.map((entry) =>
    LEDGER_KIND_LABELS[entry.kind] ?? entry.kind.replaceAll('-', ' ')));
}

function joinKindLabels(labels: string[]): string {
  return labels.length > MAX_SUMMARIZED_LEDGER_KINDS
    ? `${labels.slice(0, MAX_SUMMARIZED_LEDGER_KINDS).join(', ')}, …`
    : labels.join(', ');
}

function appendAssumptions(
  lines: string[],
  ledger: NonNullable<InspectorTargetReport['ledger']>,
  limit: number,
  includeDomSetup: boolean,
): void {
  section(lines, 'Inspection assumptions');
  for (const entry of ledger.slice(0, limit)) {
    const subject = typeof entry.detail?.slotName === 'string'
      ? ` ${code(entry.detail.slotName)}`
      : '';
    lines.push(entry.status === 'satisfied'
      ? `- ${code(entry.kind)}${subject} — ${valueText(entry.provenance ?? 'satisfied')}${entry.provider ? ` _(${escapeMarkdown(entry.provider)})_` : ''}`
      : `- ${code(entry.kind)}${subject} — **unsatisfied**`);
  }
  if (ledger.length > limit) {
    lines.push(`_…and ${ledger.length - limit} more assumptions. Open the full inspection report for all._`);
  }
  if (includeDomSetup) {
    lines.push('- `dom-setup` — synthesized DOM with animation, resize, dispatch, and draw loops quiesced.');
  }
}

function appendShaderFacts(
  lines: string[],
  analysis: WgslAnalysis,
  output: InspectorOutput,
  includeOperations = true,
  statedEntryPoints: ReadonlySet<string> = new Set(),
): void {
  const operationEntries = [
    [analysis.operations.textureSamples, 'texture sample'],
    [analysis.operations.textureLoads, 'texture load'],
    [analysis.operations.textureStores, 'texture store'],
    [analysis.operations.atomics, 'atomic'],
    [analysis.operations.barriers, 'barrier'],
    [analysis.operations.derivatives, 'derivative'],
    [analysis.operations.discards, 'discard'],
    [analysis.operations.loops, 'loop'],
    [analysis.operations.branches, 'branch'],
  ] as const;
  const operations = operationEntries
    .filter(([count]) => count > 0)
    .map(([count, label]) => plural(count, label));
  const remaining = analysis.entryPoints.filter((entry) =>
    !statedEntryPoints.has(entry.name));
  const facts: string[] = [];
  if (remaining.length > 0) {
    facts.push(
      `**Entrypoints:** ${
        remaining.map((entry) => `${entry.stage} ${code(entry.name)}`).join(' · ')
      }`,
    );
  }

  const limits = isRecord(output.environment?.limits)
    ? output.environment.limits
    : undefined;
  for (const entry of remaining) {
    if (!entry.workgroupSize) continue;
    const dimensions = entry.workgroupSize.map(String).join(' × ');
    const total = entry.workgroupInvocations;
    const limitSummary = workgroupLimitSummary(entry, limits);
    facts.push(
      `**Workgroup ${code(entry.name)}:** ${dimensions}${
        total !== undefined ? ` = ${plural(total, 'invocation')}` : ''
      }${limitSummary.length > 0 ? ` · ${limitSummary.join(' · ')}` : ''}`,
    );
  }
  if (includeOperations && operations.length > 0) {
    facts.push(`**Static occurrences:** ${operations.join(' · ')}`);
  }
  if (facts.length === 0) return;

  if (facts.length > 1) {
    section(lines, 'Shader facts');
    for (const fact of facts) lines.push(`- ${fact}`);
    return;
  }
  lines.push('', facts[0]!);
}

function workgroupLimitSummary(
  entry: WgslAnalysis['entryPoints'][number],
  limits: Record<string, unknown> | undefined,
): string[] {
  if (!entry.workgroupSize || entry.workgroupInvocations === undefined) {
    return [];
  }
  const dimensions = entry.workgroupSize.map((dimension) =>
    Number(dimension.replace(/u$/, ''))
  );
  const dimensionLimits = [
    numberProperty(limits, 'maxComputeWorkgroupSizeX'),
    numberProperty(limits, 'maxComputeWorkgroupSizeY'),
    numberProperty(limits, 'maxComputeWorkgroupSizeZ'),
  ];
  const invocationLimit = numberProperty(
    limits,
    'maxComputeInvocationsPerWorkgroup',
  );
  const exceedsDimension = dimensions.some((dimension, index) =>
    dimensionLimits[index] !== undefined &&
    dimension > dimensionLimits[index]!
  );
  const exceedsInvocations =
    invocationLimit !== undefined &&
    entry.workgroupInvocations > invocationLimit;
  const status = exceedsDimension || exceedsInvocations
    ? '**exceeds device limit**'
    : invocationLimit !== undefined &&
        entry.workgroupInvocations === invocationLimit
    ? '**at device maximum**'
    : undefined;
  return [
    status,
    invocationLimit !== undefined
      ? `${invocationLimit} max`
      : undefined,
  ].filter((value): value is string => Boolean(value));
}

/**
 * Renders the failure banner and returns the diagnostic it consumed, if any,
 * so the caller can keep the remaining diagnostics in the notes section.
 * Ranking matches targetFailure: failure-explaining diagnostics, then the
 * actual runtime error, and setup notes only as a last resort.
 */
function appendFailure(
  lines: string[],
  report: InspectorTargetReport,
): InspectorDiagnostic | undefined {
  const diagnostics = report.diagnostics ?? [];
  const renderDiagnostic = (diagnostic: InspectorDiagnostic) => {
    lines.push('', `> **${valueText(diagnostic.message)}**`);
    if (diagnostic.hint) {
      lines.push(`> ${valueText(diagnostic.hint)}`);
    }
    lines.push(`> ${code(diagnostic.code)}`);
    return diagnostic;
  };
  const failureDiagnostic = diagnostics.find((diagnostic) =>
    !isInformationalDiagnostic(diagnostic));
  if (failureDiagnostic) return renderDiagnostic(failureDiagnostic);
  const trace = parseResolutionTrace(report.error);
  if (trace) {
    lines.push('', `> **${valueText(formatResolutionTrace(trace))}**`);
    return undefined;
  }
  const error = formatUnknownError(report.error);
  if (error) {
    lines.push('', `> ${valueText(error)}`);
    return undefined;
  }
  const note = diagnostics[0];
  if (note) return renderDiagnostic(note);
  lines.push('', '> Target did not resolve or validate.');
  return undefined;
}

const RESOURCE_PROPERTY_KEYS: Record<string, string> = {
  size: 'Size',
  format: 'Format',
  dimension: 'Dimension',
  viewDimension: 'View dimension',
  mipLevelCount: 'Mips',
  sampleCount: 'Samples',
  access: 'Access',
  label: 'Label',
  flags: 'Usage flags',
};

function resourcePropertyKey(
  name: string,
  resource: InspectorResourceReport,
): string {
  // `size` is a byte count on a buffer and an extent on a texture.
  if (name === 'size' && resource.sizeBytes !== undefined) return 'Extent';
  return RESOURCE_PROPERTY_KEYS[name] ?? name;
}

function formatPropertyValue(value: unknown): string {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number')
    ? value.join(' × ')
    : valueText(value);
}

function resourceRows(
  resource: InspectorResourceReport,
  deep: boolean,
  maxColumns: number,
): DatasheetRow[] {
  const rows: DatasheetRow[] = [];
  const isCollection = resource.resourceType === 'collection' &&
    resource.items !== undefined;
  if (isCollection) {
    const topLevelKind = resource.itemNames?.length ? 'field' : 'item';
    rows.push({
      key: 'Bundle',
      value: [
        resource.count !== undefined
          ? plural(resource.count, topLevelKind)
          : undefined,
        plural(
          flattenResourceCollection(resource).length,
          'resource leaf',
          'resource leaves',
        ),
      ].filter(Boolean).join(' · '),
    });
    return rows;
  }
  // A standalone schema states its type in the Layout row instead.
  if (!(resource.resourceType === 'schema' && resource.schema !== undefined)) {
    rows.push({ key: 'Kind', value: term(resource.resourceType) });
  }
  if (resource.count !== undefined) {
    rows.push({ key: 'Items', value: plural(resource.count, 'item') });
  }
  const usages = resourceUsageNames(resource);
  if (usages.length > 0) {
    rows.push(...splitRow('Usage', usages.map(term), maxColumns));
  }
  // Size and alignment come from the schema's Layout row when there is one.
  if (
    resource.sizeBytes !== undefined &&
    resource.schema?.sizeBytes !== resource.sizeBytes
  ) {
    rows.push({ key: 'Size', value: formatByteSize(resource.sizeBytes) });
  }
  if (
    resource.alignmentBytes !== undefined &&
    resource.schema?.alignmentBytes !== resource.alignmentBytes
  ) {
    rows.push({
      key: 'Alignment',
      value: formatByteSize(resource.alignmentBytes),
    });
  }
  for (const [name, value] of visibleResourceProperties(resource, deep)) {
    rows.push({
      key: resourcePropertyKey(name, resource),
      value: name === 'flags'
        ? formatUsageFlags(resource, value)
        : formatPropertyValue(value),
    });
  }
  return rows;
}

function appendResourceTables(
  lines: string[],
  resource: InspectorResourceReport,
  options: SurfaceOptions,
  includeRawBindings: boolean,
  collectionLimit: number,
  maxColumns: number,
): void {
  if (resource.schema) {
    appendSchemaFieldTable(lines, resource.schema, options, maxColumns);
  }

  if (includeRawBindings && resource.bindings && resource.bindings.length > 0) {
    section(lines, 'Declared bindings');
    appendTable(
      lines,
      ['Binding', 'Kind', 'Stages', 'Details'],
      ['---', '---', '---', '---'],
      resource.bindings.map((binding) => [
        typeof binding.name === 'string'
          ? `${formatCell(binding.binding)} ${tableCode(binding.name)}`
          : formatCell(binding.binding),
        tableText(binding.kind ?? '—'),
        tableText(formatShaderStages(binding.visibility)),
        tableText(formatBindingDetails(binding)),
      ]),
      maxColumns,
      (cells) => `**${cells[0]}:** ${cells.slice(1).join(' · ')}`,
    );
  }

  if (resource.attributes && resource.attributes.length > 0) {
    section(lines, 'Vertex attributes');
    appendTable(
      lines,
      ['Name', 'Format', 'Offset'],
      ['---', '---', '---:'],
      resource.attributes.map((attribute) => [
        tableCode(attribute.name ?? 'value'),
        tableText(attribute.format ?? '—'),
        formatCell(attribute.offsetBytes),
      ]),
      maxColumns,
      (cells) => `**${cells[0]}:** ${cells[1]} · offset ${cells[2]}`,
    );
  }

  if (resource.items && resource.items.length > 0) {
    appendResourceBundle(lines, resource, collectionLimit, maxColumns);
  }
}

type UsageFlagTable = ReadonlyArray<readonly [number, string]>;

// Binding roles first, then transfer and mapping bits.
const GPU_BUFFER_USAGE_FLAGS: UsageFlagTable = [
  [64, 'uniform'],
  [128, 'storage'],
  [32, 'vertex'],
  [16, 'index'],
  [256, 'indirect'],
  [512, 'query-resolve'],
  [4, 'copy-src'],
  [8, 'copy-dst'],
  [1, 'map-read'],
  [2, 'map-write'],
];

const GPU_TEXTURE_USAGE_FLAGS: UsageFlagTable = [
  [4, 'texture-binding'],
  [8, 'storage-binding'],
  [16, 'render-attachment'],
  [1, 'copy-src'],
  [2, 'copy-dst'],
];

const TYPEGPU_TEXTURE_USAGE_BITS: Record<string, string> = {
  sampled: 'texture-binding',
  storage: 'storage-binding',
  render: 'render-attachment',
};

function usageFlagTable(resourceType: string): UsageFlagTable | undefined {
  if (resourceType === 'buffer') return GPU_BUFFER_USAGE_FLAGS;
  if (resourceType === 'texture') return GPU_TEXTURE_USAGE_FLAGS;
  return undefined;
}

function decodeUsageFlags(resourceType: string, flags: unknown): string[] {
  const table = usageFlagTable(resourceType);
  if (!table || typeof flags !== 'number' || !Number.isInteger(flags)) return [];
  return table
    .filter(([bit]) => (flags & bit) !== 0)
    .map(([, name]) => name);
}

/** TypeGPU usage names plus whatever the raw mask adds. */
function resourceUsageNames(resource: InspectorResourceReport): string[] {
  const declared = resource.usages ?? [];
  const covered = new Set(declared.flatMap((usage) =>
    resource.resourceType === 'texture' && TYPEGPU_TEXTURE_USAGE_BITS[usage]
      ? [usage, TYPEGPU_TEXTURE_USAGE_BITS[usage]!]
      : [usage]));
  return [
    ...declared,
    ...decodeUsageFlags(resource.resourceType, resource.properties?.flags)
      .filter((name) => !covered.has(name)),
  ];
}

function formatUsageFlags(
  resource: InspectorResourceReport,
  flags: unknown,
): string {
  const decoded = decodeUsageFlags(resource.resourceType, flags);
  if (typeof flags !== 'number' || decoded.length === 0) return valueText(flags);
  return `0x${flags.toString(16)} · ${decoded.join(' · ')}`;
}

/** Below deep, drops rows restated elsewhere or stating nothing. */
function visibleResourceProperties(
  resource: InspectorResourceReport,
  deep: boolean,
): Array<[string, unknown]> {
  const entries = Object.entries(resource.properties ?? {});
  if (deep) return entries.filter(([name, value]) => name !== 'destroyed' || value !== false);
  const bindingCount = resource.bindings?.length;
  return entries.filter(([name, value]) => {
    if (name === 'flags') return false;
    if (name === 'hasDefault') return false;
    if (name === 'resourceType' || name.endsWith('ResourceType')) return false;
    if (name === 'entryCount' && value === bindingCount) return false;
    if (value === false) return false;
    return isPresentPropertyValue(value);
  });
}

function isPresentPropertyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function appendResourceBundle(
  lines: string[],
  resource: InspectorResourceReport,
  collectionLimit: number,
  maxColumns: number,
): void {
  const entries = (resource.items ?? []).map((item, index) => ({
    name: resource.itemNames?.[index] ?? `[${index}]`,
    item,
  }));
  section(lines, resource.itemNames?.length ? 'Bundle fields' : 'Collection items');
  appendTable(
    lines,
    [resource.itemNames?.length ? 'Field' : 'Item', 'Runtime shape'],
    ['---', '---'],
    entries.slice(0, collectionLimit).map(({ name, item }) => [
      tableCode(name),
      tableText(summarizeResourceShape(item)),
    ]),
    maxColumns,
    (cells) => `**${cells[0]}:** ${cells[1]}`,
  );
  if (entries.length > collectionLimit) {
    lines.push('', `_…and ${entries.length - collectionLimit} more fields. Open the full inspection report for all items._`);
  }

  const bindGroupShapes = collectBindGroupShapes(resource);
  if (bindGroupShapes.length === 0) return;
  section(lines, 'Bind-group shapes');
  appendTable(
    lines,
    ['Resource', 'Declared bindings'],
    ['---', '---'],
    bindGroupShapes.slice(0, collectionLimit).map((shape) => [
      tableCode(collapseIndexedPaths(shape.paths)),
      tableText(formatBundleBindings(shape.bindings)),
    ]),
    maxColumns,
    (cells) => `**${cells[0]}:** ${cells[1]}`,
  );
  if (bindGroupShapes.length > collectionLimit) {
    lines.push('', `_…and ${bindGroupShapes.length - collectionLimit} more bind-group shapes. Open the full inspection report for all items._`);
  }
}

function summarizeResourceShape(resource: InspectorResourceReport): string {
  const leaves = resource.resourceType === 'collection'
    ? flattenResourceCollection(resource).map(({ item }) => item)
    : [resource];
  if (leaves.length === 0) {
    return resource.count !== undefined
      ? `collection · ${plural(resource.count, 'item')}`
      : resource.resourceType;
  }

  const types = uniqueStrings(leaves.map((item) => item.resourceType));
  const typeSummary = types.length === 1
    ? `${types[0]}${resource.resourceType === 'collection' ? ` ×${leaves.length}` : ''}`
    : plural(leaves.length, 'resource');
  const commonFacts = commonResourceFacts(leaves);
  return [typeSummary, ...commonFacts].join(' · ');
}

function commonResourceFacts(resources: InspectorResourceReport[]): string[] {
  const facts = resources.map(resourceFacts);
  if (facts.length === 0) return [];
  return facts[0]!.filter((fact) => facts.every((candidate) => candidate.includes(fact)));
}

function resourceFacts(resource: InspectorResourceReport): string[] {
  const facts: string[] = [];
  if (resource.resourceType === 'texture') {
    const size = resource.properties?.size;
    if (Array.isArray(size) && size.every((value) => typeof value === 'number')) {
      facts.push(size.join('×'));
    }
    if (typeof resource.properties?.format === 'string') {
      facts.push(resource.properties.format);
    }
  }
  if (resource.resourceType === 'bind-group' && resource.bindings) {
    facts.push(plural(resource.bindings.length, 'binding'));
  }
  if (resource.sizeBytes !== undefined) facts.push(formatByteSize(resource.sizeBytes));
  if (resource.usages?.length) facts.push(resource.usages.join(' + '));
  return facts;
}

function collectBindGroupShapes(
  resource: InspectorResourceReport,
): Array<{ paths: string[]; bindings: Array<Record<string, unknown>> }> {
  const byShape = new Map<
    string,
    { paths: string[]; bindings: Array<Record<string, unknown>> }
  >();
  for (const { path, item } of flattenResourceCollection(resource)) {
    if (item.resourceType !== 'bind-group' || !item.bindings?.length) continue;
    const key = JSON.stringify(item.bindings);
    const current = byShape.get(key);
    if (current) {
      current.paths.push(path);
    } else {
      byShape.set(key, { paths: [path], bindings: item.bindings });
    }
  }
  return [...byShape.values()];
}

function collapseIndexedPaths(paths: string[]): string {
  if (paths.length < 2) return paths.join(', ');
  const parsed = paths.map((path) => /^(.*)\[(\d+)]$/.exec(path));
  const prefix = parsed[0]?.[1];
  if (
    prefix !== undefined &&
    parsed.every((match) => match?.[1] === prefix) &&
    parsed.map((match) => Number(match?.[2])).sort((a, b) => a - b)
      .every((value, index) => value === index)
  ) {
    return `${prefix}[*]`;
  }
  return paths.join(', ');
}

function formatBundleBindings(bindings: Array<Record<string, unknown>>): string {
  return bindings.map((binding) => {
    const index = typeof binding.binding === 'number' ? `@${binding.binding}` : '@?';
    const name = typeof binding.name === 'string' ? ` ${binding.name}` : '';
    const kind = typeof binding.kind === 'string' ? binding.kind : 'unknown';
    const detail = formatBindingDetails(binding);
    return `${index}${name}: ${kind}${detail === '—' ? '' : ` (${detail})`}`;
  }).join('; ');
}

function flattenResourceCollection(
  resource: InspectorResourceReport,
): Array<{ path: string; item: InspectorResourceReport }> {
  const rows: Array<{ path: string; item: InspectorResourceReport }> = [];
  const visit = (
    collection: InspectorResourceReport,
    prefix: string,
    depth: number,
  ): void => {
    if (depth >= 6 || rows.length >= 1_000) return;
    for (const [index, item] of (collection.items ?? []).entries()) {
      if (rows.length >= 1_000) return;
      const name = collection.itemNames?.[index];
      const segment = name ?? `[${index}]`;
      const path = prefix
        ? name
          ? `${prefix}.${segment}`
          : `${prefix}${segment}`
        : segment;
      if (item.resourceType === 'collection' && item.items?.length) {
        visit(item, path, depth + 1);
      } else {
        rows.push({ path, item });
      }
    }
  };
  visit(resource, '', 0);
  return rows;
}

function schemaRows(
  schema: InspectorSchemaReport,
  options: SurfaceOptions,
  maxColumns: number,
): DatasheetRow[] {
  const analysis = analyzeSchemaLayout(schema, {
    packingSuggestions: options.schemaPackingSuggestions,
  });
  const rows: DatasheetRow[] = [{
    key: 'Layout',
    value: [
      term(schema.type),
      schema.sizeBytes !== undefined
        ? `${formatByteSize(schema.sizeBytes)} size`
        : undefined,
      schema.alignmentBytes !== undefined
        ? `${schema.alignmentBytes}-byte alignment`
        : undefined,
      schema.elementCount !== undefined
        ? plural(schema.elementCount, 'element')
        : undefined,
      schema.elementStrideBytes !== undefined
        ? `${schema.elementStrideBytes}-byte stride`
        : undefined,
    ].filter(Boolean).join(' · '),
  }];

  const hostShareability = analysis.hostShareability;
  if (hostShareability.status !== 'not-applicable') {
    rows.push({
      key: 'Host-shareable',
      value: `${
        hostShareability.status === 'yes'
          ? 'Yes'
          : hostShareability.status === 'no'
          ? 'No'
          : 'Unknown'
      }${hostShareability.reason ? ` — ${valueText(hostShareability.reason)}` : ''}`,
    });
  }

  const showLayoutHealth = options.schemaLayoutHealth &&
    ((schema.fields?.length ?? 0) > 0 ||
    (
      schema.element !== undefined &&
      schema.elementCount !== undefined &&
      schema.elementStrideBytes !== undefined
    ));
  if (
    showLayoutHealth &&
    analysis.allocatedBytes !== undefined &&
    analysis.dataBytes !== undefined &&
    analysis.paddingBytes !== undefined
  ) {
    rows.push({
      key: 'Memory',
      value: (analysis.paddingBytes > 0
        ? [
            `${formatByteSize(analysis.allocatedBytes)} allocated`,
            `${formatByteSize(analysis.dataBytes)} data`,
            `${formatByteSize(analysis.paddingBytes)} padding (${
              Math.round((analysis.paddingRatio ?? 0) * 100)
            }%)`,
          ]
        : [
            `${formatByteSize(analysis.allocatedBytes)} allocated`,
            'no padding',
          ]).join(' · '),
    });
    if (analysis.paddingRegions.length > 0) {
      const preview = analysis.paddingRegions.slice(0, 6);
      const omitted = analysis.paddingRegions.length - preview.length;
      rows.push(...splitRow(
        'Padding map',
        [
          ...preview.map((region) =>
            `${formatByteSize(region.bytes)} ${code(region.label)}`),
          ...(omitted > 0
            ? [`…${omitted} more ${omitted === 1 ? 'region' : 'regions'}`]
            : []),
        ],
        maxColumns,
      ));
    }
    if (analysis.reorder) {
      rows.push(...splitRow('Tighter order', [
        analysis.reorder.suggestedOrder.map((field) => code(field)).join(' → '),
        `${formatByteSize(analysis.reorder.currentBytes)} → ${formatByteSize(analysis.reorder.optimizedBytes)}`,
        `save ${formatByteSize(analysis.reorder.savingsBytes)}`,
      ], maxColumns));
    }
  }
  return rows;
}

function appendSchemaFieldTable(
  lines: string[],
  schema: InspectorSchemaReport,
  options: SurfaceOptions,
  maxColumns: number,
): void {
  const analysis = analyzeSchemaLayout(schema, {
    packingSuggestions: options.schemaPackingSuggestions,
  });
  if (!analysis.completeness.complete) {
    const omittedFields = analysis.completeness.omittedFields !== undefined
      ? ` · ${plural(analysis.completeness.omittedFields, 'field')} beyond the WGSL-required limit omitted`
      : '';
    const location = analysis.completeness.path
      ? ` at ${code(analysis.completeness.path)}`
      : '';
    lines.push(
      '',
      `_Schema report is incomplete${location}${omittedFields}. See the full report for its truncation reason._`,
    );
  }
  if (analysis.fields.length === 0) return;

  const rows = analysis.fields.map((field) => {
    const layout = [
      field.schema.sizeBytes !== undefined
        ? formatByteSize(field.schema.sizeBytes)
        : undefined,
      field.schema.alignmentBytes !== undefined
        ? `align ${formatByteSize(field.schema.alignmentBytes)}`
        : undefined,
    ].filter(Boolean).join(' · ');
    return [
      tableCode(field.path),
      formatCell(field.offsetBytes),
      // WGSL type names stay in code spans.
      tableCode(field.schema.type),
      tableText(layout || '—'),
    ];
  });
  lines.push('');
  // Drop the Layout column before giving up the table.
  const narrowed = rows.every((row) =>
      tableRowWidth(row) <= maxColumns
    )
    ? rows
    : rows.map((row) => row.slice(0, 3));
  appendTable(
    lines,
    ['Field', 'Offset', 'Type', 'Layout'].slice(0, narrowed[0]!.length),
    ['---', '---:', '---', '---'].slice(0, narrowed[0]!.length),
    narrowed,
    maxColumns,
    (cells) =>
      `**${cells[0]}:** offset ${cells[1]} · ${cells.slice(2).join(' · ')}`,
  );
}

function formatShaderStages(value: unknown): string {
  if (!Array.isArray(value)) return formatInspectableValue(value);
  const stages = value.filter((stage): stage is string =>
    typeof stage === 'string'
  );
  if (
    stages.includes('compute') &&
    stages.includes('vertex') &&
    stages.includes('fragment')
  ) {
    return 'all stages';
  }
  return stages.join(' · ') || '—';
}

function formatBindingDetails(binding: Record<string, unknown>): string {
  const schema = isRecord(binding.schema) ? binding.schema : undefined;
  const schemaProperties = isRecord(schema?.properties)
    ? schema.properties
    : undefined;
  const details = [
    typeof schema?.type === 'string' ? schema.type : undefined,
    schemaProperties?.format,
    schemaProperties?.access,
    binding.access,
    binding.samplerType,
    binding.sampleType,
  ].filter((value) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  );
  return details.map(String).join(' · ') || '—';
}

function formatCell(value: unknown): string {
  return typeof value === 'number' ? String(value) : '—';
}

function appendRuntimeSummary(
  lines: string[],
  output: InspectorOutput,
  includeMetadata = true,
  editorDefaults: readonly InspectorLedgerEntry[] = [],
): void {
  const summary = output.summary;
  const stats = output.stats;
  const environmentGpuType = stringProperty(output.environment, 'gpuType');
  const environmentBrowser = stringProperty(
    output.environment,
    'browserVersion',
  );
  const totalMs = output.summary?.totalMs ??
    nestedNumberProperty(stats, 'timings', 'totalMs');
  const runtimeIssues = uniqueStrings([
    ...(output.warnings ?? []),
    ...(output.pageErrors ?? []),
  ]).slice(0, MAX_RUNTIME_NOTES);
  const defaultNotes = uniqueStrings(
    editorDefaults.map((entry) => entry.provenance),
  );
  if (runtimeIssues.length > 0 || defaultNotes.length > 0) {
    section(lines, 'Runtime notes');
    for (const issue of runtimeIssues) {
      lines.push(`- ${valueText(issue)}`);
    }
    for (const note of defaultNotes) {
      lines.push(`- ${valueText(note)}`);
    }
  }
  const details = includeMetadata ? [
    totalMs !== undefined ? `${Math.round(totalMs)} ms` : undefined,
    formatGpuType(summary?.gpuType ?? environmentGpuType),
    formatBrowserVersion(summary?.browserVersion ?? environmentBrowser),
  ].filter(Boolean) : [];
  if (details.length > 0) {
    lines.push('', `_${details.join(' · ')}_`);
  }
}

function formatGpuType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `${value} WebGPU`;
}

function formatBrowserVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const major = /^\d+/.exec(value)?.[0];
  return major ? `Chromium ${major}` : value;
}

function stringProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const property = value?.[key];
  return typeof property === 'string' ? property : undefined;
}

function numberProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const property = value?.[key];
  return typeof property === 'number' ? property : undefined;
}

function nestedNumberProperty(
  value: Record<string, unknown> | undefined,
  objectKey: string,
  numberKey: string,
): number | undefined {
  const nested = value?.[objectKey];
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    return undefined;
  }
  const property = (nested as Record<string, unknown>)[numberKey];
  return typeof property === 'number' ? property : undefined;
}

function hover(
  lines: string[],
  range: Range,
  options: SurfaceOptions = defaultSurfaceOptions,
): Hover {
  const presented = options.presentation === 'vscode'
    ? presentForVsCode(lines, columnBudget(options))
    : lines;
  const contents: MarkupContent = {
    kind: MarkupKind.Markdown,
    value: presented.join('\n'),
  };
  return { contents, range };
}

/**
 * VS Code renders markdown tables in hovers nearly unstyled, so convert them
 * to aligned mono grids inside fenced blocks, and separate sections with
 * horizontal rules. Operates on our own regular output: a table is always a
 * header row, a `| --- |` separator, then data rows.
 */
function presentForVsCode(
  lines: string[],
  maxColumns = WIDE_MAX_COLUMNS,
): string[] {
  const result: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (
      line.startsWith('|') &&
      next !== undefined &&
      /^\|(\s*:?---+:?\s*\|)+$/.test(next.replaceAll(' ', ''))
    ) {
      const rows: string[][] = [parseTableRow(line, maxColumns)];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor]!.startsWith('|')) {
        rows.push(parseTableRow(lines[cursor]!, maxColumns));
        cursor++;
      }
      result.push(...renderMonoGrid(rows));
      index = cursor - 1;
      continue;
    }
    // A full-bold line is a section heading (see markdown.ts `section`).
    if (/^\*\*[^*].*\*\*$/.test(line) && result.length > 1) {
      result.push('---', '');
    }
    result.push(line);
  }
  return result;
}

function parseTableRow(line: string, limit: number): string[] {
  const inner = line.replace(/^\|\s*/, '').replace(/\s*\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => plainCellText(cell, limit));
}

function plainCellText(cell: string, limit: number): string {
  const text = cell
    .trim()
    .replaceAll('\u200b', '')
    .replaceAll('\u00a0', ' ')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .replaceAll(/\\([\\`*_[\]<>|])/g, '$1');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function renderMonoGrid(input: string[][]): string[] {
  // The datasheet's header row is empty.
  const rows = input.length > 1 && input[0]!.every((cell) => cell === '')
    ? input.slice(1)
    : input;
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)));
  const rendered = rows.map((row) =>
    widths
      .map((width, column) => (row[column] ?? '').padEnd(width))
      .join('  ')
      .trimEnd());
  return ['```text', ...rendered, '```'];
}

async function writeGeneratedWgsl(
  workspaceRoot: string,
  modulePath: string,
  target: InspectionTarget,
  wgsl: string,
): Promise<string> {
  const workspaceKey = shortHash(workspaceRoot);
  const moduleKey = shortHash(modulePath);
  const directory = join(
    tmpdir(),
    'typegpu-inspector',
    workspaceKey,
    moduleKey,
  );
  await mkdir(directory, { recursive: true });
  const fileName = `${stripExtension(basename(modulePath))}__${safeName(target.label)}.wgsl`;
  const outputPath = join(directory, fileName);
  await writeFile(outputPath, wgsl, 'utf8');
  return pathToFileURL(outputPath).toString();
}

async function writeGeneratedReport(
  workspaceRoot: string,
  modulePath: string,
  target: MaterializedTarget,
  output: InspectorOutput,
): Promise<string> {
  const workspaceKey = shortHash(workspaceRoot);
  const moduleKey = shortHash(modulePath);
  const directory = join(
    tmpdir(),
    'typegpu-inspector',
    workspaceKey,
    moduleKey,
  );
  await mkdir(directory, { recursive: true });
  const fileName = `${stripExtension(basename(modulePath))}__${safeName(target.target.label)}.typegpu.md`;
  const outputPath = join(directory, fileName);
  const lines = [`# TypeGPU inspection · ${escapeMarkdown(target.target.label)}`];
  appendTarget(lines, target, output, {
    ...defaultSurfaceOptions,
    hoverDetailLevel: 'deep',
    inlayDetailLevel: 'detailed',
    hoverPresentation: {
      sections: {},
      sectionOrder: [],
      // Files scroll: no width fallback.
      maxColumns: settingsBounds.maxColumns.max,
      wgslPreviewLines: 20,
      collectionItems: 1_000,
      declarations: Math.max(1, target.analysis?.declarations.length ?? 1),
      compilerMessages: Math.max(1, target.report.compilationMessages?.length ?? 1),
      inspectionNotes: Math.max(1, target.report.diagnostics?.length ?? 1),
      assumptions: Math.max(1, target.report.ledger?.length ?? 1),
    },
  });
  appendRuntimeSummary(lines, output, true, editorDefaultLedgerEntries([target]));
  await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
  return pathToFileURL(outputPath).toString();
}

// Codes emitted by inspector versions that predate the diagnostic `severity`
// field. Newer runtimes tag setup context with severity 'note' directly.
const INFORMATIONAL_TARGET_DIAGNOSTIC_CODES = new Set([
  'inspection-defaults-applied',
  'direct-symbol-inspection',
  'pipeline-wrapper-unwrapped',
  'pipeline-validated-without-recorded-creation',
]);

/** Setup notes must not shadow the actual error. */
function isInformationalDiagnostic(diagnostic: InspectorDiagnostic): boolean {
  if (diagnostic.severity !== undefined) return diagnostic.severity === 'note';
  return INFORMATIONAL_TARGET_DIAGNOSTIC_CODES.has(diagnostic.code);
}

// The target cannot be inspected in isolation (unbound slot, needs a wrapper,
// not a shader-resolvable value, ...). The user's code is not wrong, so these
// must never surface as red errors — they render as a subtle hint, a neutral
// "◌" inlay, and an explanatory hover note instead.
const STRUCTURAL_TARGET_DIAGNOSTIC_CODES = new Set([
  'slot-binding-required',
  'wrapper-required',
  'reference-wrapper-required',
  'not-shader-resolvable',
  'plain-object-not-inspectable',
  'cpu-function-not-inspectable',
  'typegpu-vertex-function-not-resolvable',
  'typegpu-fragment-function-not-resolvable',
  'typegpu-compute-function-not-resolvable',
  'typegpu-value-not-resolvable',
  'three-node-not-inspectable',
  'value-not-inspectable',
  'unsupported-internal-resource',
  'pipeline-resource-shape',
  'raw-webgpu-pipeline-unsupported',
  'three-tsl-wrapper-required',
  'webgl-backend-not-inspectable',
  // The inspector's own probe could not be assembled: a schema selector it
  // synthesized did not resolve to a callable schema. Never the code's fault.
  'selector-not-resolved',
  'probe-argument-not-synthesizable',
]);

// The harness, not the target, failed: the browser lacked a capability the
// module needs at import (image decoding, camera), the device was lost, or
// the run timed out. The code may well be fine, so these never go red.
const ENVIRONMENT_TARGET_DIAGNOSTIC_CODES = new Set([
  'browser-capability-unavailable',
  'canvas-dom-setup-required',
  'gpu-feature-unavailable',
  'module-import-failed',
  'webgpu-device-lost',
  'inspection-timeout',
  'webgpu-validation-timeout',
  'result-serialization-failed',
]);

/** The diagnostic explaining why the harness could not inspect this target, if that is what failed. */
function environmentTargetDiagnostic(
  report: InspectorTargetReport,
): InspectorDiagnostic | undefined {
  const failure = (report.diagnostics ?? []).find((diagnostic) =>
    !isInformationalDiagnostic(diagnostic));
  return failure && ENVIRONMENT_TARGET_DIAGNOSTIC_CODES.has(failure.code)
    ? failure
    : undefined;
}

/** A structural or environmental failure: the target is not wrong, it just could not be inspected here. */
function uninspectableTargetDiagnostic(
  report: InspectorTargetReport,
): InspectorDiagnostic | undefined {
  return structuralTargetDiagnostic(report) ?? environmentTargetDiagnostic(report);
}

/** The diagnostic explaining why this target is not standalone-inspectable, if that is what failed. */
function structuralTargetDiagnostic(
  report: InspectorTargetReport,
): InspectorDiagnostic | undefined {
  const failure = (report.diagnostics ?? []).find((diagnostic) =>
    !isInformationalDiagnostic(diagnostic));
  return failure && STRUCTURAL_TARGET_DIAGNOSTIC_CODES.has(failure.code)
    ? failure
    : undefined;
}

function structuralHintLabel(code: string): string {
  switch (code) {
    case 'slot-binding-required':
      return 'needs slot binding';
    case 'wrapper-required':
      return 'needs wrapper';
    default:
      return ENVIRONMENT_TARGET_DIAGNOSTIC_CODES.has(code)
        ? 'inspection unavailable'
        : 'not standalone';
  }
}

function formatTargetDiagnostic(diagnostic: InspectorDiagnostic): string {
  return `${diagnostic.message}${diagnostic.hint ? ` — ${diagnostic.hint}` : ''}`;
}

function targetFailure(report: InspectorTargetReport): string {
  const diagnostics = report.diagnostics ?? [];
  const failureDiagnostic = diagnostics.find((diagnostic) =>
    !isInformationalDiagnostic(diagnostic));
  if (failureDiagnostic) return formatTargetDiagnostic(failureDiagnostic);
  const trace = parseResolutionTrace(report.error);
  if (trace) return formatResolutionTrace(trace);
  const error = formatUnknownError(report.error);
  if (error) return error;
  const note = diagnostics[0];
  if (note) return formatTargetDiagnostic(note);
  return 'Target did not resolve or validate.';
}

function resolutionTraceTokenRange(
  symbols: DiscoveredSymbol[],
  trace: ResolutionTrace,
): Range | undefined {
  for (let index = trace.path.length - 1; index >= 0; index--) {
    const range = uniqueShaderTokenRange(symbols, traceItemToken(trace.path[index]!));
    if (range) return range;
  }
  return undefined;
}

/**
 * TypeGPU errors often quote the offending authored statement verbatim
 * (`'MutableBoid.$.pos = newPos' is invalid ...`). When the resolution trace
 * has no mappable named item — the failure is a statement inside the target
 * itself — matching the quoted snippet's identifier sequence against the
 * authored shader tokens still pins the exact line.
 */
function quotedErrorSnippetRange(
  symbols: DiscoveredSymbol[],
  error: unknown,
  within?: Range,
): Range | undefined {
  const message = readErrorText(error);
  if (!message) return undefined;
  for (const [, snippet] of message.matchAll(/'([^'\n]{2,160})'/g)) {
    const words = snippet!.match(/[A-Za-z_$][\w$]*/g) ?? [];
    // Single identifiers are too ambiguous to pin a location safely.
    if (words.length < 2) continue;
    for (const symbol of symbols) {
      const tokens = (symbol.shaderSourceTokens ?? []).filter((token) =>
        within === undefined ||
        (comparePosition(within.start, token.range.start) <= 0 &&
          comparePosition(token.range.end, within.end) <= 0)
      );
      const range = tightestTokenWindow(tokens, words);
      if (range) return range;
    }
  }
  return undefined;
}

/** The tightest in-order occurrence of `words` in the token stream, if any. */
function tightestTokenWindow(
  tokens: ShaderSourceToken[],
  words: string[],
): Range | undefined {
  let best: { start: number; end: number } | undefined;
  for (let start = 0; start < tokens.length; start++) {
    if (tokens[start]!.text !== words[0]) continue;
    let matched = 1;
    let cursor = start + 1;
    // Punctuation and operators sit between identifiers in the token stream,
    // so allow slack, but bounded — a window scattered across the whole body
    // is a coincidence, not the quoted statement.
    while (
      matched < words.length &&
      cursor < tokens.length &&
      cursor - start < words.length * 3
    ) {
      if (tokens[cursor]!.text === words[matched]) matched++;
      cursor++;
    }
    if (matched === words.length) {
      const end = cursor - 1;
      if (!best || end - start < best.end - best.start) {
        best = { start, end };
      }
    }
  }
  return best
    ? {
        start: tokens[best.start]!.range.start,
        end: tokens[best.end]!.range.end,
      }
    : undefined;
}

function readErrorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return undefined;
}

/** `rotateXY(f32)` and similar signature-carrying trace names token-match on `rotateXY`. */
function traceItemToken(name: string): string {
  const parenIndex = name.indexOf('(');
  return (parenIndex === -1 ? name : name.slice(0, parenIndex)).trim();
}

function uniqueShaderTokenRange(
  symbols: DiscoveredSymbol[],
  tokenText: string,
): Range | undefined {
  if (tokenText === '') return undefined;
  const matches = symbols.flatMap((symbol) =>
    (symbol.shaderSourceTokens ?? []).filter((token) => token.text === tokenText)
  );
  return matches.length === 1 ? matches[0]!.range : undefined;
}

type ResolutionTrace = {
  /** Deepest named item in the failed resolution tree, e.g. `asin`. */
  name: string;
  /** Error detail attached to the deepest item, when present. */
  detail?: string;
  /** Named path through the tree, root first, e.g. `rotateXY(f32) → asin`. */
  path: string[];
};

const RESOLUTION_TREE_HEADER = 'Resolution of the following tree failed:';

/**
 * TypeGPU resolution errors arrive as a multi-line tree dump whose only
 * actionable line is the deepest entry. Parse the trace so failures read as
 * `asin: Unsupported data types: …` instead of the raw tree.
 */
function parseResolutionTrace(error: unknown, depth = 0): ResolutionTrace | undefined {
  if (depth > 4) return undefined;
  const message = typeof error === 'string'
    ? error
    : typeof error === 'object' && error !== null &&
        typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : undefined;
  if (message === undefined) return undefined;
  const headerIndex = message.indexOf(RESOLUTION_TREE_HEADER);
  if (headerIndex === -1) {
    const cause = typeof error === 'object' && error !== null
      ? (error as { cause?: unknown }).cause
      : undefined;
    return cause === undefined ? undefined : parseResolutionTrace(cause, depth + 1);
  }
  // TypeGPU appends fix suggestions after the tree between `-----` rules;
  // they are advice, not tree entries.
  const [tree = '', hintBlock] = message
    .slice(headerIndex + RESOLUTION_TREE_HEADER.length)
    .split(/\n-{3,}\n?/);
  const hints = (hintBlock ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^- /, ''))
    .filter((line) => line !== '' && !/^-{3,}$/.test(line));
  const named = tree
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const entry = line.slice(2);
      const kindPrefix = /^[A-Za-z*]+:/.exec(entry);
      const rest = kindPrefix ? entry.slice(kindPrefix[0].length) : entry;
      const detailIndex = rest.indexOf(': ');
      return {
        name: (detailIndex === -1 ? rest : rest.slice(0, detailIndex)).trim(),
        detail: detailIndex === -1
          ? undefined
          : rest.slice(detailIndex + 2).trim(),
      };
    })
    .filter((entry) =>
      entry.name !== '' && entry.name !== '<root>' && entry.name !== '<unnamed>' &&
      !isProbeScaffolding(entry.name)
    );
  const deepest = named[named.length - 1];
  if (!deepest) return undefined;
  const detail = [deepest.detail, ...hints].filter((part) => part).join(' ');
  return {
    name: deepest.name,
    ...(detail !== '' ? { detail } : {}),
    path: named.map((entry) => entry.name),
  };
}

/** Runtimes before 0.5.2 leak the inspector's probe wrapper names into traces. */
function isProbeScaffolding(name: string): boolean {
  return name.startsWith('__typegpuMcp') || name === '<probe>';
}

function formatResolutionTrace(trace: ResolutionTrace): string {
  const headline = trace.detail
    ? `${trace.name}: ${trace.detail}`
    : `resolution failed at ${trace.name}`;
  const context = trace.path.length > 1
    ? ` (while resolving ${trace.path.join(' → ')})`
    : '';
  return `${headline}${context}`;
}

function formatUnknownError(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as Record<string, unknown>;
  const message = typeof value.message === 'string' ? value.message : undefined;
  const cause = formatUnknownError(value.cause);
  return [message, cause].filter(Boolean).join(' — ') || undefined;
}

function compilerSeverity(type: string): DiagnosticSeverity | undefined {
  const normalized = type.toLowerCase();
  if (normalized === 'error') return DiagnosticSeverity.Error;
  if (normalized === 'warning') return DiagnosticSeverity.Warning;
  if (normalized === 'info') return DiagnosticSeverity.Information;
  return undefined;
}

function humanRole(role: TypeGpuRole): string {
  return role.replaceAll('-', ' ');
}

function shortRole(role: TypeGpuRole): string {
  const names: Partial<Record<TypeGpuRole, string>> = {
    'bind-group-layout': 'bind group layout',
    'vertex-layout': 'vertex layout',
    'binding-resource': 'binding resource',
    'buffer-resource': 'buffer',
    'texture-resource': 'texture',
    'texture-view': 'texture view',
    'sampler-resource': 'sampler',
    'bind-group': 'bind group',
    'query-resource': 'query set',
    'gpu-variable': 'GPU variable',
    'resource-collection': 'resource collection',
    'pipeline-factory': 'pipeline factory',
    'resource-factory': 'resource factory',
  };
  return names[role] ?? humanRole(role);
}

function staticRoleDescription(role: TypeGpuRole): string {
  if (role === 'pipeline-factory' || role === 'resource-factory') {
    return 'Detected as a factory, but safe inspection needs project-specific arguments. Hover or inspect a concrete value produced by this factory.';
  }
  return `Detected as ${humanRole(role)}, but no safe standalone runtime target was derived. Inspect the containing helper or pipeline for runtime details.`;
}

function deduplicateDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}:${diagnostic.severity}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rangesOverlap(left: Range, right: Range): boolean {
  return comparePosition(left.end, right.start) >= 0 &&
    comparePosition(right.end, left.start) >= 0;
}

function comparePosition(
  left: { line: number; character: number },
  right: { line: number; character: number },
): number {
  return left.line - right.line || left.character - right.character;
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function compactHintLabel(
  value: string,
  maxLength = MAX_INLAY_LABEL_LENGTH,
): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 100);
}

function stripExtension(value: string): string {
  return value.replace(/\.[^.]+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRange(value: unknown): value is Range {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) {
    return false;
  }
  return typeof value.start.line === 'number' &&
    typeof value.start.character === 'number' &&
    typeof value.end.line === 'number' &&
    typeof value.end.character === 'number';
}

function isPipelineKind(kind: string | undefined): boolean {
  return kind === 'render-pipeline' || kind === 'compute-pipeline';
}

function leadingWgslExcerpt(wgsl: string, maxLines: number): { lines: string[]; omitted: number } {
  const all = wgsl.replace(/\s+$/, '').split('\n');
  return { lines: all.slice(0, maxLines), omitted: Math.max(0, all.length - maxLines) };
}
