import type { InspectorSchemaReport } from './protocol.js';

export type SchemaFieldRow = {
  path: string;
  offsetBytes?: number;
  schema: InspectorSchemaReport;
};

export type SchemaPaddingRegion = {
  label: string;
  bytes: number;
};

export type HostShareability = {
  status: 'yes' | 'no' | 'unknown' | 'not-applicable';
  reason?: string;
};

export type SchemaReportCompleteness = {
  complete: boolean;
  path?: string;
  omittedFields?: number;
};

export type SchemaReorderAnalysis = {
  currentBytes: number;
  optimizedBytes: number;
  savingsBytes: number;
  suggestedOrder: string[];
};

export type SchemaLayoutAnalysis = {
  allocatedBytes?: number;
  dataBytes?: number;
  paddingBytes?: number;
  paddingRatio?: number;
  hostShareability: HostShareability;
  completeness: SchemaReportCompleteness;
  reorder?: SchemaReorderAnalysis;
  fields: SchemaFieldRow[];
  paddingRegions: SchemaPaddingRegion[];
};

const WGSL_MAX_COMPOSITE_NESTING_DEPTH = 15;
const EXACT_REORDER_FIELD_LIMIT = 14;

export function analyzeSchemaLayout(
  schema: InspectorSchemaReport,
  options: { packingSuggestions?: boolean } = {},
): SchemaLayoutAnalysis {
  const allocatedBytes = schema.sizeBytes;
  const dataBytes = schemaDataBytes(schema);
  const paddingBytes =
    allocatedBytes !== undefined &&
      dataBytes !== undefined &&
      dataBytes <= allocatedBytes
      ? allocatedBytes - dataBytes
      : undefined;
  const paddingRegions: SchemaPaddingRegion[] = [];
  collectPaddingRegions(schema, '', 1, paddingRegions, 1);
  const reorder = options.packingSuggestions !== false &&
      paddingBytes !== undefined && paddingBytes > 0
    ? analyzeFieldReordering(schema)
    : undefined;
  return {
    ...(allocatedBytes !== undefined ? { allocatedBytes } : {}),
    ...(dataBytes !== undefined ? { dataBytes } : {}),
    ...(paddingBytes !== undefined ? { paddingBytes } : {}),
    ...(paddingBytes !== undefined && allocatedBytes
      ? { paddingRatio: paddingBytes / allocatedBytes }
      : {}),
    hostShareability: analyzeHostShareability(schema),
    completeness: analyzeSchemaCompleteness(schema),
    ...(reorder ? { reorder } : {}),
    fields: flattenSchemaFields(schema),
    paddingRegions: mergePaddingRegions(paddingRegions),
  };
}

function analyzeSchemaCompleteness(
  schema: InspectorSchemaReport,
  path = '',
): SchemaReportCompleteness {
  if (schema.properties?.truncated === true) {
    return {
      complete: false,
      ...(path ? { path } : {}),
      ...(typeof schema.properties.omittedFields === 'number'
        ? { omittedFields: schema.properties.omittedFields }
        : {}),
    };
  }
  for (const field of schema.fields ?? []) {
    const result = analyzeSchemaCompleteness(
      field.schema,
      path ? `${path}.${field.name}` : field.name,
    );
    if (!result.complete) return result;
  }
  if (schema.element) {
    const result = analyzeSchemaCompleteness(schema.element, `${path || 'array'}[]`);
    if (!result.complete) return result;
  }
  if (schema.inner) {
    const result = analyzeSchemaCompleteness(schema.inner, path);
    if (!result.complete) return result;
  }
  return { complete: true };
}

