import * as d from 'typegpu/data';
import type {
  TypeGpuBindGroupLayoutReport,
  TypeGpuResourceReport,
  TypeGpuSchemaReport,
} from '../types.ts';

type RecordLike = Record<string, unknown>;

export function inspectResourceValue(value: unknown): TypeGpuResourceReport {
  return inspectResourceValueAtDepth(value, 0, new Set<object>());
}

/**
 * Projects TypeGPU's resolution-only layout objects into serializable,
 * descriptor-shaped metadata. Unlike recorded WebGPU calls, this remains
 * available when a lazy pipeline was already materialized during import.
 */
export function inspectResolvedBindGroupLayouts(
  layouts: readonly unknown[],
): TypeGpuBindGroupLayoutReport[] {
  return layouts.flatMap((layout, group) => {
    const entries = readRecord(layout, 'entries');
    if (!entries) return [];
    return [{
      group,
      label: describeBindGroupLayoutLabel(layout, group),
      source: 'resolution' as const,
      entries: Object.entries(entries).flatMap(([name, entry], binding) => {
        if (entry === null) return [];
        const record = asRecord(entry);
        if (!record) return [];
        const kind = layoutEntryKind(record);
        if (!kind) return [];
        return [{
          binding,
          name,
          visibility: layoutEntryVisibility(record, kind),
          resource: layoutEntryResource(record, kind),
        }];
      }),
    }];
  });
}

