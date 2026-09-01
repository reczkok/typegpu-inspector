/**
 * Core types for the requirement-satisfaction engine.
 *
 * Inspection is modeled as: a target has typed Requirements (a slot needs a
 * value, a descriptor lacks attribs, ...) discovered either from the target's
 * shape before an attempt or extracted from a resolution failure. An ordered
 * chain of Providers satisfies them; every decision is recorded as a
 * LedgerEntry on the report so nothing the inspector fabricates is invisible.
 */

import type { LedgerEntry, ProviderId, RequirementKind } from '../../types.ts';

export type { LedgerEntry, ProviderId, RequirementKind };

export type Requirement = {
  kind: RequirementKind;
  /** Stable dedupe/reporting key, e.g. `slot-value:params`. */
  key: string;
  /**
   * The live object needing satisfaction (a slot, a fn, a descriptor).
   * Identity matters (slots compare by reference); never serialized.
   */
  subject: unknown;
  discoveredBy: 'shape' | 'failure';
  /** Kind-specific serialization-safe payload (slotName, paramCount, ...). */
  detail?: Record<string, unknown> | undefined;
};

/**
 * Note on attribution: lookup strategies that walk tagged binding sources
 * report the ORIGIN of the source that supplied the value (so a binding
 * borrowed from an imported module reports 'import-scope' even though the
 * same strategy also serves 'module-scope').
 */
export type Provision = {
  value: unknown;
  provider: ProviderId;
  /** Human-readable origin, e.g. "non-degenerate placeholder derived from its schema". */
  provenance: string;
  /** Bounded summary safe to serialize (summarizeTargetValue shape). */
  valueSummary?: unknown;
};

export type SatisfiedRequirement = {
  requirement: Requirement;
  provision: Provision;
};

export type TaggedBindingSource = {
  value: unknown;
  origin: Extract<ProviderId, 'module-scope' | 'import-scope' | 'importer-scope'>;
  /** Optional display label, e.g. the import specifier a namespace came from. */
  label?: string | undefined;
};

/**
 * What the recording shim observed the application itself doing during module
 * import and setup: every root.with pair, pipeline creation, and uniform
 * initial value. Values are the application's real objects.
 */
export type RecordedBindingRegistry = {
  roots?: unknown[];
  usedInspectorDevice?: boolean;
  slotBindings: Array<[unknown, unknown]>;
  pipelines: Array<{
    kind: string;
    descriptor?: unknown;
    slotPairs: Array<[unknown, unknown]>;
    pipeline: unknown;
  }>;
  uniforms: Array<{ schema: unknown; initial: unknown; uniform: unknown }>;
  frozen?: boolean;
};

export type ProviderContext = {
  /** Flattened candidate values, ranked module-scope before import-scope. */
  sources: TaggedBindingSource[];
  /** Present when the recording shim captured application activity. */
  recorded?: RecordedBindingRegistry | undefined;
  /**
   * Same declaration, two module instances: private inspection pastes the
   * module source, so a slot it declares exists once for the targets and once
   * for the importers that bound it. Maps each to the other (accessors and
   * their slots alike) so bindings match across the pair.
   */
  twins?: Map<unknown, unknown> | undefined;
};

/**
 * A lookup strategy. `satisfy` returns undefined when it cannot help — every
 * strategy fails soft on unexpected shapes so a wrong guess degrades to the
 * next provider (and ultimately to an unsatisfied ledger entry), never to a
 * crash.
 */
export type Provider = {
  id: ProviderId;
  canSatisfy(requirement: Requirement): boolean;
  satisfy(requirement: Requirement, ctx: ProviderContext): Provision | undefined;
};

export type EngineContext = {
  enabled: boolean;
  providers: Provider[];
  providerContext: ProviderContext;
  satisfied: SatisfiedRequirement[];
  ledger: LedgerEntry[];
  /** Requirement subjects already attempted (identity set — loop guard). */
  attemptedSubjects: Set<unknown>;
  maxIterations: number;
};