function analyzeHostShareability(
  schema: InspectorSchemaReport,
  path = '',
  depth = 1,
): HostShareability {
  if (
    schema.properties?.truncated === true ||
    (depth > WGSL_MAX_COMPOSITE_NESTING_DEPTH &&
      (schema.fields !== undefined || schema.element !== undefined || schema.inner !== undefined))
  ) {
    return {
      status: 'unknown',
      reason: path
        ? `incomplete schema at ${path}`
        : 'schema report is incomplete',
    };
  }

  if (schema.fields) {
    if (schema.fieldCount !== undefined && schema.fieldCount !== schema.fields.length) {
      return { status: 'unknown', reason: 'not every structure field was reported' };
    }
    for (const field of schema.fields) {
      const fieldPath = path ? `${path}.${field.name}` : field.name;
      const result = analyzeHostShareability(field.schema, fieldPath, depth + 1);
      if (result.status !== 'yes') return result;
    }
    return { status: 'yes' };
  }

  if (schema.element) {
    return analyzeHostShareability(
      schema.element,
      `${path || 'array'}[]`,
      depth + 1,
    );
  }

  if (schema.inner) {
    return analyzeHostShareability(schema.inner, path, depth + 1);
  }

  const type = normalizeTypeName(schema.type);
  if (isHostShareableLeaf(type)) return { status: 'yes' };
  if (/^(?:texture|sampler)/.test(type)) {
    return { status: 'not-applicable' };
  }
  if (isKnownNonHostShareableLeaf(type)) {
    return {
      status: 'no',
      reason: `${path ? `${path} is ` : ''}${schema.type}`,
    };
  }
  return {
    status: 'unknown',
    reason: `${path ? `${path} has ` : ''}unrecognized type ${schema.type}`,
  };
}

function normalizeTypeName(type: string): string {
  return type.replace(/\s+/g, '').toLowerCase();
}

function isHostShareableLeaf(type: string): boolean {
  return /^(?:i32|u32|f16|f32|atomic<(?:i32|u32)>|buffer(?:<[^>]+>)?)$/.test(type) ||
    /^vec[234](?:[iufh]|<(?:i32|u32|f32|f16)>)$/.test(type) ||
    /^mat[234]x[234](?:[fh]|<(?:f32|f16)>)$/.test(type);
}

function isKnownNonHostShareableLeaf(type: string): boolean {
  return type === 'bool' || /^vec[234](?:b|<bool>)$/.test(type) ||
    /^(?:ptr|ref)/.test(type);
}

type LayoutField = {
  name: string;
  size: number;
  alignment: number;
  offset: number;
};

function analyzeFieldReordering(
  schema: InspectorSchemaReport,
): SchemaReorderAnalysis | undefined {
  if (!schema.fields?.length || schema.sizeBytes === undefined ||
    schema.properties?.truncated === true ||
    (schema.fieldCount !== undefined && schema.fieldCount !== schema.fields.length)) {
    return undefined;
  }
  const fields: LayoutField[] = [];
  for (const field of schema.fields) {
    const { sizeBytes, alignmentBytes } = field.schema;
    if (sizeBytes === undefined || alignmentBytes === undefined ||
      field.offsetBytes === undefined || sizeBytes < 0 ||
      !isPositivePowerOfTwo(alignmentBytes)) {
      return undefined;
    }
    fields.push({
      name: field.name,
      size: sizeBytes,
      alignment: alignmentBytes,
      offset: field.offsetBytes,
    });
  }

  const structureAlignment = Math.max(...fields.map((field) => field.alignment));
  if (schema.alignmentBytes !== undefined && schema.alignmentBytes !== structureAlignment) {
    return undefined;
  }
  const current = layoutOrder(fields, fields.map((_, index) => index), structureAlignment);
  if (current.size !== schema.sizeBytes ||
    current.offsets.some((offset, index) => offset !== fields[index]?.offset)) {
    return undefined;
  }

  const optimized = fields.length <= EXACT_REORDER_FIELD_LIMIT
    ? exactBestOrder(fields, structureAlignment)
    : heuristicBestOrder(fields, structureAlignment);
  if (optimized.size >= schema.sizeBytes) return undefined;
  return {
    currentBytes: schema.sizeBytes,
    optimizedBytes: optimized.size,
    savingsBytes: schema.sizeBytes - optimized.size,
    suggestedOrder: optimized.order.map((index) => fields[index]!.name),
  };
}

