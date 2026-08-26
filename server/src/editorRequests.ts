import type { Range } from 'vscode-languageserver/node';
import type { DiscoveredModule } from './discovery.js';
import { compilerGeneratedRange } from './sourceMapping.js';
import type { DocumentInspection } from './surface.js';

/**
 * Editor-specific requests (`typegpu/targets`, `typegpu/wgsl`) behind the
 * VS Code generated-WGSL views. Additive: clients that do not know them never
 * send them, and the LSP surfaces stay the source of truth for Zed.
 */

export type TargetStatus = 'not-inspected' | 'inspecting' | 'ok' | 'failed';

export type TargetsResponse = {
  version: number;
  /** True when the reported inspection came from an earlier saved version. */
  stale: boolean;
  symbols: Array<{ name: string; range: Range; targetIds: string[] }>;
  targets: Array<{
    id: string;
    label: string;
    kind?: string;
    status: TargetStatus;
    wgslLines?: number;
  }>;
};

export type WgslMessage = {
  type: string;
  message: string;
  range?: Range;
};

export type WgslResponse =
  | {
    ok: true;
    label: string;
    wgsl: string;
    sourceVersion: number;
    stale: boolean;
    messages: WgslMessage[];
  }
  | { ok: false; label?: string; reason: string };

export function describeTargets(
  version: number,
  discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
  inspecting: ReadonlySet<string>,
): TargetsResponse {
  const stale = inspection !== undefined && inspection.sourceVersion !== version;
  return {
    version,
    stale,
    symbols: discovered.symbols
      .filter((symbol) => symbol.targetIds.length > 0)
      .map((symbol) => ({
        name: symbol.name,
        range: symbol.range,
        targetIds: [...symbol.targetIds],
      })),
    targets: discovered.targets.map((target) => {
      const materialized = inspection?.targets.get(target.id);
      const failed = inspection?.targetFailures?.has(target.id) ||
        (inspection?.failure !== undefined && !materialized);
      const status: TargetStatus = inspecting.has(target.id)
        ? 'inspecting'
        : materialized
        ? materialized.report.ok ? 'ok' : 'failed'
        : failed
        ? 'failed'
        : 'not-inspected';
      const wgslLines = materialized?.analysis?.lines;
      return {
        id: target.id,
        label: target.label,
        ...(materialized ? { kind: materialized.report.kind } : {}),
        status,
        ...(wgslLines !== undefined ? { wgslLines } : {}),
      };
    }),
  };
}

export function generatedWgsl(
  version: number,
  discovered: DiscoveredModule,
  inspection: DocumentInspection | undefined,
  targetId: string,
  inspecting: ReadonlySet<string>,
): WgslResponse {
  const target = discovered.targets.find((candidate) => candidate.id === targetId);
  if (!target) return { ok: false, reason: 'This target no longer exists in the file.' };
  const label = target.label;
  if (inspecting.has(targetId)) {
    return { ok: false, label, reason: 'Inspecting…' };
  }
  const materialized = inspection?.targets.get(targetId);
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
  return {
    ok: true,
    label,
    wgsl,
    sourceVersion: inspection!.sourceVersion,
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

function reportFailure(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'unknown error';
}
