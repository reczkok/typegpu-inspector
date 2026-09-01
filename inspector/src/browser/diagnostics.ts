import type {
  InspectionTargetKind,
  TargetDiagnostic,
} from '../types.ts';
import type { SatisfiedRequirement } from './engine/types.ts';
import { readStringProperty } from '../shared.ts';
import {
  isPlainObject,
  isPipelineResourceType,
  readRawWebGpuPipelineKind,
  isShaderResolvableResourceType,
  isThreeNodeLikeSummary,
  isTypegpuShaderResolvableLike,
  readResourceType,
  readTypegpuFunctionKind,
  summarizeTargetValue,
} from './typegpuIntrospection.ts';

const WRAPPER_REQUIRED_PATTERN = /because it expects arguments/;
// Kept as a fallback even though the engine owns resolution-time missing
// slots: pipeline-unwrap failures and serialized errors bypass the engine.
const MISSING_SLOT_PATTERN = /Missing value for 'slot:([^']+)'/;
const SELECTOR_NOT_RESOLVED_PATTERN = /Could not resolve selector/;
const VALIDATION_SCOPE_TIMEOUT_PATTERN = /Timed out while reading WebGPU validation scope/;
const INTERNAL_RESOURCE_FAILURE_PATTERN = /Unknown resource type|Unresolvable internal value/;
const NOT_RESOLVABLE_PATTERN = /is not resolvable/;
const MODULE_IMPORT_FAILED_PATTERN = /Failed to fetch dynamically imported module/;
const SERIALIZATION_FAILURE_PATTERN = /Cannot serialize result|object reference chain is too long/;
const RANDOM_HELPER_PATTERN = /fn:randSeed\d*/;
const INSPECTION_TIMEOUT_PATTERN = /TypeGPU inspection timed out/;
const CANVAS_SETUP_PATTERN =
  /Cannot read properties of null \(reading 'getContext'\)|Failed to execute 'getContext'/;
const REFERENCE_ARGUMENT_PATTERN = /Property '\$' not found on/;

type TargetDiagnosticRule = {
  matches(message: string, value: unknown): boolean;
  create(
    message: string,
    value: unknown,
    kind: InspectionTargetKind,
    valueSummary: unknown,
  ): TargetDiagnostic;
};

type InspectionFailureRule = {
  matches(message: string): boolean;
  diagnostic: TargetDiagnostic;
};

export class TargetDiagnosticError extends Error {
  constructor(
    message: string,
    readonly diagnostics: TargetDiagnostic[],
  ) {
    super(message);
    this.name = 'TargetDiagnosticError';
  }
}

export function createWrapperRequiredDiagnostic(valueSummary: unknown): TargetDiagnostic {
  return {
    code: 'wrapper-required',
    message: 'The selected GPU helper expects arguments and cannot be resolved by itself.',
    hint:
      'Wrap it in an inline inspection module that calls it from a zero-argument tgpu.fn, computeFn, vertexFn, fragmentFn, or another helper with concrete arguments.',
    valueSummary,
  };
}

