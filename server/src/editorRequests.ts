import { inspectionInputSummary, inspectionRequirementSummary } from './inspectionContext.js';
import type { Diagnostic } from 'vscode-languageserver/node';
import type { InspectionTarget } from './discovery.js';
import type { InspectorTargetReport } from './protocol.js';
import { findEditorTarget, type TargetRef, type TargetStatus, type TargetsResponse, type WgslResponse, type ReportResponse } from './editorProtocol.js';
export type { TargetsResponse, WgslResponse, ReportResponse, TargetStatus, WgslMessage } from './editorProtocol.js';
import type { DiscoveredModule } from './discovery.js';
import { compilerGeneratedRange } from './sourceMapping.js';
import {
  createHover,
  type DocumentInspection,
  type MaterializedTarget,
  type SurfaceOptions,
} from './surface.js';

/**
 * Editor-specific requests (`typegpu/targets`, `typegpu/wgsl`,
 * `typegpu/report`) behind the VS Code generated-WGSL and report views.
 * Additive: clients that do not know them never send them, and the LSP
 * surfaces stay the source of truth for Zed.
 */

/** Retain observed instances during edits without feeding stale selectors to discovery. */
function visibleTargets(discovered: DiscoveredModule, inspection: DocumentInspection | undefined, version: number): InspectionTarget[] {
  if (!inspection || inspection.sourceVersion === version) return discovered.targets;
  const labelCounts = new Map<string, number>();
  for (const target of discovered.targets) {
    labelCounts.set(target.label, (labelCounts.get(target.label) ?? 0) + 1);
  }
  const byParent = new Map<string, InspectionTarget[]>();
  for (const previous of inspection.targets.values()) {
    const label = previous.report.parentLabel;
    if (!previous.target.instanceParentId || !label) continue;
    const instances = byParent.get(label) ?? [];
    instances.push(previous.target);
    byParent.set(label, instances);
  }
  return discovered.targets.flatMap(target => {
    const instances = labelCounts.get(target.label) === 1 ? byParent.get(target.label) : undefined;
    return instances?.length ? instances.map(previous => ({ ...previous, instanceParentId: target.id })) : [target];
  });
}

function materializedTarget(inspection: DocumentInspection | undefined, target: InspectionTarget): MaterializedTarget | undefined {
  const cached = inspection?.targets.get(target.id);
  return cached?.target.label === target.label ? cached : undefined;
}

function outcome(report: InspectorTargetReport) {
  return report.outcome ?? (report.ok ? 'passed' : 'failed');
}

function isRefreshing(target: InspectionTarget, inspecting: ReadonlySet<string>): boolean {
  return inspecting.has(target.id) || (!!target.instanceParentId && inspecting.has(target.instanceParentId));
}

export function describeTargets(
  version: number,
  discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
  inspecting: ReadonlySet<string>,
): TargetsResponse {
  const stale = inspection !== undefined && inspection.sourceVersion !== version;
  const visible = visibleTargets(discovered, inspection, version);
  return {
    version,
    stale,
    symbols: discovered.symbols
      .filter((symbol) => symbol.targetIds.length > 0)
      .map((symbol) => ({
        name: symbol.name,
        range: symbol.range,
        targetIds: visible.filter(target => symbol.targetIds.includes(target.id) || (!!target.instanceParentId && symbol.targetIds.includes(target.instanceParentId))).map(target => target.id),
      })),
    targets: visible.map((target) => {
      const materialized = materializedTarget(inspection, target);
      const failed = inspection?.targetFailures?.has(target.id) ||
        (inspection?.failure !== undefined && !materialized);
      const status: TargetStatus = isRefreshing(target, inspecting)
        ? 'inspecting'
        : materialized
        ? materialized.report.ok ? 'ok' : 'failed'
        : failed
        ? 'failed'
        : 'not-inspected';
      const wgslLines = materialized?.analysis?.lines;
      const inputSummary = materialized && inspectionInputSummary(materialized.report);
      const requirementSummary = materialized && inspectionRequirementSummary(materialized.report);
      return {
        id: target.id,
        label: target.label,
        kind: materialized?.report.kind ?? target.selector.kind,
        status,
        ...(materialized ? { outcome: outcome(materialized.report), sourceVersion: inspection!.sourceVersion,
          ...(inputSummary ? { inputSummary } : {}),
          ...(requirementSummary ? { requirementSummary } : {}),
          ...(materialized.report.context ? { context: materialized.report.context } : {}),
          ...(materialized.report.diagnostics ? { diagnostics: materialized.report.diagnostics } : {}),
        } : {}),
        ...(wgslLines !== undefined ? { wgslLines } : {}),
      };
    }),
  };
}

/** Translate a durable editor choice back to a current runtime selector for on-demand inspection. */
export function inspectionTargetForRef(
  version: number,
  discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
  ref: Pick<TargetRef, 'targetId' | 'targetKey'>,
): InspectionTarget | undefined {
  const selected = findEditorTarget(describeTargets(version, discovered, inspection, new Set()), ref);
  if (!selected) return undefined;
  const direct = discovered.targets.find(target => target.id === selected.id && target.label === selected.label);
  if (direct) return direct;
  const previous = inspection?.targets.get(selected.id);
  const parents = discovered.targets.filter(target => previous?.target.instanceParentId && target.label === previous.report.parentLabel);
  return parents.length === 1 ? parents[0] : undefined;
}