function inspectResourceValueAtDepth(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): TypeGpuResourceReport {
  if (Array.isArray(value)) {
    if (depth >= 6 || ancestors.has(value)) {
      return {
        resourceType: 'collection',
        count: value.length,
        properties: { truncated: true },
      };
    }
    const nextAncestors = new Set(ancestors).add(value);
    const items = value.slice(0, 64).map((item) =>
      inspectResourceValueAtDepth(item, depth + 1, nextAncestors)
    );
    return {
      resourceType: 'collection',
      count: value.length,
      items,
      ...(value.length > items.length
        ? { properties: { truncated: value.length - items.length } }
        : {}),
    };
  }

  const resourceType = readString(value, 'resourceType');
  const schema = readResourceSchema(value);
  const soul = readPrivateRecord(value, '$soul');

  if (!resourceType && isSchema(value)) {
    const described = describeSchema(value);
    return {
      resourceType: 'schema',
      schema: described,
      sizeBytes: described.sizeBytes,
      alignmentBytes: described.alignmentBytes,
    };
  }

  const collection = describeResourceRecord(value, depth, ancestors);
  if (!resourceType && collection) return collection;

  const report: TypeGpuResourceReport = {
    resourceType: resourceType ?? describeRuntimeType(value),
  };

  if (schema) {
    report.schema = describeSchema(schema);
    report.sizeBytes = report.schema.sizeBytes;
    report.alignmentBytes = report.schema.alignmentBytes;
  }

  if (resourceType === 'buffer') {
    const dataType = readProperty(value, 'dataType');
    if (isSchema(dataType)) {
      report.schema = describeSchema(dataType);
      report.sizeBytes = report.schema.sizeBytes;
      report.alignmentBytes = report.schema.alignmentBytes;
    }
    report.usages = resourceUsages(value, soul, [
      ['uniform', 'usableAsUniform'],
      ['storage', 'usableAsStorage'],
      ['vertex', 'usableAsVertex'],
      ['index', 'usableAsIndex'],
      ['indirect', 'usableAsIndirect'],
    ]);
    report.properties = compactRecord({
      flags: readNumber(value, 'flags') ?? readNumber(soul, 'flags'),
      destroyed: readBoolean(value, 'destroyed'),
      initialized: readProperty(value, 'initial') !== undefined,
    });
  } else if (
    resourceType === 'uniform' ||
    resourceType === 'readonly' ||
    resourceType === 'mutable'
  ) {
    const buffer = readProperty(value, 'buffer');
    const dataType = readProperty(buffer, 'dataType');
    if (isSchema(dataType)) {
      report.schema = describeSchema(dataType);
      report.sizeBytes = report.schema.sizeBytes;
      report.alignmentBytes = report.schema.alignmentBytes;
    }
    report.usages = [resourceType];
    report.properties = compactRecord({
      bufferResourceType: readString(buffer, 'resourceType'),
      initialized: readProperty(buffer, 'initial') !== undefined,
    });
  } else if (resourceType === 'texture') {
    const props = readRecord(value, 'props') ?? readRecord(soul, 'props');
    report.usages = resourceUsages(value, soul, [
      ['sampled', 'usableAsSampled'],
      ['storage', 'usableAsStorage'],
      ['render', 'usableAsRender'],
    ]);
    report.properties = compactRecord({
      size: sanitize(readProperty(props, 'size')),
      format: readString(props, 'format'),
      dimension: readString(props, 'dimension') ?? '2d',
      mipLevelCount: readNumber(props, 'mipLevelCount') ?? 1,
      sampleCount: readNumber(props, 'sampleCount') ?? 1,
      viewFormats: sanitize(readProperty(props, 'viewFormats')),
      destroyed: readBoolean(value, 'destroyed'),
      flags: readNumber(soul, 'flags'),
    });
  } else if (resourceType === 'texture-view') {
    report.properties = compactRecord({
      size: sanitize(readProperty(value, 'size')),
      descriptor: sanitize(readProperty(value, 'descriptor')),
      format: readPrivateInternalProperty(value, 'format'),
      aspect: readPrivateInternalProperty(value, 'aspect'),
    });
  } else if (resourceType === 'sampler' || resourceType === 'sampler-comparison') {
    report.properties = compactRecord({
      descriptor: sanitize(readProperty(soul, 'props')),
      comparison: resourceType === 'sampler-comparison',
    });
  } else if (resourceType === 'bind-group-layout') {
    const entries = readRecord(value, 'entries');
    report.bindings = entries ? describeLayoutEntries(entries) : [];
    report.properties = compactRecord({
      index: readNumber(value, 'index'),
      entryCount: report.bindings.length,
    });
  } else if (resourceType === 'bind-group') {
    const layout = readProperty(value, 'layout');
    const entries = readRecord(layout, 'entries');
    report.bindings = entries ? describeLayoutEntries(entries) : [];
    report.properties = compactRecord({
      entryCount: report.bindings.length,
      populatedEntries: Object.keys(readRecord(value, 'entries') ?? {}).length,
    });
  } else if (resourceType === 'vertex-layout') {
    report.properties = compactRecord({
      strideBytes: readNumber(value, 'stride'),
      stepMode: readString(value, 'stepMode'),
    });
    report.attributes = describeVertexAttribs(readProperty(value, 'attrib'));
  } else if (
    resourceType === 'accessor' ||
    resourceType === 'mutable-accessor'
  ) {
    report.properties = compactRecord({
      hasDefault: readProperty(value, 'defaultValue') !== undefined,
      defaultValue: sanitize(readProperty(value, 'defaultValue')),
    });
  } else if (resourceType === 'slot') {
    const defaultValue = readProperty(value, 'defaultValue');
    report.properties = compactRecord({
      hasDefault: defaultValue !== undefined,
      defaultValue: sanitize(defaultValue),
    });
  } else if (resourceType === 'var') {
    report.properties = { shaderDeclarationAvailable: true };
  } else if (resourceType === 'query-set') {
    report.properties = compactRecord({
      type: readString(value, 'type'),
      count: readNumber(value, 'count'),
      available: readBoolean(value, 'available'),
      destroyed: readBoolean(value, 'destroyed'),
    });
  } else {
    report.properties = compactRecord({
      runtimeType: describeRuntimeType(value),
      keys: safeKeys(value),
    });
  }

  return report;
}

export function flattenInspectableResources(value: unknown): unknown[] {
  return flattenInspectableResourcesAtDepth(value, 0, new Set<object>());
}

function flattenInspectableResourcesAtDepth(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): unknown[] {
  if (isInspectableResourceLeaf(value)) return [value];
  if (depth >= 6 || !value || typeof value !== 'object') return [];
  if (ancestors.has(value)) return [];
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 64).flatMap((item) =>
      flattenInspectableResourcesAtDepth(item, depth + 1, nextAncestors)
    );
  }
  if (!isPlainRecord(value)) return [value];
  return safeEntries(value, 256).flatMap(([, item]) =>
    flattenInspectableResourcesAtDepth(item, depth + 1, nextAncestors)
  );
}

