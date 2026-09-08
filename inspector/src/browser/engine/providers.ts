import {
  isAccessorLike,
  readAccessorSchema,
  readAccessorSlot,
} from '../typegpuIntrospection.ts';
import { createPlaceholderValue, StorageBindingRequiredError } from './synthesis.ts';
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
    origin === 'import-scope'
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
          provenance:
            'non-degenerate placeholder value recursively derived from its accessor schema',
        };
      } catch (error) {
        if (error instanceof StorageBindingRequiredError) {
          requirement.detail = { ...requirement.detail, bindingReason: error.message };
        }
        // Another source may still provide an actual binding. Retain why a
        // known schema could not be synthesized for the unresolved diagnostic.
      }
    }
    return undefined;
  },
};

export function createProviderChain(): Provider[] {
  return [accessorPlaceholderProvider];
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
