import { describe, expect, it } from 'vitest';
import type { InspectorSchemaReport } from '../src/protocol.js';
import { analyzeSchemaLayout } from '../src/schemaLayout.js';

describe('analyzeSchemaLayout', () => {
  it('flattens nested fields and accounts for structural padding', () => {
    const schema: InspectorSchemaReport = {
      type: 'struct',
      sizeBytes: 48,
      alignmentBytes: 16,
      fields: [{
        name: 'direction',
        offsetBytes: 0,
        schema: { type: 'vec2f', sizeBytes: 8, alignmentBytes: 8 },
      }, {
        name: 'radius',
        offsetBytes: 8,
        schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
      }, {
        name: 'camera',
        offsetBytes: 16,
        schema: {
          type: 'struct',
          sizeBytes: 32,
          alignmentBytes: 16,
          fields: [{
            name: 'position',
            offsetBytes: 0,
            schema: { type: 'vec3f', sizeBytes: 12, alignmentBytes: 16 },
          }, {
            name: 'exposure',
            offsetBytes: 16,
            schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
          }],
        },
      }],
    };

    expect(analyzeSchemaLayout(schema)).toEqual({
      allocatedBytes: 48,
      dataBytes: 28,
      paddingBytes: 20,
      paddingRatio: 20 / 48,
      hostShareability: { status: 'yes' },
      completeness: { complete: true },
      fields: [
        {
          path: 'direction',
          offsetBytes: 0,
          schema: { type: 'vec2f', sizeBytes: 8, alignmentBytes: 8 },
        },
        {
          path: 'radius',
          offsetBytes: 8,
          schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
        },
        {
          path: 'camera.position',
          offsetBytes: 16,
          schema: { type: 'vec3f', sizeBytes: 12, alignmentBytes: 16 },
        },
        {
          path: 'camera.exposure',
          offsetBytes: 32,
          schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
        },
      ],
      paddingRegions: [
        { label: 'before camera', bytes: 4 },
        { label: 'before camera.exposure', bytes: 4 },
        { label: 'camera tail', bytes: 12 },
      ],
    });
  });

  it('includes array element stride overhead', () => {
    const schema: InspectorSchemaReport = {
      type: 'array',
      sizeBytes: 64,
      alignmentBytes: 16,
      elementCount: 4,
      elementStrideBytes: 16,
      element: {
        type: 'vec3f',
        sizeBytes: 12,
        alignmentBytes: 16,
      },
    };

    expect(analyzeSchemaLayout(schema)).toMatchObject({
      allocatedBytes: 64,
      dataBytes: 48,
      paddingBytes: 16,
      paddingRatio: 0.25,
      paddingRegions: [
        { label: 'array element stride', bytes: 16 },
      ],
      hostShareability: { status: 'yes' },
    });
  });

  it('identifies host-shareability failures at the responsible field', () => {
    const analysis = analyzeSchemaLayout({
      type: 'struct',
      sizeBytes: 8,
      alignmentBytes: 4,
      fields: [{
        name: 'enabled',
        offsetBytes: 0,
        schema: { type: 'bool', sizeBytes: 4, alignmentBytes: 4 },
      }, {
        name: 'count',
        offsetBytes: 4,
        schema: { type: 'u32', sizeBytes: 4, alignmentBytes: 4 },
      }],
    });

    expect(analysis.hostShareability).toEqual({
      status: 'no',
      reason: 'enabled is bool',
    });
    expect(analyzeSchemaLayout({
      type: 'atomic',
      sizeBytes: 4,
      alignmentBytes: 4,
      inner: { type: 'u32', sizeBytes: 4, alignmentBytes: 4 },
    }).hostShareability).toEqual({ status: 'yes' });
  });

  it('proves a tighter field order and reports its exact savings', () => {
    const analysis = analyzeSchemaLayout({
      type: 'struct',
      sizeBytes: 48,
      alignmentBytes: 16,
      fields: [{
        name: 'age',
        offsetBytes: 0,
        schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
      }, {
        name: 'position',
        offsetBytes: 16,
        schema: { type: 'vec4f', sizeBytes: 16, alignmentBytes: 16 },
      }, {
        name: 'mass',
        offsetBytes: 32,
        schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
      }],
    });

    expect(analysis.reorder).toMatchObject({
      currentBytes: 48,
      optimizedBytes: 32,
      savingsBytes: 16,
    });
    expect(analysis.reorder?.suggestedOrder).toHaveLength(3);
    expect(analyzeSchemaLayout({
      type: 'struct',
      sizeBytes: 48,
      alignmentBytes: 16,
      fields: [{
        name: 'age',
        offsetBytes: 0,
        schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
      }, {
        name: 'position',
        offsetBytes: 16,
        schema: { type: 'vec4f', sizeBytes: 16, alignmentBytes: 16 },
      }, {
        name: 'mass',
        offsetBytes: 32,
        schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
      }],
    }, { packingSuggestions: false }).reorder).toBeUndefined();
  });

  it('keeps every field within the WGSL-required structure and nesting limits', () => {
    const fields = Array.from({ length: 1_023 }, (_, index) => ({
      name: `field${index}`,
      offsetBytes: index * 4,
      schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
    }));
    let nested: InspectorSchemaReport = {
      type: 'f32',
      sizeBytes: 4,
      alignmentBytes: 4,
    };
    for (let depth = 0; depth < 15; depth++) {
      nested = {
        type: 'struct',
        sizeBytes: 4,
        alignmentBytes: 4,
        fields: [{ name: `level${depth}`, offsetBytes: 0, schema: nested }],
      };
    }

    expect(analyzeSchemaLayout({
      type: 'struct',
      sizeBytes: fields.length * 4,
      alignmentBytes: 4,
      fieldCount: fields.length,
      fields,
    }).fields).toHaveLength(1_023);
    const nestedAnalysis = analyzeSchemaLayout(nested);
    expect(nestedAnalysis.fields[0]?.path.split('.')).toHaveLength(15);
    expect(nestedAnalysis.hostShareability).toEqual({ status: 'yes' });
  });

  it('retains every padding region so the presenter can report exact omissions', () => {
    const fields = Array.from({ length: 40 }, (_, index) => ({
      name: `value${index}`,
      offsetBytes: index * 8,
      schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
    }));
    const analysis = analyzeSchemaLayout({
      type: 'struct',
      sizeBytes: 320,
      alignmentBytes: 4,
      fields,
    });

    expect(analysis.paddingRegions).toHaveLength(40);
  });
});
