/** Shared wire types. Editor adapters consume structured results, never report text. */
export type SourceRange = {
  start: { line: number; character: number };
  end: { line: number; character: number };
};
export type TargetRef = { uri: string; targetId: string; targetKey?: string };
export type TargetStatus = 'not-inspected' | 'inspecting' | 'ok' | 'failed';
export type TargetOutcome = 'passed' | 'passed-with-assumptions' | 'failed' | 'unsupported' | 'blocked';
export type TargetContext = {
  captured?: Record<string, string | number | boolean | null>;
  label?: string; instance?: number; usage?: number; resultPath?: string[];
  bindingSource?: string; sourceRevision?: string; modulePath?: string;
  arguments?: unknown[]; with?: unknown[];
};
export type EditorTarget = {
  id: string;
  label: string;
  kind?: string;
  status: TargetStatus;
  outcome?: TargetOutcome;
  context?: TargetContext;
  diagnostics?: Array<{ code: string; message: string; hint?: string; severity?: 'note' | 'error' }>;
  inputSummary?: string;
  requirementSummary?: string;
  wgslLines?: number;
  sourceVersion?: number;
};
export type TargetsResponse = {
  version: number;
  stale: boolean;
  symbols: Array<{ name: string; range: SourceRange; targetIds: string[] }>;
  targets: EditorTarget[];
};
export type WgslMessage = { type: string; message: string; range?: SourceRange };
export type WgslResponse =
  | {
    ok: true;
    label: string;
    wgsl: string;
    sourceVersion: number;
    stale: boolean;
    refreshing: boolean;
    outcome: TargetOutcome;
    inputSummary?: string;
    context?: TargetContext;
    messages: WgslMessage[];
  }
  | { ok: false; label?: string; reason: string };
export type ReportResponse =
  | { ok: true; label: string; markdown: string; stale: boolean }
  | { ok: false; label?: string; reason: string };

export function targetStatusLabel(target: Pick<EditorTarget, 'status' | 'outcome' | 'diagnostics'>): string {
  if (target.status === 'inspecting') return 'Refreshing';
  if (target.status === 'not-inspected') return 'Not inspected';
  switch (target.outcome) {
    case 'blocked': return target.diagnostics?.some(diagnostic => ['slot-binding-required', 'selector-not-resolved', 'wrapper-required', 'reference-wrapper-required'].includes(diagnostic.code)) ? 'Needs context' : 'Blocked';
    case 'unsupported': return 'Unsupported';
    case 'passed-with-assumptions': return 'Passed with assumptions';
    case 'passed': return 'Passed';
    case 'failed': return 'Failed';
    default: return target.status === 'ok' ? 'Passed' : 'Failed';
  }
}

export function targetContextLabel(context: EditorTarget['context']): string {
  if (!context) return '';
  return [
    context.label,
    context.instance !== undefined ? `Instance ${context.instance}` : undefined,
    context.usage !== undefined ? `Usage ${context.usage}` : undefined,
    context.resultPath?.join('.'),
    context.bindingSource,
  ].filter(Boolean).join(' · ');
}

/** Offsets are runtime selectors, not durable editor identities. Ambiguous keys are rejected. */
export function targetSelectionKey(target: Pick<EditorTarget, 'label' | 'context'>): string {
  const context = target.context;
  return JSON.stringify([target.label, context?.instance, context?.usage, context?.resultPath, context?.label]);
}

export function findEditorTarget(snapshot: TargetsResponse, ref: Pick<TargetRef, 'targetId' | 'targetKey'>): EditorTarget | undefined {
  if (!ref.targetKey) return snapshot.targets.find(target => target.id === ref.targetId);
  const matches = snapshot.targets.filter(target => targetSelectionKey(target) === ref.targetKey);
  return matches.length === 1 ? matches[0] : undefined;
}
