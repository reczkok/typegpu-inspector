import { isAccessor, isMutableAccessor, isSlot } from 'typegpu';
import type {
  InspectionTargetKind,
} from '../types.ts';
import { isRecord } from '../shared.ts';

export const COMPUTE_PIPELINE_RESOURCE_TYPE = 'compute-pipeline';
export const RENDER_PIPELINE_RESOURCE_TYPE = 'render-pipeline';
export const RESOLVABLE_TARGET_KIND = 'resolvable';
export const TYPEGPU_INTROSPECTION_ADAPTER = {
  privateShapes: [
    'resourceType',
    'shell.entryPoint',
    'Symbol(typegpu:*:$resolve)',
    'Symbol(typegpu:*:$soul)',
    'Symbol(typegpu:*:$internal).core.options',
    'Symbol(typegpu:*:$providing).pairs',
    'accessor.slot',
    'accessor.schema',
    'MissingSlotValueError.slot',
    'slot.toString()',
  ],
} as const;

// Keep TypeGPU private runtime probing isolated to this adapter. These shapes
// are not part of TypeGPU's public API and may need updates as TypeGPU evolves.

const PIPELINE_RESOURCE_TYPES = new Set<string>([
  COMPUTE_PIPELINE_RESOURCE_TYPE,
  RENDER_PIPELINE_RESOURCE_TYPE,
]);

const SHADER_RESOLVABLE_RESOURCE_TYPES = new Set([
  'function',
  'generic-function',
  'shellless-impl',
  'auto-fragment-fn',
  'auto-vertex-fn',
  'accessor',
  'mutable-accessor',
  'lazy',
  'const',
  'var',
  'uniform',
  'readonly',
  'mutable',
  'texture-view',
  'sampler',
  'sampler-comparison',
]);

const THREE_NODE_CONSTRUCTOR_PATTERN = /Node$|AttributeNode|ComputeNode|VaryingNode|TgpuFnNode/;

export type PipelineResourceType =
  | typeof COMPUTE_PIPELINE_RESOURCE_TYPE
  | typeof RENDER_PIPELINE_RESOURCE_TYPE;

export type TypegpuFunctionKind = 'compute' | 'vertex' | 'fragment';
export type RawWebGpuPipelineKind = 'compute' | 'render';

export function readResourceType(value: unknown): string | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    const resourceType = (value as { resourceType?: unknown }).resourceType;
    return typeof resourceType === 'string' ? resourceType : undefined;
  } catch {
    return undefined;
  }
}

export function isPipelineResourceType(value: string | undefined): value is PipelineResourceType {
  return value !== undefined && PIPELINE_RESOURCE_TYPES.has(value);
}

export function inferTargetKind(value: unknown): InspectionTargetKind {
  const resourceType = readResourceType(value);
  return isPipelineResourceType(resourceType) ? resourceType : RESOLVABLE_TARGET_KIND;
}

export function pipelineKindToResourceType(kind: InspectionTargetKind): PipelineResourceType | undefined {
  return isPipelineResourceType(kind) ? kind : undefined;
}

export function isShaderResolvableResourceType(resourceType: string): boolean {
  return SHADER_RESOLVABLE_RESOURCE_TYPES.has(resourceType);
}

export function readTypegpuFunctionKind(value: unknown): TypegpuFunctionKind | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }

  try {
    const entryPoint = (value as { shell?: { entryPoint?: unknown } }).shell?.entryPoint;
    return entryPoint === 'compute' || entryPoint === 'vertex' || entryPoint === 'fragment'
      ? entryPoint
      : undefined;
  } catch {
    return undefined;
  }
}

export function readRawWebGpuPipelineKind(value: unknown): RawWebGpuPipelineKind | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const constructorName = value.constructor?.name;
  if (constructorName === 'GPUComputePipeline') {
    return 'compute';
  }
  if (constructorName === 'GPURenderPipeline') {
    return 'render';
  }
  return undefined;
}

export function hasTypegpuInternalSymbol(value: unknown, name: string): boolean {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }

  try {
    return Object.getOwnPropertySymbols(value).some((symbol) =>
      String(symbol).endsWith(`:${name})`),
    );
  } catch {
    return false;
  }
}