export function shouldUnwrapResource(value: unknown): boolean {
  return new Set([
    'buffer',
    'texture',
    'texture-view',
    'sampler',
    'sampler-comparison',
    'bind-group-layout',
    'query-set',
  ]).has(readString(value, 'resourceType') ?? '');
}

export function shouldResolveResource(value: unknown): boolean {
  return new Set([
    'uniform',
    'readonly',
    'mutable',
    'texture-view',
    'sampler',
    'sampler-comparison',
    'var',
  ]).has(readString(value, 'resourceType') ?? '');
}

function readResourceSchema(value: unknown): unknown {
  const direct = readProperty(value, 'schema');
  return isSchema(direct) ? direct : undefined;
}

function describeResourceRecord(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): TypeGpuResourceReport | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (depth >= 6 || ancestors.has(value)) {
    return {
      resourceType: 'collection',
      properties: { truncated: true },
    };
  }
  const nextAncestors = new Set(ancestors).add(value);
  const entries = safeEntries(value, 256).filter(([, item]) =>
    containsInspectableResource(item, depth + 1, nextAncestors)
  );
  if (entries.length === 0) return undefined;
  const visible = entries.slice(0, 64);
  return {
    resourceType: 'collection',
    count: entries.length,
    itemNames: visible.map(([name]) => name),
    items: visible.map(([, item]) =>
      inspectResourceValueAtDepth(item, depth + 1, nextAncestors)
    ),
    ...(entries.length > visible.length
      ? { properties: { truncated: entries.length - visible.length } }
      : {}),
  };
}

function containsInspectableResource(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): boolean {
  if (isInspectableResourceLeaf(value)) return true;
  if (depth >= 6 || !value || typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 64).some((item) =>
      containsInspectableResource(item, depth + 1, nextAncestors)
    );
  }
  if (!isPlainRecord(value)) return false;
  return safeEntries(value, 256).some(([, item]) =>
    containsInspectableResource(item, depth + 1, nextAncestors)
  );
}

function isInspectableResourceLeaf(value: unknown): boolean {
  return typeof readString(value, 'resourceType') === 'string' || isSchema(value);
}

// WGSL implementations must support composite nesting depth 15 and up to
// 1,023 members in a structure. Keep the runtime report complete throughout
// that guaranteed-valid range; schemas beyond it are retained as an explicit
// truncation instead of silently disappearing from the editor surface.
const WGSL_MAX_COMPOSITE_NESTING_DEPTH = 15;
const WGSL_MAX_STRUCTURE_MEMBERS = 1_023;

function describeSchema(schema: unknown, depth = 1): TypeGpuSchemaReport {
  const type = readString(schema, 'type') ?? describeRuntimeType(schema);
  const report: TypeGpuSchemaReport = { type };
  const sizeBytes = safeSchemaNumber(() => d.sizeOf(schema as never));
  const alignmentBytes = safeSchemaNumber(() => d.alignmentOf(schema as never));
  if (sizeBytes !== undefined) report.sizeBytes = sizeBytes;
  if (alignmentBytes !== undefined) report.alignmentBytes = alignmentBytes;

  const fields = readRecord(schema, 'propTypes');
  const element = readProperty(schema, 'elementType');
  const inner = readProperty(schema, 'inner');
  const hasNestedSchema = fields !== undefined || isSchema(element) || isSchema(inner);
  if (depth > WGSL_MAX_COMPOSITE_NESTING_DEPTH && hasNestedSchema) {
    report.properties = {
      truncated: true,
      truncationReason: 'wgsl-composite-nesting-limit',
    };
    return report;
  }

  if (fields) {
    const entries = Object.entries(fields);
    report.fieldCount = entries.length;
    report.fields = entries.slice(0, WGSL_MAX_STRUCTURE_MEMBERS).map(([name, fieldSchema]) => {
      const layout = safeMemoryLayout(schema, name);
      return {
        name,
        ...(layout ? { offsetBytes: layout.offset } : {}),
        schema: describeSchema(fieldSchema, depth + 1),
      };
    });
    if (entries.length > WGSL_MAX_STRUCTURE_MEMBERS) {
      report.properties = {
        truncated: true,
        truncationReason: 'wgsl-structure-member-limit',
        omittedFields: entries.length - WGSL_MAX_STRUCTURE_MEMBERS,
      };
    }
  }

  if (isSchema(element)) {
    report.elementCount = readNumber(schema, 'elementCount');
    report.element = describeSchema(element, depth + 1);
    const elementSize = report.element.sizeBytes;
    const elementAlignment = report.element.alignmentBytes;
    if (elementSize !== undefined && elementAlignment !== undefined) {
      report.elementStrideBytes = roundUp(elementSize, elementAlignment);
    }
  }

  if (isSchema(inner)) {
    report.inner = describeSchema(inner, depth + 1);
  }

  report.properties = compactRecord({
    ...report.properties,
    dimension: readString(schema, 'dimension'),
    sampleType: readString(schema, 'sampleType'),
    bindingSampleTypes: sanitize(readProperty(schema, 'bindingSampleType')),
    multisampled: readBoolean(schema, 'multisampled'),
    format: readString(schema, 'format'),
    access: readString(schema, 'access'),
  });
  if (Object.keys(report.properties).length === 0) delete report.properties;
  return report;
}

