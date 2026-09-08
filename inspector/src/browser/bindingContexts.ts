import { TargetDiagnosticError } from './diagnostics.ts';
import type { ProviderId } from '../types.ts';
import type { RecordedBindingRegistry, TaggedBindingSource } from './engine/types.ts';
import { collectBindingSources } from './engine/providers.ts';
import { inferTargetKind, isAccessorLike, isMutableAccessorLike, readAccessorSlot, readBoundFunctionProvidingPairs, readRenderPipelineSlotBindings, readTypegpuInternalProperty, readTypegpuSymbol } from './typegpuIntrospection.ts';
import type { TypeGpuInspectionTarget } from './targetInspector.ts';

/** A complete branch or bound function. Never pool pairs from different entries. */
export type BindingContext = {
  usage: number;
  source: string;
  owner: unknown;
  subjects: unknown[];
  pairs: Array<[unknown, unknown]>;
  provider: ProviderId;
};

export function collectBindingContexts(sources: TaggedBindingSource[], recorded?: RecordedBindingRegistry): BindingContext[] {
  const contexts: BindingContext[] = [];
  const owners = new Set<unknown>();
  const add = (entry: Omit<BindingContext, 'usage'>) => {
    if (!entry.pairs.length || owners.has(entry.owner)) return;
    owners.add(entry.owner);
    contexts.push({ ...entry, usage: contexts.length, pairs: entry.pairs.map(([slot, value]) => [slot, value]) });
  };
  for (const entry of recorded?.pipelines ?? []) {
    const descriptor = entry.descriptor as { compute?: unknown; vertex?: unknown; fragment?: unknown } | undefined;
    add({ owner: entry.pipeline, subjects: [entry.pipeline, descriptor?.compute, descriptor?.vertex, descriptor?.fragment].filter(Boolean),
      pairs: entry.slotPairs, source: `${entry.kind} pipeline ${contexts.length}`, provider: 'recorded-app-bindings' });
  }
  for (const source of collectBindingSources(sources)) {
    const providing = readTypegpuSymbol(source.value, '$providing') as { inner?: unknown } | undefined;
    const pairs = readBoundFunctionProvidingPairs(source.value) ?? readRenderPipelineSlotBindings(source.value);
    if (!pairs) continue;
    const core = readTypegpuInternalProperty(source.value, 'core') as { options?: { vertex?: unknown; fragment?: unknown } } | undefined;
    add({ owner: source.value, subjects: [source.value, providing?.inner, core?.options?.vertex, core?.options?.fragment].filter(Boolean),
      pairs, source: `${providing ? 'bound function' : 'render pipeline'} ${contexts.length}${source.label ? ` (${source.label})` : ''}`, provider: source.origin });
  }
  return contexts;
}

export function contextBinds(context: BindingContext, subject: unknown): boolean {
  return context.pairs.some(([slot]) => slot === subject ||
    ((isAccessorLike(slot) || isMutableAccessorLike(slot)) && readAccessorSlot(slot) === subject));
}

export function contextualize(target: TypeGpuInspectionTarget, context: BindingContext): TypeGpuInspectionTarget {
  const direct = context.subjects.includes(target.subject ?? target.value);
  const parentLabel = target.parentLabel ?? target.label;
  return {
    ...target, usage: context.usage, bindings: context.pairs, autoBind: false,
    bindingProvider: direct ? 'observed-context' : context.provider,
    ...(target.usage === undefined ? { parentLabel, label: `${target.label} [usage ${context.usage}]` } : {}),
    context: { ...target.context, usage: context.usage, bindingSource: context.source, association: direct ? 'direct' : 'candidate' },
  };
}

/** Expand before resolution when related directly, or after discovering required slots. */
export function expandBindingContexts(
  target: TypeGpuInspectionTarget,
  contexts: BindingContext[],
  enabled: boolean,
  subjects?: unknown[],
): TypeGpuInspectionTarget[] | undefined {
  if (target.bindings || target.error || target.kind === 'resource') return undefined;
  if (target.usage === undefined && (
    !(target.autoBind ?? enabled) || inferTargetKind(target.value) !== 'resolvable' ||
    readBoundFunctionProvidingPairs(target.value)
  )) return undefined;
  const matches = contexts.filter(context => target.usage !== undefined
    ? context.usage === target.usage
    : subjects ? subjects.some(subject => contextBinds(context, subject))
    : context.subjects.includes(target.subject ?? target.value));
  const message = target.usage !== undefined && matches.length === 0
    ? 'Inspection usage is unavailable in this run. Re-run without a usage selection to list available contexts.'
    : matches.length > 128 ? 'More than 128 binding contexts match. Select a usage explicitly.' : undefined;
  if (message) return [{ ...target, error: new TargetDiagnosticError(message, [
    { code: 'selector-not-resolved', severity: 'error', message },
  ]) }];
  return matches.length ? matches.map(context => contextualize(target, context)) : undefined;
}
