import { describe, expect, it } from 'vitest';
import { discoverTypeGpuModule } from '../src/discovery.js';
import { describeTargets, generatedWgsl } from '../src/editorRequests.js';
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
      ok: false,
      reason: 'Inspecting…',
    });
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
    expect(text).toContain('**standard**');
    expect(text).toContain('[deep](command:typegpuInspector.selectVerbosity?%5B%22deep%22%5D');
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
