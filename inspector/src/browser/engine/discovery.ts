import { readMissingSlotFromError, readSlotName } from '../typegpuIntrospection.ts';
import type { Requirement } from './types.ts';

/**
 * Failure-based requirement extraction: turns a thrown resolution error into
 * a typed Requirement when a registered extractor recognizes it. Returns
 * undefined when no extractor matches — the caller rethrows and the classic
 * message classifiers own the failure from there.
 */
export function extractFromFailure(error: unknown): Requirement | undefined {
  for (const extractor of FAILURE_EXTRACTORS) {
    try {
      const requirement = extractor(error);
      if (requirement) return requirement;
    } catch {
      // A broken extractor must never mask the original error.
    }
  }
  return undefined;
}

type FailureExtractor = (error: unknown) => Requirement | undefined;

function extractMissingSlot(error: unknown): Requirement | undefined {
  const slot = readMissingSlotFromError(error);
  if (slot === undefined) return undefined;
  const slotName = readSlotName(slot);
  return {
    kind: 'slot-value',
    key: `slot-value:${slotName}`,
    subject: slot,
    discoveredBy: 'failure',
    detail: { slotName },
  };
}

const WRAPPER_REQUIRED_MESSAGE = /Cannot resolve '([^']+)'.*because it expects arguments/;

/**
 * A shellless helper that expects arguments cannot resolve standalone. No
 * runtime provider can satisfy this yet — building a wrapper fn requires the
 * build-time 'use gpu' transform, so satisfaction lives in probe codegen
 * (user-explicit entries). Extracting it still produces a structured
 * unsatisfied ledger entry instead of only a message-classified diagnostic.
 */
function extractWrapperRequired(error: unknown): Requirement | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = WRAPPER_REQUIRED_MESSAGE.exec(message);
  if (!match) return undefined;
  const helperName = match[1] ?? 'unknown helper';
  const key = `argument-values:${helperName}`;
  return {
    kind: 'argument-values',
    // The key doubles as the identity subject: a second extraction of the
    // same helper bails the loop instead of spinning.
    key,
    subject: key,
    discoveredBy: 'failure',
    detail: { helperName },
  };
}

const FAILURE_EXTRACTORS: FailureExtractor[] = [
  extractMissingSlot,
  extractWrapperRequired,
];