export function readTypegpuSoulProperty(
  value: unknown,
  property: string,
): unknown | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    const soul = Object.getOwnPropertySymbols(value)
      .find((symbol) => String(symbol).endsWith(':$soul)'));
    if (!soul) return undefined;
    const record = (value as Record<symbol, unknown>)[soul];
    if (!record || typeof record !== 'object') return undefined;
    return (record as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

export function readTypegpuInternalProperty(
  value: unknown,
  property: string,
): unknown | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    const internal = Object.getOwnPropertySymbols(value)
      .find((symbol) => String(symbol).endsWith(':$internal)'));
    if (!internal) return undefined;
    const record = (value as Record<symbol, unknown>)[internal];
    if (!record || typeof record !== 'object') return undefined;
    return (record as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

export function isTypegpuShaderResolvableLike(value: unknown): boolean {
  return readTypegpuFunctionKind(value) !== undefined || hasTypegpuInternalSymbol(value, '$resolve');
}

// The public guards below fall back to structural resourceType checks because
// the inspected module may load a second typegpu instance whose marker symbols
// do not match the inspector's copy.

export function isSlotLike(value: unknown): boolean {
  try {
    if (isSlot(value as never)) return true;
  } catch {
    // fall through to the structural check
  }
  return readResourceType(value) === 'slot';
}

export function isAccessorLike(value: unknown): boolean {
  try {
    if (isAccessor(value as never)) return true;
  } catch {
    // fall through to the structural check
  }
  return readResourceType(value) === 'accessor';
}

export function isMutableAccessorLike(value: unknown): boolean {
  try {
    if (isMutableAccessor(value as never)) return true;
  } catch {
    // fall through to the structural check
  }
  return readResourceType(value) === 'mutable-accessor';
}

export function readAccessorSlot(value: unknown): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    const slot = (value as { slot?: unknown }).slot;
    return isSlotLike(slot) ? slot : undefined;
  } catch {
    return undefined;
  }
}

export function readAccessorSchema(value: unknown): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    return (value as { schema?: unknown }).schema;
  } catch {
    return undefined;
  }
}

const SLOT_NAME_MAX_LENGTH = 120;

export function readSlotName(slot: unknown): string {
  if (slot === null || slot === undefined) return 'unknown slot';
  try {
    const text = String(slot);
    const name = text.startsWith('slot:') ? text.slice('slot:'.length) : text;
    return name === '' ? 'unknown slot' : name.slice(0, SLOT_NAME_MAX_LENGTH);
  } catch {
    return 'unknown slot';
  }
}

const MISSING_SLOT_CAUSE_DEPTH = 10;

/**
 * Walks an error's cause chain looking for TypeGPU's MissingSlotValueError,
 * which carries the live slot object. Duck-typed rather than instanceof so a
 * second typegpu instance (or a re-thrown wrapper) still matches; returns
 * undefined for serialized errors, where the message-regex classifier remains
 * the fallback.
 */
export function readMissingSlotFromError(error: unknown): unknown {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < MISSING_SLOT_CAUSE_DEPTH; depth += 1) {
    if (!current || (typeof current !== 'object' && typeof current !== 'function')) {
      return undefined;
    }
    if (seen.has(current)) return undefined;
    seen.add(current);
    try {
      const slot = (current as { slot?: unknown }).slot;
      if (isSlotLike(slot)) return slot;
      current = (current as { cause?: unknown }).cause;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readPairArray(record: unknown, property: string): Array<[unknown, unknown]> | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const pairs = (record as Record<string, unknown>)[property];
  if (!Array.isArray(pairs)) return undefined;
  if (!pairs.every((pair) => Array.isArray(pair) && pair.length >= 2)) return undefined;
  return pairs as Array<[unknown, unknown]>;
}

/**
 * A function bound with `fn.with(slot, value)` records its bindings under the
 * $providing symbol as { inner, pairs: [slot, value][] }.
 */
export function readBoundFunctionProvidingPairs(
  value: unknown,
): Array<[unknown, unknown]> | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    const providing = Object.getOwnPropertySymbols(value)
      .find((symbol) => String(symbol).endsWith(':$providing)'));
    if (!providing) return undefined;
    return readPairArray((value as Record<symbol, unknown>)[providing], 'pairs');
  } catch {
    return undefined;
  }
}

/**
 * Render pipelines keep the `root.with(...)` bindings they were created under
 * at $internal.core.options.slotBindings. Compute pipelines store theirs in a
 * true private field and cannot be harvested.
 */
export function readRenderPipelineSlotBindings(
  value: unknown,
): Array<[unknown, unknown]> | undefined {
  try {
    const core = readTypegpuInternalProperty(value, 'core');
    if (!core || typeof core !== 'object') return undefined;
    const options = (core as { options?: unknown }).options;
    return readPairArray(options, 'slotBindings');
  } catch {
    return undefined;
  }
}

export function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function summarizeTargetValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'function') {
    return {
      type: 'function',
      name: value.name || 'anonymous',
      resourceType: readResourceType(value),
      arity: value.length,
    };
  }
  if (typeof value !== 'object') {
    return String(value);
  }

  const resourceType = readResourceType(value);
  const typegpuKind = readTypegpuFunctionKind(value);
  const summary: Record<string, unknown> = {
    type: 'object',
    constructor: value.constructor?.name ?? 'Object',
  };

  if (resourceType) {
    summary.resourceType = resourceType;
  }
  if (typegpuKind) {
    summary.typegpuKind = `${typegpuKind}-function`;
  }

  try {
    summary.keys = Object.keys(value).slice(0, 12);
  } catch {
    summary.keys = '[unavailable]';
  }

  return summary;
}

export function isThreeNodeLikeSummary(summary: unknown): boolean {
  return (
    isRecord(summary) &&
    typeof summary.constructor === 'string' &&
    THREE_NODE_CONSTRUCTOR_PATTERN.test(summary.constructor)
  );
}
