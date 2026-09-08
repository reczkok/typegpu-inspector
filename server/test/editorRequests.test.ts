import { describe, expect, it } from 'vitest';
import { discoverTypeGpuModule } from '../src/discovery.js';
import { describeTargets, generatedWgsl, targetReport, generatedDocumentDiagnostics } from '../src/editorRequests.js';
import {
  createHover,
  defaultSurfaceOptions,
  failedTargetInspection,
  materializeInspection,
} from '../src/surface.js';

const source = 'const pipeline = root.createRenderPipeline({ vertex, fragment });';
const wgsl = [
  '@vertex fn vertex() -> @builtin(position) vec4f { return vec4f(); }',
  '@fragment fn fragment() -> @location(0) vec4f { return vec4f(1); }',
].join('\n');

async function inspected() {
  const discovered = discoverTypeGpuModule('/workspace/render.ts', source);
  const inspection = await materializeInspection(
    '/workspace',
    '/workspace/render.ts',
    1,
    discovered,
    {
      ok: true,
      targets: [{
        label: 'pipeline',
        kind: 'render-pipeline',
        ok: true,
        compilationMessages: [
          { type: 'error', message: 'unresolved value', lineNum: 2, linePos: 14 },
        ],
        wgsl,
      }],
    },
  );
  return { discovered, inspection };
}

describe('typegpu/targets', () => {
  it('lists symbols with their targets and per-target status', async () => {
    const { discovered, inspection } = await inspected();
    const response = describeTargets(1, discovered, inspection, new Set());
    expect(response.stale).toBe(false);
    expect(response.symbols.map((symbol) => symbol.name)).toContain('pipeline');
    const target = response.targets.find((entry) => entry.label === 'pipeline');
    expect(target).toMatchObject({ status: 'ok', kind: 'render-pipeline', wgslLines: 2 });
  });

  it('reports inspecting, stale, and not-inspected states', async () => {
    const { discovered, inspection } = await inspected();
    const id = discovered.targets[0]!.id;
    expect(describeTargets(1, discovered, inspection, new Set([id])).targets[0]!.status)
      .toBe('inspecting');
    expect(describeTargets(2, discovered, inspection, new Set()).stale).toBe(true);
    expect(describeTargets(1, discovered, undefined, new Set()).targets[0]!.status)
      .toBe('not-inspected');
  });
});

describe('typegpu/wgsl', () => {
  it('returns the generated WGSL with compiler messages mapped to ranges', async () => {
    const { discovered, inspection } = await inspected();
    const response = generatedWgsl(1, discovered, inspection, discovered.targets[0]!.id, new Set());
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.wgsl).toBe(wgsl);
    expect(response.stale).toBe(false);
    expect(response.messages[0]).toMatchObject({ type: 'error', message: 'unresolved value' });
    expect(response.messages[0]!.range?.start.line).toBe(1);
  });

  it('explains why there is nothing to show', async () => {
    const { discovered, inspection } = await inspected();
    const id = discovered.targets[0]!.id;
    expect(generatedWgsl(1, discovered, undefined, id, new Set())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Save the file'),
    });
    expect(generatedWgsl(1, discovered, inspection, id, new Set([id]))).toMatchObject({
      ok: true, refreshing: true, wgsl,
    });
    expect(generatedWgsl(1, discovered, undefined, id, new Set([id]))).toMatchObject({ ok: false, reason: 'Inspecting…' });
    expect(generatedWgsl(1, discovered, inspection, 'missing', new Set())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no longer exists'),
    });
    const failed = failedTargetInspection(1, [id], 'Chromium crashed');
    expect(generatedWgsl(1, discovered, failed, id, new Set())).toMatchObject({
      ok: false,
      reason: 'Inspection failed: Chromium crashed',
    });
  });
});