function exactBestOrder(
  fields: LayoutField[],
  structureAlignment: number,
): { size: number; order: number[] } {
  const stateCount = 1 << fields.length;
  const cursors = new Array<number>(stateCount).fill(Number.POSITIVE_INFINITY);
  const previous = new Int16Array(stateCount).fill(-1);
  const selected = new Int16Array(stateCount).fill(-1);
  cursors[0] = 0;
  for (let mask = 0; mask < stateCount; mask++) {
    const cursor = cursors[mask]!;
    if (!Number.isFinite(cursor)) continue;
    for (let index = 0; index < fields.length; index++) {
      const bit = 1 << index;
      if (mask & bit) continue;
      const nextMask = mask | bit;
      const field = fields[index]!;
      const nextCursor = roundUp(cursor, field.alignment) + field.size;
      if (nextCursor < cursors[nextMask]!) {
        cursors[nextMask] = nextCursor;
        previous[nextMask] = mask;
        selected[nextMask] = index;
      }
    }
  }
  const order: number[] = [];
  let mask = stateCount - 1;
  while (mask !== 0) {
    order.push(selected[mask]!);
    mask = previous[mask]!;
  }
  order.reverse();
  return {
    size: roundUp(cursors[stateCount - 1]!, structureAlignment),
    order,
  };
}

function heuristicBestOrder(
  fields: LayoutField[],
  structureAlignment: number,
): { size: number; order: number[] } {
  const order = fields.map((_, index) => index).sort((left, right) =>
    fields[right]!.alignment - fields[left]!.alignment ||
    fields[right]!.size - fields[left]!.size || left - right
  );
  return { size: layoutOrder(fields, order, structureAlignment).size, order };
}

function layoutOrder(
  fields: LayoutField[],
  order: number[],
  structureAlignment: number,
): { size: number; offsets: number[] } {
  let cursor = 0;
  const offsets: number[] = [];
  for (const index of order) {
    const field = fields[index]!;
    const offset = roundUp(cursor, field.alignment);
    offsets.push(offset);
    cursor = offset + field.size;
  }
  return { size: roundUp(cursor, structureAlignment), offsets };
}

function isPositivePowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function roundUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function schemaDataBytes(schema: InspectorSchemaReport): number | undefined {
  if (schema.inner) return schemaDataBytes(schema.inner);
  if (schema.fields) {
    if (
      schema.fieldCount !== undefined &&
      schema.fieldCount !== schema.fields.length
    ) {
      return undefined;
    }
    let total = 0;
    for (const field of schema.fields) {
      const bytes = schemaDataBytes(field.schema);
      if (bytes === undefined) return undefined;
      total += bytes;
    }
    return total;
  }
  if (schema.element && schema.elementCount !== undefined) {
    const elementBytes = schemaDataBytes(schema.element);
    return elementBytes === undefined
      ? undefined
      : elementBytes * schema.elementCount;
  }
  if (schema.properties?.truncated === true) return undefined;
  return primitiveDataBytes(schema.type) ?? schema.sizeBytes;
}

function primitiveDataBytes(type: string): number | undefined {
  if (/^(?:f32|i32|u32|bool)$/.test(type)) return 4;
  if (type === 'f16') return 2;

  const vector = /^vec([234])([fiuh])$/.exec(type);
  if (vector) {
    return Number(vector[1]) * (vector[2] === 'h' ? 2 : 4);
  }

  const matrix = /^mat([234])x([234])([fh])$/.exec(type);
  if (matrix) {
    return Number(matrix[1]) *
      Number(matrix[2]) *
      (matrix[3] === 'h' ? 2 : 4);
  }
  return undefined;
}