const TARGET_DIAGNOSTIC_RULES: TargetDiagnosticRule[] = [
  {
    matches: (message) => REFERENCE_ARGUMENT_PATTERN.test(message),
    create: (_message, _value, _kind, valueSummary) => ({
      code: 'reference-wrapper-required',
      message:
        'The selected helper expects a mutable TGSL reference that cannot be synthesized through a detached dynamic wrapper.',
      hint:
        'Inspect an authored caller or pipeline that passes a real mutable local into this helper.',
      valueSummary,
    }),
  },
  {
    matches: (message) => WRAPPER_REQUIRED_PATTERN.test(message),
    create: (_message, _value, _kind, valueSummary) =>
      createWrapperRequiredDiagnostic(valueSummary),
  },
  {
    matches: (message) => MISSING_SLOT_PATTERN.test(message),
    create: (message, _value, _kind, valueSummary) =>
      createSlotBindingRequiredDiagnostic({
        slotName: MISSING_SLOT_PATTERN.exec(message)?.[1] ?? 'unknown slot',
        appliedSlotNames: [],
        valueSummary,
        autoBindAttempted: false,
      }),
  },
  {
    matches: (message) => INTERNAL_RESOURCE_FAILURE_PATTERN.test(message),
    create: (_message, _value, kind, valueSummary) => ({
      code: kind === 'resolvable' ? 'unsupported-internal-resource' : 'pipeline-resource-shape',
      message:
        kind === 'resolvable'
          ? 'The selected value looks like an internal TypeGPU/resource object rather than a shader-resolvable value.'
          : 'The selected pipeline target is not directly unwrap-able as a TypeGPU pipeline.',
      hint:
        'If this is a guarded or wrapper pipeline, select its inner `.pipeline` value or return that inner value from setupBody/inlineCode.',
      valueSummary,
    }),
  },
  {
    matches: (message) => NOT_RESOLVABLE_PATTERN.test(message),
    create: (_message, value, _kind, valueSummary) => ({
      code: classifyNotResolvableCode(value),
      message: isTypegpuShaderResolvableLike(value)
        ? 'The selected TypeGPU shader function could not be resolved by itself.'
        : 'The selected value is not a TypeGPU shader-resolvable value.',
      hint: getNotResolvableHint(value),
      valueSummary,
    }),
  },
  {
    matches: (message) => MODULE_IMPORT_FAILED_PATTERN.test(message),
    create: (_message, _value, _kind, valueSummary) => ({
      code: 'module-import-failed',
      message: 'The browser could not import the generated inspection module or one of its dependencies.',
      hint:
        'Check pageErrors/console for Vite transform details. Add documentHtml, browserSetup, staticAssetRoutes, dependencyAliases, or fsAllow when the module needs app-like setup.',
      valueSummary,
    }),
  },
  {
    matches: (message) => SERIALIZATION_FAILURE_PATTERN.test(message),
    create: (_message, _value, _kind, valueSummary) => ({
      code: 'result-serialization-failed',
      message: 'The inspection result contained a value graph too deep for browser serialization.',
      hint:
        'Retry with diagnosticsOnly or inspect one target at a time. The inspector bounds descriptors before returning reports.',
      valueSummary,
    }),
  },
  {
    matches: (message) => RANDOM_HELPER_PATTERN.test(message),
    create: (_message, _value, _kind, valueSummary) => ({
      code: 'typegpu-random-resolution-failed',
      message: 'TypeGPU resolution failed inside a random/noise helper.',
      hint:
        'This is likely a TypeGPU/library resolution issue rather than missing DOM setup. A smaller wrapper around the random/noise call is the best minimal reproduction.',
      valueSummary,
    }),
  },
  {
    matches: (message) => SELECTOR_NOT_RESOLVED_PATTERN.test(message),
    create: (message, _value, _kind, valueSummary) => ({
      code: 'selector-not-resolved',
      message,
      hint:
        'Retry with selector names from list_typegpu_exports; selector paths are case-sensitive dot paths.',
      valueSummary,
    }),
  },
  {
    matches: (message) => VALIDATION_SCOPE_TIMEOUT_PATTERN.test(message),
    create: (message, _value, _kind, valueSummary) => ({
      code: 'webgpu-validation-timeout',
      message,
      hint:
        'Retry with a narrower target, diagnosticsOnly output, or a higher output.timeoutMs; complex pipelines may validate more slowly in browser software WebGPU.',
      valueSummary,
    }),
  },
];