function describeLayoutEntries(entries: RecordLike): Array<Record<string, unknown>> {
  return Object.entries(entries).map(([name, entry], binding) => {
    if (entry === null) {
      return { name, binding, kind: 'hole' };
    }
    const record = asRecord(entry);
    if (!record) return { name, binding, kind: describeRuntimeType(entry) };

    const kind = [
      'uniform',
      'storage',
      'sampler',
      'texture',
      'storageTexture',
      'externalTexture',
    ].find((key) => key in record) ?? 'unknown';
    const schema = record[kind];
    const schemaReport = isSchema(schema) ? describeSchema(schema) : undefined;
    return compactRecord({
      name,
      binding,
      kind,
      visibility: sanitize(record.visibility ?? defaultVisibility(kind, record.access)),
      access: readString(record, 'access'),
      samplerType: kind === 'sampler' ? record.sampler : undefined,
      sampleType: readString(record, 'sampleType'),
      schema: schemaReport,
    });
  });
}

function layoutEntryKind(record: RecordLike): string | undefined {
  return [
    'uniform',
    'storage',
    'sampler',
    'texture',
    'storageTexture',
    'externalTexture',
  ].find((key) => key in record);
}

function layoutEntryVisibility(record: RecordLike, kind: string): string[] {
  const declared = readProperty(record, 'visibility');
  if (Array.isArray(declared)) {
    const stages = declared.filter((stage): stage is string =>
      typeof stage === 'string'
    );
    if (stages.length > 0) return stages;
  }
  return defaultVisibility(kind, readProperty(record, 'access'));
}

function layoutEntryResource(record: RecordLike, kind: string): RecordLike {
  if (kind === 'uniform') {
    return { buffer: { type: 'uniform' } };
  }
  if (kind === 'storage') {
    return {
      buffer: {
        type: readString(record, 'access') === 'mutable'
          ? 'storage'
          : 'read-only-storage',
      },
    };
  }
  if (kind === 'sampler') {
    return { sampler: { type: readString(record, 'sampler') ?? 'filtering' } };
  }
  if (kind === 'texture') {
    const schema = asRecord(readProperty(record, 'texture'));
    const bindingSampleTypes = readProperty(schema, 'bindingSampleType');
    const inferredSampleType = Array.isArray(bindingSampleTypes)
      ? bindingSampleTypes.find((value): value is string => typeof value === 'string')
      : undefined;
    return {
      texture: compactRecord({
        sampleType: readString(record, 'sampleType') ?? inferredSampleType,
        viewDimension: readString(schema, 'dimension'),
        multisampled: readBoolean(schema, 'multisampled'),
      }),
    };
  }
  if (kind === 'storageTexture') {
    const schema = asRecord(readProperty(record, 'storageTexture'));
    return {
      storageTexture: compactRecord({
        access: readString(schema, 'access'),
        format: readString(schema, 'format'),
        viewDimension: readString(schema, 'dimension'),
      }),
    };
  }
  return { externalTexture: {} };
}

