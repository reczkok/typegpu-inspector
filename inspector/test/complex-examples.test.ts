import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectTypegpuModule } from '../src/inspect.ts';

const maybeIt = process.env.TYPEGPU_MCP_RUN_BROWSER_TESTS === '1' ? it : it.skip;
const cwd = resolve(import.meta.dirname, '..');

describe('complex examples', () => {
  maybeIt('validates a perlin/noise compute pipeline with cache injection', async () => {
    const report = await inspectTypegpuModule({
      cwd,
      source: { kind: 'modulePath', modulePath: 'examples/complex/noise-cache-compute.ts' },
      // perlin2d.staticCache initializes its own compute pipeline as probe
      // setup. A quiescent run stubs pipeline init, so the second pipeline
      // would never reach the device; this assertion needs the real thing.
      quiescent: false,
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.wgslSize).toBeGreaterThan(2_000);
    expect(report.stats.computePipelineCount).toBeGreaterThanOrEqual(2);
    expect(report.stats.bindGroupLayoutCount).toBeGreaterThan(0);
  });

  maybeIt('validates an MRT g-buffer render pipeline', async () => {
    const report = await inspectTypegpuModule({
      cwd,
      source: { kind: 'modulePath', modulePath: 'examples/complex/mrt-gbuffer-render.ts' },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.wgsl).toContain('@fragment');
    expect(report.calls.some((call) => call.name === 'device.createRenderPipeline')).toBe(true);
    expect(report.stats.renderPipelineCount).toBe(1);
  });

  maybeIt('validates multiple compute pipelines generated from a function slot', async () => {
    const report = await inspectTypegpuModule({
      cwd,
      source: { kind: 'modulePath', modulePath: 'examples/complex/slot-driven-integrator.ts' },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets).toHaveLength(3);
    expect(report.targets.every((target) => target.ok)).toBe(true);
    expect(report.stats.computePipelineCount).toBe(3);
  });

  maybeIt('auto-binds a bare function by borrowing from an exported bound sibling', async () => {
    const report = await inspectTypegpuModule({
      cwd,
      source: { kind: 'modulePath', modulePath: 'examples/complex/slot-borrowed-shading.ts' },
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]?.label).toBe('bare shading');
    expect(report.targets[0]?.wgsl).toContain('normalize');
    expect(report.targets[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'slot-bindings-auto-applied',
          severity: 'note',
          hint: expect.stringContaining('borrowed'),
        }),
      ]),
    );
    expect(report.targets[1]?.ok).toBe(true);
  });

  maybeIt('reports an unbindable default-less slot without harming siblings', async () => {
    const report = await inspectTypegpuModule({
      cwd,
      source: { kind: 'modulePath', modulePath: 'examples/complex/slot-unbindable.ts' },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(false);
    expect(report.targets[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'slot-binding-required',
          message: expect.stringContaining('mysterySlot'),
          hint: expect.stringContaining('module exports'),
        }),
      ]),
    );
    expect(report.targets[0]?.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'slot-bindings-auto-applied' }),
      ]),
    );
    expect(report.targets[1]?.ok).toBe(true);
  });

  maybeIt('binds a bare slot from bindings the recording shim observed', async () => {
    const report = await inspectTypegpuModule({
      cwd,
      source: { kind: 'modulePath', modulePath: 'examples/complex/recorded-binding-compute.ts' },
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]?.label).toBe('recorded pipeline');
    expect(report.targets[0]?.ok).toBe(true);
    expect(report.targets[1]?.ok).toBe(true);
    expect(report.targets[1]?.wgsl).toContain('2.5');
    expect(report.targets[1]?.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'slot-value',
          status: 'satisfied',
          provider: 'recorded-app-bindings',
        }),
      ]),
    );
  });

  maybeIt('binds bare slots from bindings made through root.pipe', async () => {
    const report = await inspectTypegpuModule({
      cwd,
      source: { kind: 'modulePath', modulePath: 'examples/complex/recorded-binding-pipe.ts' },
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]?.label).toBe('piped pipeline');
    expect(report.targets[0]?.ok).toBe(true);
    expect(report.targets[1]?.ok).toBe(true);
    expect(report.targets[1]?.wgsl).toContain('2.5');
    expect(report.targets[1]?.wgsl).toContain('3.5');
    expect(report.targets[1]?.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'slot-value',
          status: 'satisfied',
          provider: 'recorded-app-bindings',
        }),
      ]),
    );
  });

  maybeIt('validates a module importing an aliased helper library', async () => {
    const report = await inspectTypegpuModule({
      cwd,
      source: { kind: 'modulePath', modulePath: 'examples/complex/aliased-helper-library.ts' },
      dependencyAliases: {
        '#inspector-helpers': 'examples/deps/shader-library.ts',
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('aliased helper library render');
    expect(report.targets[0]?.wgsl).toContain('posterize');
  });
});
