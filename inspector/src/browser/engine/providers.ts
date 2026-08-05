import {
  isAccessorLike,
  isMutableAccessorLike,
  readAccessorSchema,
  readAccessorSlot,
  readBoundFunctionProvidingPairs,
  readRenderPipelineSlotBindings,
} from '../typegpuIntrospection.ts';
import { createPlaceholderValue } from './synthesis.ts';
import type {
  Provider,
  ProviderContext,
  Provision,
  Requirement,
  TaggedBindingSource,
} from './types.ts';

/**
 * Duck-typed check for the tagged records the generated symbols module
 * attaches to its side channel. Legacy entries (raw values) tag as
 * module-scope at the call site.
 */
export function isTaggedBindingSource(entry: unknown): entry is TaggedBindingSource {
  if (!entry || typeof entry !== 'object') return false;
  const origin = (entry as { origin?: unknown }).origin;
  return (
    origin === 'module-scope' ||
    origin === 'import-scope' ||
    origin === 'importer-scope'
  ) && 'value' in entry;
}

/**
 * Flattens tagged binding sources (module namespaces, setup-roots records,
 * sibling target values, imported-module namespaces) into one deduplicated
 * candidate list that keeps each value's origin. Records are expanded one
 * level; anything else (a pipeline, a bound fn) is included directly. Reading
 * a module namespace can throw (TDZ on circular imports), so every source
 * expands inside its own try/catch. First origin wins on duplicates, so rank
 * module-scope sources before import-scope ones.
 */
export function collectBindingSources(
  sources: TaggedBindingSource[],
): TaggedBindingSource[] {
  const seen = new Set<unknown>();
  const collected: TaggedBindingSource[] = [];
  const add = (value: unknown, origin: TaggedBindingSource['origin'], label?: string) => {
    if (value === null || value === undefined || seen.has(value)) return;
    seen.add(value);
    collected.push({ value, origin, label });
  };
  for (const source of sources) {
    const { value, origin, label } = source;
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      continue;
    }
    try {
      const proto = Object.getPrototypeOf(value);
      if (typeof value === 'object' && (proto === Object.prototype || proto === null)) {
        for (const entry of Object.values(value)) {
          add(entry, origin, label);
        }
      } else {
        add(value, origin, label);
      }
    } catch {
      // An unreadable source contributes nothing; keep scanning the rest.
    }
  }
  return collected;
}

function describeSourceLabel(source: TaggedBindingSource, noun: string): string {
  if (source.origin === 'importer-scope') {
    return `${noun} in direct importer${source.label ? ` '${source.label}'` : ''}`;
  }
  return source.origin === 'import-scope'
    ? `${noun} in imported module${source.label ? ` '${source.label}'` : 's'}`
    : `${noun} in the binding sources`;
}

/**
 * Real values first: a binding the application itself made — read off a
 * render pipeline's slotBindings or a bound function's providing pairs found
 * among the sources — beats a synthesized zero. Provision.provider reflects
 * the source's origin so borrowed import-scope values report as such.
 */
const borrowedBindingsProvider: Provider = {
  id: 'module-scope',
  canSatisfy: (requirement) => requirement.kind === 'slot-value',
  satisfy: (requirement, ctx) => {
    for (const source of ctx.sources) {
      const renderPairs = readRenderPipelineSlotBindings(source.value);
      const pairs = renderPairs ?? readBoundFunctionProvidingPairs(source.value);
      if (!pairs) continue;
      for (const pair of pairs) {
        const bound = pair[0];
        const matches = bound === requirement.subject ||
          ((isAccessorLike(bound) || isMutableAccessorLike(bound)) &&
            readAccessorSlot(bound) === requirement.subject);
        if (!matches) continue;
        return {
          value: pair[1],
          provider: source.origin,
          provenance: `value borrowed from ${
            describeSourceLabel(source, renderPairs ? 'a render pipeline' : 'a bound function')
          }`,
        };
      }
    }
    return undefined;
  },
};

/**
 * Placeholder-value synthesis from a matching accessor's schema. Mutable
 * accessors are excluded: their binding must be a mutable buffer usage, which
 * a plain CPU value cannot stand in for — they can only be satisfied by
 * borrowing.
 */
const accessorPlaceholderProvider: Provider = {
  id: 'synthesis',
  canSatisfy: (requirement) => requirement.kind === 'slot-value',
  satisfy: (requirement, ctx) => {
    for (const source of ctx.sources) {
      if (
        !isAccessorLike(source.value) ||
        readAccessorSlot(source.value) !== requirement.subject
      ) {
        continue;
      }
      try {
        const slotName = String(requirement.detail?.slotName ?? 'unknown slot');
        return {
          value: createPlaceholderValue(
            readAccessorSchema(source.value),
            `auto-binding for slot '${slotName}'`,
          ),
          provider: 'synthesis',
          provenance: 'placeholder value derived from its accessor schema',
        };
      } catch {
        // Non-callable schema; another source may still match.
      }
    }
    return undefined;
  },
};

/**
 * Real application bindings observed by the recording shim: the value the app
 * itself bound wins over anything scope-harvested or synthesized.
 */
const recordedAppBindingsProvider: Provider = {
  id: 'recorded-app-bindings',
  canSatisfy: (requirement) => requirement.kind === 'slot-value',
  satisfy: (requirement, ctx) => {
    const recorded = ctx.recorded;
    if (!recorded) return undefined;
    const pairLists = [
      recorded.slotBindings ?? [],
      ...(recorded.pipelines ?? []).map((entry) => entry.slotPairs ?? []),
    ];
    for (const pairs of pairLists) {
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const bound = pair[0];
        const matches = bound === requirement.subject ||
          ((isAccessorLike(bound) || isMutableAccessorLike(bound)) &&
            readAccessorSlot(bound) === requirement.subject);
        if (!matches) continue;
        return {
          value: pair[1],
          provider: 'recorded-app-bindings',
          provenance: 'value the application bound via root.with(...)',
        };
      }
    }
    return undefined;
  },
};

export function createProviderChain(): Provider[] {
  return [recordedAppBindingsProvider, borrowedBindingsProvider, accessorPlaceholderProvider];
}

export function satisfyRequirement(
  requirement: Requirement,
  providers: Provider[],
  ctx: ProviderContext,
): Provision | undefined {
  for (const provider of providers) {
    if (!provider.canSatisfy(requirement)) continue;
    try {
      const provision = provider.satisfy(requirement, ctx);
      if (provision) return provision;
    } catch {
      // A broken provider degrades to the next one, never to a crash.
    }
  }
  return undefined;
}
