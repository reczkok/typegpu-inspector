import { summarizeTargetValue } from '../typegpuIntrospection.ts';
import type {
  LedgerEntry,
  Provision,
  Requirement,
  RequirementKind,
} from './types.ts';

export function toLedgerEntry(requirement: Requirement, provision: Provision): LedgerEntry {
  return {
    tier: 'resource',
    kind: requirement.kind,
    key: requirement.key,
    status: 'satisfied',
    discoveredBy: requirement.discoveredBy,
    provider: provision.provider,
    provenance: provision.provenance,
    detail: requirement.detail,
    valueSummary: provision.valueSummary ?? summarizeTargetValue(provision.value),
  };
}

export function toUnsatisfiedEntry(requirement: Requirement): LedgerEntry {
  return {
    tier: 'resource',
    kind: requirement.kind,
    key: requirement.key,
    status: 'unsatisfied',
    discoveredBy: requirement.discoveredBy,
    detail: requirement.detail,
  };
}

export function ledgerHas(
  entries: LedgerEntry[] | undefined,
  kind: RequirementKind,
  status: LedgerEntry['status'],
): boolean {
  return (entries ?? []).some((entry) => entry.kind === kind && entry.status === status);
}

/**
 * Provenance sentences of satisfied shape-discovered entries (probe wrappers,
 * probe bindings, synthesized descriptor parts). These feed the
 * `inspection-defaults-applied` note hint that prose defaults strings feed,
 * keeping the note text identical while the ledger is the single source of
 * truth. Failure-discovered entries feed the `slot-bindings-auto-applied`
 * note instead — the discovery mode IS the note routing.
 */
export function collectShapeProvenances(entries: LedgerEntry[]): string[] {
  return entries
    .filter((entry) =>
      entry.status === 'satisfied' &&
      entry.discoveredBy === 'shape' &&
      typeof entry.provenance === 'string'
    )
    .map((entry) => entry.provenance as string);
}
