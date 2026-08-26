import { describe, expect, it } from 'vitest';
import { defaultSettings, settingsBounds } from '../src/protocol.js';
import { mergeSettings, unwrapSettings, type SettingsWarning } from '../src/settings.js';

describe('mergeSettings', () => {
  it('returns defaults for an empty payload', () => {
    expect(mergeSettings(undefined)).toEqual(defaultSettings);
    expect(mergeSettings({})).toEqual(defaultSettings);
  });

  it('accepts valid values and keeps defaults for the rest', () => {
    const merged = mergeSettings({
      inspectOn: 'hover',
      timeoutMs: 10_000,
      sourceMapping: false,
      schemaPackingSuggestions: false,
    });
    expect(merged.inspectOn).toBe('hover');
    expect(merged.timeoutMs).toBe(10_000);
    expect(merged.sourceMapping).toBe(false);
    expect(merged.schemaPackingSuggestions).toBe(false);
    expect(merged.inlayHints).toBe(true);
    expect(merged.maxWgslBytes).toBe(defaultSettings.maxWgslBytes);
    expect(merged.hoverDetailLevel).toBe('standard');
    expect(merged.inlayDetailLevel).toBe('compact');
  });

  it('keeps hover and inlay detail independent while accepting legacy aliases', () => {
    expect(mergeSettings({ detailLevel: 'verbose' })).toMatchObject({
      hoverDetailLevel: 'deep',
      inlayDetailLevel: 'detailed',
    });
    expect(mergeSettings({
      detailLevel: 'minimal',
      hoverDetailLevel: 'deep',
      inlayDetailLevel: 'compact',
    })).toMatchObject({
      hoverDetailLevel: 'deep',
      inlayDetailLevel: 'compact',
    });
  });

  it('validates advanced hover sections and clamps unbounded-content budgets', () => {
    const warnings: SettingsWarning[] = [];
    const merged = mergeSettings({
      hoverPresentation: {
        sections: { runtime: 'hide', nope: 'show' },
        sectionOrder: ['bindings', 'bindings', 'datasheet', 'schema', 'nope'],
        wgslPreviewLines: 99,
        maxColumns: 12,
      },
    }, defaultSettings, warnings);
    expect(merged.hoverPresentation).toMatchObject({
      sections: { runtime: 'hide' },
      sectionOrder: ['bindings', 'datasheet', 'schema'],
      wgslPreviewLines: 99,
      maxColumns: 40,
    });
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('drops invalid values with a warning instead of failing', () => {
    const warnings: SettingsWarning[] = [];
    const merged = mergeSettings(
      {
        inspectOn: 'onSave',
        timeoutMs: 'fast',
        diagnostics: 'yes',
      },
      defaultSettings,
      warnings,
    );
    expect(merged.inspectOn).toBe(defaultSettings.inspectOn);
    expect(merged.timeoutMs).toBe(defaultSettings.timeoutMs);
    expect(merged.diagnostics).toBe(true);
    expect(warnings.map((warning) => warning.key).sort()).toEqual([
      'diagnostics',
      'inspectOn',
      'timeoutMs',
    ]);
  });

  it('clamps out-of-range numbers with a warning', () => {
    const warnings: SettingsWarning[] = [];
    const merged = mergeSettings(
      { timeoutMs: 45, maxWgslBytes: 10 ** 12 },
      defaultSettings,
      warnings,
    );
    expect(merged.timeoutMs).toBe(settingsBounds.timeoutMs.min);
    expect(merged.maxWgslBytes).toBe(settingsBounds.maxWgslBytes.max);
    expect(warnings).toHaveLength(2);
  });

  it('layers over a non-default base without resetting it', () => {
    const base = mergeSettings({ inspectOn: 'off', projectRoot: '/tmp/x' });
    const merged = mergeSettings({ timeoutMs: 20_000 }, base);
    expect(merged.inspectOn).toBe('off');
    expect(merged.projectRoot).toBe('/tmp/x');
    expect(merged.timeoutMs).toBe(20_000);
  });

  it('filters non-string feature entries', () => {
    const merged = mergeSettings({ features: ['a', 1, null, 'b'] });
    expect(merged.features).toEqual(['a', 'b']);
  });

  // VS Code syncs the whole config section on any change, which delivers
  // projectRoot's "" default; that must read as "unset", or every
  // `projectRoot ?? workspaceRoot` fallback downstream degrades to "".
  it('treats an empty projectRoot as unset', () => {
    expect(mergeSettings({ projectRoot: '' }).projectRoot).toBeUndefined();
    expect(mergeSettings({ projectRoot: '   ' }).projectRoot).toBeUndefined();
    const base = mergeSettings({ projectRoot: '/tmp/x' });
    expect(mergeSettings({ projectRoot: '' }, base).projectRoot).toBeUndefined();
  });
});

describe('unwrapSettings', () => {
  it('unwraps nested settings and typegpuInspector envelopes', () => {
    expect(unwrapSettings({ settings: { inspectOn: 'off' } })).toEqual({
      inspectOn: 'off',
    });
    expect(unwrapSettings({ typegpuInspector: { inspectOn: 'off' } })).toEqual({
      inspectOn: 'off',
    });
    expect(unwrapSettings({ inspectOn: 'off' })).toEqual({ inspectOn: 'off' });
    expect(unwrapSettings(null)).toEqual({});
    expect(unwrapSettings('x')).toEqual({});
  });
});
