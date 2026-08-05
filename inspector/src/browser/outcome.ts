import type {
  LedgerEntry,
  TargetDiagnostic,
  TargetOutcome,
} from '../types.ts';

const UNSUPPORTED_CODES = new Set([
  'not-shader-resolvable',
  'plain-object-not-inspectable',
  'cpu-function-not-inspectable',
  'three-node-not-inspectable',
  'raw-webgpu-pipeline-unsupported',
  'unsupported-internal-resource',
  'pipeline-resource-shape',
  'value-not-inspectable',
]);

const BLOCKED_CODES = new Set([
  'slot-binding-required',
  'wrapper-required',
  'reference-wrapper-required',
  'selector-not-resolved',
  'module-import-failed',
  'canvas-dom-setup-required',
  'browser-capability-unavailable',
  'webgpu-device-lost',
]);

export function inferTargetOutcome(input: {
  ok: boolean;
  diagnostics?: TargetDiagnostic[] | undefined;
  ledger?: LedgerEntry[] | undefined;
  causeId?: string | undefined;
}): TargetOutcome {
  if (input.causeId) return 'blocked';
  if (input.ok) {
    return hasInspectionAssumptions(input.ledger) ||
        input.diagnostics?.some((diagnostic) =>
          diagnostic.code === 'webgpu-validation-unavailable'
        )
      ? 'passed-with-assumptions'
      : 'passed';
  }

  const codes = new Set(
    (input.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.severity !== 'note')
      .map((diagnostic) => diagnostic.code),
  );
  if ([...codes].some((code) => UNSUPPORTED_CODES.has(code))) return 'unsupported';
  if ([...codes].some((code) => BLOCKED_CODES.has(code))) return 'blocked';
  return 'failed';
}

function hasInspectionAssumptions(entries: LedgerEntry[] | undefined): boolean {
  return (entries ?? []).some((entry) =>
    entry.status === 'satisfied' &&
    (
      entry.provider === 'synthesis' ||
      (
        entry.provider === 'user-explicit' &&
        (entry.kind === 'argument-values' || entry.kind === 'slot-value')
      )
    )
  );
}