describe('VS Code hover actions', () => {
  it('links to the extension commands and marks the current detail level', async () => {
    const { discovered, inspection } = await inspected();
    const hover = createHover(discovered.symbols[0]!, discovered, inspection, 1, new Set(), {
      ...defaultSurfaceOptions,
      presentation: 'vscode',
      documentUri: 'file:///workspace/render.ts',
      hoverDetailLevel: 'standard',
    });
    const text = (hover.contents as { value: string }).value;
    const args = encodeURIComponent(JSON.stringify([{
      uri: 'file:///workspace/render.ts',
      targetId: discovered.targets[0]!.id,
    }]));
    expect(text).toContain(`command:typegpuInspector.openWgsl?${args}`);
    expect(text).toContain(`command:typegpuInspector.peekWgsl?${args}`);
    expect(text).not.toContain('Open generated WGSL](file:');
    expect(text).not.toContain('selectVerbosity');
  });

  it('renders the full report as table markdown for the preview', async () => {
    const { discovered, inspection } = await inspected();
    const response = targetReport(1, discovered, inspection, discovered.targets[0]!.id, new Set(), {
      ...defaultSurfaceOptions,
      presentation: 'vscode',
      hoverDetailLevel: 'compact',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.markdown).toContain('| --- |');
    expect(response.markdown).toContain('@fragment fn fragment()');
    expect(response.markdown).not.toContain('```text');
  });

  it('keeps file links for other editors', async () => {
    const { discovered, inspection } = await inspected();
    const hover = createHover(discovered.symbols[0]!, discovered, inspection, 1, new Set(), {
      ...defaultSurfaceOptions,
      documentUri: 'file:///workspace/render.ts',
    });
    const text = (hover.contents as { value: string }).value;
    expect(text).toContain('[Open generated WGSL](file:');
    expect(text).not.toContain('command:');
  });
});


describe('specialization workflow', () => {
  const nestedSource = "function makeBlur(radius: number) { const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(radius); }); }";
  async function nested() {
    const discovered = discoverTypeGpuModule('/workspace/nested.ts', nestedSource);
    const inspection = await materializeInspection('/workspace', '/workspace/nested.ts', 1, discovered, {
      ok: true, targets: [0, 1].map(instance => ({
        label: `makeBlur.helper [instance ${instance}]`, parentLabel: 'makeBlur.helper',
        kind: 'resolvable', ok: true, outcome: 'passed', context: { instance },
        wgsl: `fn helper() -> f32 { return ${instance ? 7 : 3}; }`,
      })),
    });
    return { discovered, inspection };
  }

  it('retains observed instances and WGSL while edits move the declaration', async () => {
    const { discovered, inspection } = await nested();
    const target = discovered.targets[1]!;
    const edited = discoverTypeGpuModule('/workspace/nested.ts', '// moved\n' + nestedSource);
    const progress = new Set(edited.targets.map(target => target.id));
    const snapshot = describeTargets(2, edited, inspection, progress);
    expect(snapshot.targets).toHaveLength(2);
    expect(snapshot.targets.every(target => target.status === 'inspecting')).toBe(true);
    expect(snapshot.symbols[0]!.targetIds).toContain(target.id);
    expect(generatedWgsl(2, edited, inspection, target.id, progress)).toMatchObject({
      ok: true, stale: true, refreshing: true, sourceVersion: 1, context: { instance: 1 },
    });
    const report = targetReport(2, edited, inspection, target.id, new Set(), defaultSurfaceOptions);
    expect(report).toMatchObject({ ok: true, stale: true });
    if (report.ok) {
      expect(report.markdown).toContain('return 7');
      expect(report.markdown).not.toContain('return 3');
    }
  });

  it.each(['blocked', 'unsupported', 'passed-with-assumptions'] as const)('preserves %s as structured editor data', async outcome => {
    const { discovered, inspection } = await nested();
    const report = inspection.targets.values().next().value!.report;
    report.outcome = outcome;
    report.ok = outcome === 'passed-with-assumptions';
    report.diagnostics = [{ code: 'slot-binding-required', message: 'Supply the color slot' }];
    expect(describeTargets(1, discovered, inspection, new Set()).targets[0]).toMatchObject({ outcome, diagnostics: report.diagnostics });
  });
});


describe('generated file diagnostics', () => {
  it('marks previous WGSL stale and clears compiler errors after recovery', async () => {
    const { inspection } = await inspected();
    const target = inspection.targets.values().next().value!;
    const uri = target.generatedUri!;
    expect(generatedDocumentDiagnostics(undefined, inspection).get(uri)?.[0]).toMatchObject({ source: 'WGSL compiler', severity: 1 });
    expect(generatedDocumentDiagnostics(inspection, inspection, true).get(uri)?.[0]).toMatchObject({ message: expect.stringContaining('Previous inspection'), severity: 2 });
    const recovered = { ...inspection, targets: new Map([[target.target.id, { ...target, report: { ...target.report, compilationMessages: [] } }]]) };
    expect(generatedDocumentDiagnostics(inspection, recovered).get(uri)).toEqual([]);
    expect(generatedDocumentDiagnostics(inspection, undefined).get(uri)?.[0]?.message).toContain('Previous inspection');
  });
});


it('never serves a cached report for a different declaration reusing an ID', async () => {
  const { discovered, inspection } = await inspected();
  discovered.targets[0] = { ...discovered.targets[0]!, label: 'renamed' };
  expect(describeTargets(2, discovered, inspection, new Set()).targets[0]!.status).toBe('not-inspected');
  expect(generatedWgsl(2, discovered, inspection, discovered.targets[0]!.id, new Set()).ok).toBe(false);
});
