import type { LedgerEntry } from './types.ts';

type DataNamespace = {
  arrayOf(schema: unknown): unknown;
  isBuiltin?(schema: unknown): boolean;
};

type TypeGpuNamespace = {
  vertexLayout(schemaForCount: (count: number) => unknown): {
    attrib: unknown;
  };
};

const MAX_PLACEHOLDER_DEPTH = 32;

/**
 * Unwraps `d.align(...)` / `d.size(...)` style decorations down to the callable
 * schema constructor. Decorated schemas are plain descriptor objects and are not
 * callable, so probes must never invoke a selected schema directly.
 */
export function unwrapZeroValueSchema(schema: unknown, label?: string): (...args: never[]) => unknown {
  const value = unwrapSchema(schema);
  if (typeof value !== 'function') {
    throw new Error(
      `Cannot synthesize a zero value for schema '${String(schema)}'${
        label ? ` selected by ${label}` : ''
      }. Expected a callable TypeGPU schema.`,
    );
  }
  return value as (...args: never[]) => unknown;
}

/** Builds a CPU-side zero value from a (possibly decorated) TypeGPU schema. */
export function createZeroValue(schema: unknown, label?: string): unknown {
  return unwrapZeroValueSchema(schema, label)();
}

/**
 * Builds a deterministic, schema-derived placeholder for slot auto-binding.
 * Real application bindings always outrank this provider. When synthesis is
 * necessary, floating/integer scalars and vectors use ones, matrices use their
 * identity, and structs/fixed arrays recursively apply the same policy.
 *
 * The policy looks at data shape only, never at field names. A plain zero
 * composite routinely turns valid shader invariants (dimensions, periods,
 * scales, normalizers) into division-by-zero or NaN during comptime resolution;
 * identity matrices and recursively non-zero leaves avoid that. The ledger
 * marks every such value as synthesized.
 */
export function createPlaceholderValue(schema: unknown, label?: string): unknown {
  return createPlaceholder(schema, label, 0, new Set());
}

function createPlaceholder(
  schema: unknown,
  label: string | undefined,
  depth: number,
  ancestors: Set<unknown>,
): unknown {
  const value = unwrapSchema(schema);
  const constructor = unwrapZeroValueSchema(value, label);
  if (depth >= MAX_PLACEHOLDER_DEPTH || ancestors.has(value)) {
    return constructor();
  }

  ancestors.add(value);
  try {
    const type = readString(value, 'type');
    if (type === 'struct' || type === 'unstruct') {
      const propTypes = readRecord(value, 'propTypes');
      if (propTypes) {
        const props = Object.fromEntries(
          Object.entries(propTypes).map(([name, propertySchema]) => [
            name,
            createNestedPlaceholder(
              propertySchema,
              label ? `${label}.${name}` : name,
              depth + 1,
              ancestors,
            ),
          ]),
        );
        return (constructor as (props: Record<string, unknown>) => unknown)(props);
      }
    }

    if (type === 'array' || type === 'disarray') {
      const elementType = readUnknown(value, 'elementType');
      const elementCount = readNumber(value, 'elementCount');
      if (elementType !== undefined && elementCount !== undefined) {
        const elements = Array.from({ length: elementCount }, (_, index) =>
          createNestedPlaceholder(
            elementType,
            label ? `${label}[${index}]` : `[${index}]`,
            depth + 1,
            ancestors,
          )
        );
        return (constructor as (elements: unknown[]) => unknown)(elements);
      }
    }

    if (type === 'mat2x2f' || type === 'mat3x3f' || type === 'mat4x4f') {
      const identity = readUnknown(value, 'identity');
      if (typeof identity === 'function') {
        return identity.call(value);
      }
    }

    const zero = constructor();
    if (typeof zero === 'number' || isVecLike(zero)) {
      try {
        const ones = (constructor as (splat: number) => unknown)(1);
        if (ones !== undefined && ones !== null) return ones;
      } catch {
        // A constructor that rejects a scalar splat keeps its zero value.
      }
    }
    return zero;
  } catch {
    // Unknown future schema shapes retain the previous safe behavior instead
    // of making auto-binding itself a new source of inspection failures.
    return constructor();
  } finally {
    ancestors.delete(value);
  }
}

function createNestedPlaceholder(
  schema: unknown,
  label: string,
  depth: number,
  ancestors: Set<unknown>,
): unknown {
  try {
    return createPlaceholder(schema, label, depth, ancestors);
  } catch {
    return createZeroValue(schema, label);
  }
}

function unwrapSchema(schema: unknown): unknown {
  let value = schema;
  while (
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    (readString(value, 'type') === 'decorated' ||
      readString(value, 'type') === 'loose-decorated')
  ) {
    value = readUnknown(value, 'inner');
  }
  return value;
}

function isVecLike(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { x?: unknown }).x === 'number'
  );
}

export function synthesizeVertexAttribs(
  tgpu: TypeGpuNamespace,
  d: DataNamespace,
  vertex: unknown,
): Record<string, unknown> {
  const input = readNestedRecord(vertex, ['shell', 'in']);
  if (!input) return {};

  const attribs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(input)) {
    if (d.isBuiltin?.(schema)) continue;
    try {
      const layout = tgpu.vertexLayout((count) =>
        (d.arrayOf(schema) as (count?: number) => unknown)(count)
      );
      attribs[name] = layout.attrib;
    } catch {
      // A non-vertex schema is better reported by pipeline validation than by
      // aborting synthesis for every other valid attribute.
    }
  }
  return attribs;
}

export function synthesizeFragmentTargets(
  d: DataNamespace,
  fragment: unknown,
): Record<string, unknown> | undefined {
  const shell = readNestedRecord(fragment, ['shell']);
  const output = shell?.out ?? shell?.returnType;
  if (!output || d.isBuiltin?.(output)) return undefined;

  const propTypes = readNestedRecord(output, ['propTypes']);
  if (propTypes) {
    const entries = Object.entries(propTypes)
      .filter(([, schema]) => !d.isBuiltin?.(schema))
      .map(([name]) => [name, { format: 'rgba8unorm' }]);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  const type = readString(output, 'type');
  return type && type !== 'void' ? { format: 'rgba8unorm' } : undefined;
}

export function createVertexAttribsLedgerEntry(): LedgerEntry {
  return {
    tier: 'target',
    kind: 'vertex-attribs',
    key: 'vertex-attribs:descriptor',
    status: 'satisfied',
    discoveredBy: 'shape',
    provider: 'synthesis',
    provenance:
      'Vertex attributes were synthesized from vertex.shell.in using one minimal vertex layout per attribute.',
  };
}

export function createFragmentTargetsLedgerEntry(): LedgerEntry {
  return {
    tier: 'target',
    kind: 'fragment-targets',
    key: 'fragment-targets:descriptor',
    status: 'satisfied',
    discoveredBy: 'shape',
    provider: 'synthesis',
    provenance:
      'Fragment targets were synthesized from fragment.shell.out with rgba8unorm formats.',
  };
}

function readNestedRecord(
  value: unknown,
  path: string[],
): Record<string, unknown> | undefined {
  let current = value;
  for (const key of path) {
    if (!current || (typeof current !== 'object' && typeof current !== 'function')) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === 'object'
    ? current as Record<string, unknown>
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const candidate = readUnknown(value, key);
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const candidate = readUnknown(value, key);
  return candidate && typeof candidate === 'object'
    ? candidate as Record<string, unknown>
    : undefined;
}

function readUnknown(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
