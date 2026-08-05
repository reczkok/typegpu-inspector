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

/**
 * Unwraps `d.align(...)` / `d.size(...)` style decorations down to the callable
 * schema constructor. Decorated schemas are plain descriptor objects and are not
 * callable, so probes must never invoke a selected schema directly.
 */
export function unwrapZeroValueSchema(schema: unknown, label?: string): (...args: never[]) => unknown {
  let value = schema;
  while (
    value &&
    typeof value === 'object' &&
    (readString(value, 'type') === 'decorated' ||
      readString(value, 'type') === 'loose-decorated')
  ) {
    value = (value as { inner?: unknown }).inner;
  }
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
 * Placeholder value for slot auto-binding. Scalars and vectors are filled
 * with ones instead of zeros: the value is synthetic either way (and reported
 * as such), but zeros feed comptime arithmetic straight into division-by-zero
 * and NaN, which WGSL's finite-math assumption rejects at resolution time.
 * Structs, arrays, and matrices keep the plain zero value.
 */
export function createPlaceholderValue(schema: unknown, label?: string): unknown {
  const constructor = unwrapZeroValueSchema(schema, label);
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