const INSPECTION_FAILURE_RULES: InspectionFailureRule[] = [
  {
    matches: (message) => CANVAS_SETUP_PATTERN.test(message),
    diagnostic: {
      code: 'canvas-dom-setup-required',
      message: 'The module expected a canvas during import, but the inspector page did not provide one.',
      hint:
        'Pass documentHtml such as `<canvas width="512" height="512"></canvas>` when inspecting app entrypoints that call document.querySelector("canvas") or root.configureContext(...) at import time.',
    },
  },
  {
    matches: (message) => MODULE_IMPORT_FAILED_PATTERN.test(message),
    diagnostic: {
      code: 'module-import-failed',
      message: 'The browser could not import the inspection module or one of its dependencies.',
      hint:
        'Check pageErrors for the underlying Vite transform/load error. Add documentHtml, browserSetup, staticAssetRoutes, dependencyAliases, fsAllow, or a narrower symbol target when import-time app setup is required.',
    },
  },
  {
    matches: (message) => INSPECTION_TIMEOUT_PATTERN.test(message),
    diagnostic: {
      code: 'inspection-timeout',
      message: 'The inspection did not complete before timeoutMs.',
      hint:
        'Increase timeoutMs, inspect fewer targets, or mock long-running app startup through browserSetup/setupBody.',
    },
  },
  {
    matches: (message) => SERIALIZATION_FAILURE_PATTERN.test(message),
    diagnostic: {
      code: 'result-serialization-failed',
      message: 'The inspection result could not be transferred from the browser runtime.',
      hint:
        'Retry with diagnosticsOnly or inspect one target at a time. If this persists, the inspector needs to bound one more browser-side value before returning.',
    },
  },
];

export function classifyImmediatelyUnsupportedResolvable(
  value: unknown,
): TargetDiagnostic | undefined {
  const resourceType = readResourceType(value);
  if (resourceType && !isShaderResolvableResourceType(resourceType)) {
    return {
      code: 'not-shader-resolvable',
      message: `The selected value is a TypeGPU '${resourceType}' resource, not a shader-resolvable function or expression.`,
      hint: getResourceTypeHint(resourceType),
      valueSummary: summarizeTargetValue(value),
    };
  }

  if (isTypegpuShaderResolvableLike(value)) {
    return undefined;
  }

  if (value && typeof value === 'object' && isPlainObject(value) && resourceType === undefined) {
    return {
      code: 'plain-object-not-inspectable',
      message:
        'The selected value is a plain JavaScript object. The inspector can resolve TypeGPU shader values or validate pipeline targets, but plain objects do not produce WGSL.',
      hint:
        'Select a concrete TypeGPU function/pipeline inside this object, or use setupBody/inlineCode to build one.',
      valueSummary: summarizeTargetValue(value),
    };
  }

  return undefined;
}

export function classifyImmediatelyUnsupportedPipeline(
  value: unknown,
  kind: InspectionTargetKind,
): TargetDiagnostic | undefined {
  const rawPipelineKind = readRawWebGpuPipelineKind(value);
  if (!rawPipelineKind) {
    return undefined;
  }

  return {
    code: 'raw-webgpu-pipeline-unsupported',
    message: `The selected value is a raw WebGPU ${rawPipelineKind} pipeline, not a TypeGPU pipeline.`,
    hint:
      kind === 'compute-pipeline'
        ? 'Select the TypeGPU compute entrypoint or TypeGPU pipeline before calling .rawPipeline. Raw GPUComputePipeline values cannot be inspected for TypeGPU WGSL or binding metadata.'
        : 'Select the TypeGPU render pipeline or its vertex/fragment entrypoints before calling .rawPipeline. Raw GPURenderPipeline values cannot be inspected for TypeGPU WGSL or binding metadata.',
    valueSummary: summarizeTargetValue(value),
  };
}

export function createSlotBindingRequiredDiagnostic(options: {
  slotName: string;
  appliedSlotNames: string[];
  valueSummary?: unknown;
  autoBindAttempted: boolean;
}): TargetDiagnostic {
  const { slotName, appliedSlotNames, valueSummary, autoBindAttempted } = options;
  const applied = appliedSlotNames.length > 0
    ? ` Slots already auto-bound before this failure: ${appliedSlotNames.join(', ')}.`
    : '';
  return {
    code: 'slot-binding-required',
    message: `The selected target depends on 'slot:${slotName}', but no value was bound for that slot${
      autoBindAttempted ? ' and the inspector could not auto-bind it' : ''
    }.`,
    hint: (autoBindAttempted
      ? `No matching accessor or borrowable binding was found among module exports, setup values, and sibling targets.${applied} Bind the slot through a symbol target \`with\` entry, \`probeBindings\`, or a \`root.with(slot, value)\` wrapper — exporting an accessor for this slot, or a pipeline/bound function that provides it, enables auto-binding.`
      : `Bind the slot through a symbol target \`with\` entry, or build a wrapper with \`root.with(slot, value)\` in setupBody/inlineCode.${applied}`),
    valueSummary,
  };
}