function describeBindGroupLayoutLabel(layout: unknown, group: number): string {
  try {
    const rendered = String(layout);
    const prefix = 'bindGroupLayout:';
    if (rendered.startsWith(prefix)) return rendered.slice(prefix.length);
  } catch {
    // A label is optional; structural entries are still useful.
  }
  return `<resolved group ${group}>`;
}

function describeVertexAttribs(value: unknown, path = ''): Array<Record<string, unknown>> {
  const record = asRecord(value);
  if (!record) return [];
  if (typeof record.format === 'string' && typeof record.offset === 'number') {
    return [{
      name: path || 'value',
      format: record.format,
      offsetBytes: record.offset,
    }];
  }
  return Object.entries(record).flatMap(([name, child]) =>
    name.startsWith('_') ? [] : describeVertexAttribs(child, path ? `${path}.${name}` : name)
  );
}

function defaultVisibility(kind: string, access: unknown): string[] {
  if (kind === 'storageTexture' || (kind === 'storage' && access === 'mutable')) {
    return ['compute', 'fragment'];
  }
  return ['compute', 'vertex', 'fragment'];
}

function resourceUsages(
  value: unknown,
  soul: RecordLike | undefined,
  checks: Array<[string, string]>,
): string[] {
  const usages = new Set<string>();
  const declared = readProperty(soul, 'usages');
  if (Array.isArray(declared)) {
    for (const usage of declared) {
      if (typeof usage === 'string') usages.add(usage);
    }
  }
  for (const [usage, property] of checks) {
    if (readBoolean(value, property)) usages.add(usage);
  }
  return [...usages];
}

function safeMemoryLayout(
  schema: unknown,
  field: string,
): { offset: number; contiguous: number } | undefined {
  try {
    return d.memoryLayoutOf(schema as never, (value) =>
      (value as RecordLike)[field]) as { offset: number; contiguous: number };
  } catch {
    return undefined;
  }
}

function safeSchemaNumber(read: () => number): number | undefined {
  try {
    const value = read();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isSchema(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as RecordLike).type === 'string'
  );
}

function readPrivateRecord(value: unknown, suffix: string): RecordLike | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    const symbol = Object.getOwnPropertySymbols(value)
      .find((candidate) => String(candidate).endsWith(`:${suffix})`));
    return symbol ? asRecord((value as Record<symbol, unknown>)[symbol]) : undefined;
  } catch {
    return undefined;
  }
}

function readPrivateInternalProperty(value: unknown, key: string): unknown {
  return sanitize(readProperty(readPrivateRecord(value, '$internal'), key));
}

function readRecord(value: unknown, key: string): RecordLike | undefined {
  return asRecord(readProperty(value, key));
}

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function isPlainRecord(value: unknown): value is RecordLike {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function safeEntries(value: RecordLike, limit: number): Array<[string, unknown]> {
  try {
    return Object.keys(value).slice(0, limit).flatMap((key) => {
      try {
        return [[key, value[key]]] as Array<[string, unknown]>;
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function readProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    return (value as RecordLike)[key];
  } catch {
    return undefined;
  }
}

function readString(value: unknown, key: string): string | undefined {
  const property = readProperty(value, key);
  return typeof property === 'string' ? property : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const property = readProperty(value, key);
  return typeof property === 'number' && Number.isFinite(property) ? property : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  const property = readProperty(value, key);
  return typeof property === 'boolean' ? property : undefined;
}

function compactRecord(value: RecordLike): RecordLike {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function sanitize(value: unknown, depth = 0): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= 4) return describeRuntimeType(value);
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => sanitize(entry, depth + 1));
  const record = asRecord(value);
  if (!record) return describeRuntimeType(value);
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 64)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, entry]) => [key, sanitize(entry, depth + 1)]),
  );
}

function safeKeys(value: unknown): string[] {
  try {
    return Object.keys(Object(value)).slice(0, 32);
  } catch {
    return [];
  }
}

function describeRuntimeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' || typeof value === 'function') {
    return value.constructor?.name ?? typeof value;
  }
  return typeof value;
}

function roundUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
