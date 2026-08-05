import {
  TargetDiagnosticError,
  createAutoBindingsNote,
  createSlotBindingRequiredDiagnostic,
  createWrapperRequiredDiagnostic,
  getErrorMessage,
} from '../diagnostics.ts';
import { summarizeTargetValue } from '../typegpuIntrospection.ts';
import { extractFromFailure } from './discovery.ts';
import { toLedgerEntry, toUnsatisfiedEntry } from './ledger.ts';
import { collectBindingSources, createProviderChain, satisfyRequirement } from './providers.ts';
import type {
  EngineContext,
  RecordedBindingRegistry,
  Requirement,
  TaggedBindingSource,
} from './types.ts';

const MAX_ENGINE_ITERATIONS = 8;

export function createEngineContext(options: {
  enabled: boolean;
  sources: TaggedBindingSource[];
  recorded?: RecordedBindingRegistry | undefined;
}): EngineContext {
  return {
    enabled: options.enabled,
    providers: createProviderChain(),
    providerContext: {
      sources: collectBindingSources(options.sources),
      recorded: options.recorded,
    },
    satisfied: [],
    ledger: [],
    attemptedSubjects: new Set(),
    maxIterations: MAX_ENGINE_ITERATIONS,
  };
}

/**
 * The fixpoint loop: attempt → extract a typed requirement from the failure →
 * satisfy it through the provider chain → re-attempt. Terminates because each
 * iteration either satisfies a NEW requirement subject or throws: a subject
 * reappearing means its provision did not take effect (e.g. a second typegpu
 * instance produced a different slot identity), and the iteration cap bounds
 * pathological chains.
 */
export function satisfyAndAttempt<T>(
  engine: EngineContext,
  attempt: () => T,
  onUnsatisfiable: (requirement: Requirement, error: unknown) => Error,
): T {
  for (;;) {
    try {
      return attempt();
    } catch (error) {
      if (!engine.enabled) throw error;
      const requirement = extractFromFailure(error);
      if (requirement === undefined) {
        // Not a recognized requirement (or a serialized error): the message
        // classifiers own the failure from here.
        throw error;
      }
      if (
        engine.attemptedSubjects.has(requirement.subject) ||
        engine.attemptedSubjects.size >= engine.maxIterations
      ) {
        engine.ledger.push(toUnsatisfiedEntry(requirement));
        throw onUnsatisfiable(requirement, error);
      }
      engine.attemptedSubjects.add(requirement.subject);
      const provision = satisfyRequirement(
        requirement,
        engine.providers,
        engine.providerContext,
      );
      if (provision === undefined) {
        engine.ledger.push(toUnsatisfiedEntry(requirement));
        throw onUnsatisfiable(requirement, error);
      }
      engine.satisfied.push({ requirement, provision });
      engine.ledger.push(toLedgerEntry(requirement, provision));
    }
  }
}

/** Slot/value pairs from satisfied slot-value requirements, for `.with(...)`. */
export function slotValueProvisions(engine: EngineContext): Array<[unknown, unknown]> {
  return engine.satisfied
    .filter((entry) => entry.requirement.kind === 'slot-value')
    .map((entry) => [entry.requirement.subject, entry.provision.value]);
}

export function satisfiedSlotValues(engine: EngineContext) {
  return engine.satisfied.filter((entry) => entry.requirement.kind === 'slot-value');
}

export function createRequirementFailure(
  engine: EngineContext,
  requirement: Requirement,
  error: unknown,
  targetValue: unknown,
): TargetDiagnosticError {
  const slotSatisfied = satisfiedSlotValues(engine);
  const autoBindingNotes = slotSatisfied.length > 0
    ? [createAutoBindingsNote(slotSatisfied)]
    : [];
  if (requirement.kind === 'argument-values') {
    return new TargetDiagnosticError(getErrorMessage(error), [
      ...autoBindingNotes,
      createWrapperRequiredDiagnostic(summarizeTargetValue(targetValue)),
    ]);
  }
  return new TargetDiagnosticError(getErrorMessage(error), [
    ...autoBindingNotes,
    createSlotBindingRequiredDiagnostic({
      slotName: String(requirement.detail?.slotName ?? 'unknown slot'),
      appliedSlotNames: slotSatisfied.map((entry) =>
        String(entry.requirement.detail?.slotName ?? 'unknown slot'),
      ),
      valueSummary: summarizeTargetValue(targetValue),
      autoBindAttempted: true,
    }),
  ]);
}