function flattenSchemaFields(
  schema: InspectorSchemaReport,
  prefix = '',
  baseOffset = 0,
  depth = 1,
  output: SchemaFieldRow[] = [],
): SchemaFieldRow[] {
  if (depth > WGSL_MAX_COMPOSITE_NESTING_DEPTH) return output;
  for (const field of schema.fields ?? []) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const offsetBytes = field.offsetBytes !== undefined
      ? baseOffset + field.offsetBytes
      : undefined;
    if (field.schema.fields?.length && offsetBytes !== undefined) {
      flattenSchemaFields(
        field.schema,
        path,
        offsetBytes,
        depth + 1,
        output,
      );
    } else {
      output.push({
        path,
        ...(offsetBytes !== undefined ? { offsetBytes } : {}),
        schema: field.schema,
      });
    }
  }
  return output;
}

function collectPaddingRegions(
  schema: InspectorSchemaReport,
  path: string,
  multiplier: number,
  output: SchemaPaddingRegion[],
  depth: number,
): void {
  if (
    depth > WGSL_MAX_COMPOSITE_NESTING_DEPTH &&
    (schema.fields !== undefined || schema.element !== undefined || schema.inner !== undefined)
  ) return;

  if (schema.fields?.length) {
    let cursor = 0;
    const fields = [...schema.fields].sort(
      (left, right) =>
        (left.offsetBytes ?? Number.MAX_SAFE_INTEGER) -
        (right.offsetBytes ?? Number.MAX_SAFE_INTEGER),
    );
    for (const field of fields) {
      const fieldPath = path ? `${path}.${field.name}` : field.name;
      const offset = field.offsetBytes;
      if (offset !== undefined && offset > cursor) {
        output.push({
          label: `before ${fieldPath}`,
          bytes: (offset - cursor) * multiplier,
        });
      }
      collectPaddingRegions(
        field.schema,
        fieldPath,
        multiplier,
        output,
        depth + 1,
      );
      if (offset !== undefined && field.schema.sizeBytes !== undefined) {
        cursor = Math.max(cursor, offset + field.schema.sizeBytes);
      }
    }
    if (schema.sizeBytes !== undefined && schema.sizeBytes > cursor) {
      output.push({
        label: path ? `${path} tail` : 'tail',
        bytes: (schema.sizeBytes - cursor) * multiplier,
      });
    }
    return;
  }

  if (
    schema.element &&
    schema.elementCount !== undefined &&
    schema.elementStrideBytes !== undefined
  ) {
    const elementSize = schema.element.sizeBytes;
    if (
      elementSize !== undefined &&
      schema.elementStrideBytes > elementSize
    ) {
      output.push({
        label: `${path || 'array'} element stride`,
        bytes:
          (schema.elementStrideBytes - elementSize) *
          schema.elementCount *
          multiplier,
      });
    }
    collectPaddingRegions(
      schema.element,
      `${path || 'array'}[]`,
      multiplier * schema.elementCount,
      output,
      depth + 1,
    );
    return;
  }

  if (schema.inner) {
    const innerBytes = schemaDataBytes(schema.inner);
    if (
      innerBytes !== undefined &&
      schema.sizeBytes !== undefined &&
      schema.sizeBytes > innerBytes
    ) {
      output.push({
        label: `${path || schema.type} internal`,
        bytes: (schema.sizeBytes - innerBytes) * multiplier,
      });
    }
    collectPaddingRegions(
      schema.inner,
      path,
      multiplier,
      output,
      depth + 1,
    );
    return;
  }

  const dataBytes = primitiveDataBytes(schema.type);
  if (
    dataBytes !== undefined &&
    schema.sizeBytes !== undefined &&
    schema.sizeBytes > dataBytes
  ) {
    output.push({
      label: `${path || schema.type} internal`,
      bytes: (schema.sizeBytes - dataBytes) * multiplier,
    });
  }
}

function mergePaddingRegions(
  regions: SchemaPaddingRegion[],
): SchemaPaddingRegion[] {
  const merged = new Map<string, number>();
  for (const region of regions) {
    if (region.bytes <= 0) continue;
    merged.set(region.label, (merged.get(region.label) ?? 0) + region.bytes);
  }
  return [...merged].map(([label, bytes]) => ({ label, bytes }));
}
