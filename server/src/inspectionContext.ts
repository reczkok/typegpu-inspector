import type { InspectorTargetReport } from './protocol.js';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const short = (text: string, limit = 160) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const name = (selector: string) => selector.replace(/^(?:ctx\.)?d\./, '').replace(/^module\./, '');
const list = (items: string[], limit = 3) => items.slice(0, limit).join(', ') + (items.length > limit ? `, +${items.length - limit}` : '');
const primitive = (value: unknown): string | undefined => value === null || ['number', 'boolean', 'string'].includes(typeof value) ? JSON.stringify(value) : undefined;

/** Derive one context line from structured evidence, never diagnostic prose or WGSL. */
export function inspectionInputSummary(report: InspectorTargetReport): string | undefined {
  const parts: string[] = [];
  const captured = Object.entries(report.context?.captured ?? {});
  if (captured.length) parts.push(`Captured: ${list(captured.map(([key, value]) => `${key} = ${short(JSON.stringify(value), 32)}`))}`);
  const ledger = (report.ledger ?? []).filter(entry => entry.tier !== 'environment' && entry.status === 'satisfied');
  const argumentsEntry = ledger.find(entry => entry.kind === 'argument-values');
  const plan = argumentsEntry?.detail?.arguments ?? report.context?.arguments;
  if (Array.isArray(plan) && plan.length) {
    const args = plan.map(entry => {
      const argument = record(entry);
      if (typeof argument?.schema === 'string') {
        const schema = name(argument.schema);
        return /^(?:[fiu]\d+|vec[234][fiuhb])$/.test(schema) ? `${schema}(0)` : `${schema}()`;
      }
      if (typeof argument?.refSchema === 'string') return `ref(${name(argument.refSchema)}())`;
      if (typeof argument?.value === 'string') return name(argument.value);
      return '?';
    });
    const synthesized = plan.some(entry => record(entry)?.schema || record(entry)?.refSchema);
    parts.push(`${synthesized ? report.context?.probe?.origin === 'call-site' ? 'Call-site type probe' : 'Probe' : report.context?.probe?.origin === 'call-site' ? 'Call-site inputs' : 'Inputs'}: ${list(args)}`);
  } else if (typeof argumentsEntry?.detail?.argumentCount === 'number' && argumentsEntry.detail.argumentCount > 0) {
    parts.push(`Probe: ${argumentsEntry.detail.argumentCount} arguments`);
  }
  const slots = ledger.filter(entry => entry.kind === 'slot-value' && (entry.provider === 'synthesis' || (entry.provider === 'user-explicit' && typeof entry.detail?.schema === 'string')));
  const storage = slots.filter(entry => ['mutable', 'readonly', 'buffer'].includes(String(record(entry.valueSummary)?.resourceType)));
  if (storage.length) parts.push(`${storage.length} synthetic storage binding${storage.length === 1 ? '' : 's'}`);
  const values = slots.filter(entry => !storage.includes(entry)).map(entry => {
    const slot = String(entry.detail?.slotName ?? entry.key.replace(/^slot-value:/, ''));
    const value = primitive(entry.valueSummary);
    return value === undefined ? slot : `${slot} = ${short(value, 32)}`;
  });
  if (values.length) parts.push(`Placeholder${values.length === 1 ? '' : 's'}: ${list(values)}`);
  for (const [kind, label] of [['vertex-attribs', 'synthetic vertex inputs'], ['fragment-targets', 'synthetic color targets'], ['pipeline-descriptor', 'synthetic pipeline descriptor']]) {
    if (ledger.some(entry => entry.kind === kind && entry.provider === 'synthesis')) parts.push(label!);
  }
  if (report.context?.bindingSource) parts.push(`${report.context.association === 'direct' ? 'Observed bindings' : 'Candidate bindings'}: ${report.context.bindingSource}`);
  else if (report.context?.with?.length) parts.push(`Explicit bindings: ${list(report.context.with.map(binding => {
    const entry = record(binding);
    return `${name(String(entry?.slot))} ← ${name(String(entry?.value))}`;
  }))}`);
  if (!parts.length && report.outcome === 'passed-with-assumptions') return 'Additional inspection assumptions';
  return parts.length ? short(parts.join(' · ')) : undefined;
}

/** Keep the missing input and the next useful action together. */
export function inspectionRequirementSummary(report: InspectorTargetReport): string | undefined {
  const missingArgument = report.context?.probe?.missing?.[0];
  if (missingArgument) return short(`Missing argument: ${missingArgument.parameter} — ${missingArgument.reason}`);
  const slot = report.ledger?.find(entry => entry.kind === 'slot-value' && entry.status === 'unsatisfied');
  if (slot) return short(`Missing slot: ${String(slot.detail?.slotName ?? slot.key.replace(/^slot-value:/, ''))} — ${
    typeof slot.detail?.bindingReason === 'string' ? slot.detail.bindingReason : 'provide a binding or accessor schema.'
  }`);
  return undefined;
}