export function generatedWgsl(
  version: number,
  discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
  targetId: string,
  inspecting: ReadonlySet<string>,
  targetKey?: string,
): WgslResponse {
  if (targetKey) {
    const match = findEditorTarget(describeTargets(version, discovered, inspection, inspecting), { targetId, targetKey });
    if (!match) return { ok: false, reason: 'This specialization changed or no longer exists. Select it again.' };
    targetId = match.id;
  }
  const target = visibleTargets(discovered, inspection, version).find((candidate) => candidate.id === targetId);
  if (!target) return { ok: false, reason: 'This target no longer exists in the file.' };
  const label = target.label;
  const materialized = materializedTarget(inspection, target);
  const refreshing = isRefreshing(target, inspecting);
  if (refreshing && !materialized?.report.wgsl) {
    return { ok: false, label, reason: 'Inspecting…' };
  }
  if (!materialized) {
    const failure = inspection?.targetFailures?.get(targetId) ?? inspection?.failure;
    if (failure) return { ok: false, label, reason: `Inspection failed: ${failure}` };
    return { ok: false, label, reason: 'Not inspected yet. Save the file to inspect it.' };
  }
  const { report } = materialized;
  if (!report.wgsl) {
    return {
      ok: false,
      label,
      reason: report.ok
        ? 'This target produces no WGSL.'
        : `Inspection failed: ${reportFailure(report.error)}`,
    };
  }
  const wgsl = report.wgsl;
  const inputSummary = inspectionInputSummary(report);
  return {
    ok: true,
    label,
    wgsl,
    sourceVersion: inspection!.sourceVersion,
    refreshing,
    outcome: outcome(report),
    ...(inputSummary ? { inputSummary } : {}),
    ...(report.context ? { context: report.context } : {}),
    stale: inspection!.sourceVersion !== version,
    messages: (report.compilationMessages ?? []).map((message) => {
      const range = compilerGeneratedRange(wgsl, message);
      return {
        type: message.type,
        message: message.message,
        ...(range ? { range } : {}),
      };
    }),
  };
}

/** The hover markdown at full depth, for the Markdown preview. */
export function targetReport(
  version: number,
  discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
  targetId: string,
  inspecting: ReadonlySet<string>,
  options: SurfaceOptions,
  targetKey?: string,
): ReportResponse {
  if (targetKey) {
    const match = findEditorTarget(describeTargets(version, discovered, inspection, inspecting), { targetId, targetKey });
    if (!match) return { ok: false, reason: 'This specialization changed or no longer exists. Select it again.' };
    targetId = match.id;
  }
  const visible = visibleTargets(discovered, inspection, version);
  const target = visible.find((candidate) => candidate.id === targetId);
  if (!target) return { ok: false, reason: 'This target no longer exists in the file.' };
  const symbol = discovered.symbols.find((candidate) => candidate.targetIds.includes(targetId) || (!!target.instanceParentId && candidate.targetIds.includes(target.instanceParentId)));
  if (!symbol) return { ok: false, label: target.label, reason: 'No symbol refers to this target.' };
  const reportInspection = inspection && !materializedTarget(inspection, target)
    ? { ...inspection, targets: new Map([...inspection.targets].filter(([id]) => id !== targetId)) }
    : inspection;
  const hover = createHover({ ...symbol, targetIds: [targetId] }, { ...discovered, targets: visible }, reportInspection, version, inspecting, {
    ...options,
    // The preview renders real tables and has no width limit.
    presentation: 'zed',
    hoverDetailLevel: 'deep',
    hoverPresentation: {
      ...(options.hoverPresentation ?? { sections: {}, sectionOrder: [] }),
      wgslPreviewLines: 400,
      maxColumns: 200,
    },
  });
  const contents = hover.contents;
  const markdown = typeof contents === 'string'
    ? contents
    : Array.isArray(contents)
    ? contents.map((entry) => typeof entry === 'string' ? entry : entry.value).join('\n')
    : contents.value;
  return {
    ok: true,
    label: target.label,
    markdown,
    stale: inspection !== undefined && inspection.sourceVersion !== version,
  };
}

function reportFailure(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'unknown error';
}

/** Diagnostics for Zed's generated files; VS Code also consumes the same compiler ranges. */
export function generatedDocumentDiagnostics(
  previous: DocumentInspection | undefined,
  current: DocumentInspection | undefined,
  stale = false,
): Map<string, Diagnostic[]> {
  const old = new Map([...previous?.targets.values() ?? []].flatMap(target => target.generatedUri ? [[target.generatedUri, target] as const] : []));
  const latest = new Map([...current?.targets.values() ?? []].flatMap(target => target.generatedUri ? [[target.generatedUri, target] as const] : []));
  const result = new Map<string, Diagnostic[]>();
  for (const [uri, target] of new Map([...old, ...latest])) {
    const diagnostics: Diagnostic[] = (target.report.compilationMessages ?? []).flatMap(message => {
      const range = compilerGeneratedRange(target.report.wgsl ?? '', message);
      return range ? [{ range, message: message.message, source: 'WGSL compiler', severity: message.type === 'error' ? 1 : message.type === 'warning' ? 2 : 3 }] : [];
    });
    if (stale || !latest.has(uri)) diagnostics.unshift({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: 2, source: 'TypeGPU Inspector',
      message: 'Previous inspection: this WGSL does not represent the current source. Save and inspect the specialization again.',
    });
    result.set(uri, diagnostics);
  }
  return result;
}
