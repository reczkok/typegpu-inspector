import { describe, expect, it } from 'vitest';
import {
  code,
  formatInspectableValue,
  tableCode,
  tableRowWidth,
  tableText,
  valueText,
  visibleWidth,
} from '../src/markdown.js';

describe('hover markdown formatting', () => {
  it('adds invisible wrap opportunities to long technical values', () => {
    const rendered = valueText({
      storageTexture: {
        access: 'read-write',
        format: 'rgba32float',
        viewDimension: '2d-array',
      },
    });

    expect(rendered).toContain('\u200b');
    expect(rendered).toContain('storageTexture');
    expect(rendered).toContain('rgba32float');
  });

  it('bounds nested and circular values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatInspectableValue(circular)).toBe(
      '{ self: { self: {1 fields} } }',
    );
    expect(formatInspectableValue({ value: 'x'.repeat(400) })).toHaveLength(240);
  });

  it('keeps inline code valid while making it wrappable', () => {
    const rendered = code('array<struct.member, 128>');
    expect(rendered.startsWith('`')).toBe(true);
    expect(rendered.endsWith('`')).toBe(true);
    expect(rendered).toContain('\u200b');
  });

  it('keeps pipes from breaking Markdown table cells', () => {
    expect(tableText('vertex | fragment')).toContain('\\|');
    expect(tableCode('texture_2d<f32> | sampler')).toContain('\\|');
  });

  it('measures rendered width without markdown syntax', () => {
    expect(visibleWidth('**Primitive**')).toBe(9);
    expect(visibleWidth(code('vec4f'))).toBe(5);
    expect(visibleWidth(tableText('texture_2d<f32>'))).toBe(15);
    expect(tableRowWidth(['**Primitive**', 'triangle-list'])).toBe(25);
  });
});