export function createAutoBindingsNote(applied: SatisfiedRequirement[]): TargetDiagnostic {
  const slotName = (entry: SatisfiedRequirement) =>
    String(entry.requirement.detail?.slotName ?? 'unknown slot');
  return {
    code: 'slot-bindings-auto-applied',
    severity: 'note',
    message: `${applied.length} slot value(s) were auto-bound for inspection; the WGSL reflects them.`,
    hint: applied
      .map((entry) => `slot:${slotName(entry)} <- ${entry.provision.provenance}.`)
      .join(' '),
    valueSummary: applied.map((entry) => ({
      slot: slotName(entry),
      provider: entry.provision.provider,
      provenance: entry.provision.provenance,
      value: summarizeTargetValue(entry.provision.value),
    })),
  };
}

export function diagnoseTargetFailure(
  value: unknown,
  kind: InspectionTargetKind,
  error: unknown,
): TargetDiagnostic[] {
  if (error instanceof TargetDiagnosticError) {
    return error.diagnostics;
  }

  const message = getErrorMessage(error);
  const valueSummary = summarizeTargetValue(value);

  return TARGET_DIAGNOSTIC_RULES
    .filter((rule) => rule.matches(message, value))
    .map((rule) => rule.create(message, value, kind, valueSummary));
}

export function diagnoseInspectionFailure(error: unknown): TargetDiagnostic[] {
  const message = getErrorMessage(error);
  // The optimizer already explained itself: the reason, the import that
  // pulled the package in, and the way out. A generic import rule would
  // only bury that.
  if (error instanceof Error && error.name === 'DependencyOptimizationError') {
    return [{ code: 'dependency-optimization', message }];
  }
  return INSPECTION_FAILURE_RULES
    .filter((rule) => rule.matches(message))
    .map((rule) => rule.diagnostic);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  const message = readStringProperty(error, 'message');
  if (message !== undefined) {
    return message;
  }
  return String(error);
}

function getResourceTypeHint(resourceType: string): string {
  if (isPipelineResourceType(resourceType)) {
    return `Inspect it with kind: '${resourceType}' instead of kind: 'resolvable'.`;
  }
  if (resourceType === 'vertex-layout') {
    return 'Use this value as the `attribs` selector of a render-pipeline target instead of resolving it directly.';
  }
  if (resourceType === 'slot' || resourceType.endsWith('accessor')) {
    return 'Inspect a function or pipeline that uses this slot/accessor instead — the inspector prefers bindings borrowed from exported pipelines/bound functions, then auto-binds default-less accessors with recursively non-degenerate schema-derived placeholders — or bind it explicitly through a target `with` entry or `root.with(...)` wrapper.';
  }
  return 'Select a shader-resolvable TypeGPU function/expression, or wrap this resource into a pipeline target.';
}

function getNotResolvableHint(value: unknown): string {
  const typegpuKind = readTypegpuFunctionKind(value);
  if (typegpuKind === 'fragment') {
    return 'A fragment function is often easiest to inspect as a render-pipeline target with a vertex entrypoint and targets descriptor.';
  }
  if (typegpuKind === 'vertex') {
    return 'A vertex function is often easiest to inspect as a render-pipeline target with a fragment entrypoint or no fragment target.';
  }
  if (typegpuKind === 'compute') {
    return "Inspect compute entrypoints with kind: 'compute-pipeline' when direct resolution needs pipeline context.";
  }
  return 'Select a TypeGPU fn/entrypoint/pipeline, or use inlineCode/setupBody to construct an inspectable wrapper target.';
}

function classifyNotResolvableCode(value: unknown): string {
  const typegpuKind = readTypegpuFunctionKind(value);
  if (typegpuKind) {
    return `typegpu-${typegpuKind}-function-not-resolvable`;
  }

  if (typeof value === 'function') {
    return readResourceType(value) ? 'typegpu-value-not-resolvable' : 'cpu-function-not-inspectable';
  }

  return isThreeNodeLikeSummary(summarizeTargetValue(value))
    ? 'three-node-not-inspectable'
    : 'value-not-inspectable';
}
