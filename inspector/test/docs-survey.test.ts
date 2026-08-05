import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverTypeGpuModule } from '../../server/src/discovery.ts';
import { inspectTypegpuSymbols } from '../src/inspect.ts';
import { closeAllInspectorSessions } from '../src/inspect/session.ts';
import { closeSharedBrowser } from '../src/inspect/browser.ts';

const docsRoot = process.env.TYPEGPU_DOCS_ROOT;
const runBrowser = process.env.TYPEGPU_MCP_RUN_BROWSER_TESTS === '1';
const maybeDescribe = docsRoot && runBrowser ? describe : describe.skip;

const CROSS_MODULE_CASES = [
  {
    name: 'ripple-cube pbr.shade',
    modulePath: 'apps/typegpu-docs/src/examples/simple/ripple-cube/pbr.ts',
    selector: 'shade',
    probeArguments: ['ctx.d.vec3f', 'ctx.d.vec3f', 'ctx.d.vec3f'],
  },
  {
    name: 'radiance-cascades scene.sceneSDF',
    modulePath: 'apps/typegpu-docs/src/examples/rendering/radiance-cascades/scene.ts',
    selector: 'sceneSDF',
    probeArguments: ['ctx.d.vec2f'],
  },
  {
    name: 'jump-flood visualization.distanceFrag',
    modulePath: 'apps/typegpu-docs/src/examples/algorithms/jump-flood-distance/visualization.ts',
    selector: 'distanceFrag',
  },
  {
    name: 'disco fragment.mainFragment1',
    modulePath: 'apps/typegpu-docs/src/examples/rendering/disco/shaders/fragment.ts',
    selector: 'mainFragment1',
  },
  {
    name: 'gravity render.mainFragment',
    modulePath: 'apps/typegpu-docs/src/examples/simulation/gravity/render.ts',
    selector: 'mainFragment',
  },
] as const;

maybeDescribe('typegpu-docs cross-module accessor survey', () => {
  afterAll(async () => {
    await closeAllInspectorSessions();
    await closeSharedBrowser();
  });

  for (const example of CROSS_MODULE_CASES) {
    for (const includePrivate of [false, true]) {
      it(`${example.name} (includePrivate=${includePrivate})`, { timeout: 120_000 }, async () => {
        const report = await inspectTypegpuSymbols({
          cwd: resolve(docsRoot as string, 'apps/typegpu-docs'),
          modulePath: resolve(docsRoot as string, example.modulePath),
          includePrivate,
          reuseBrowser: true,
          targets: [
            {
              label: example.name,
              selector: example.selector,
              kind: 'resolvable',
              unwrap: false,
              ...('probeArguments' in example
                ? { probeArguments: [...example.probeArguments] }
                : {}),
            },
          ],
          timeoutMs: 60_000,
        });

        const target = report.targets[0];
        expect(target?.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
        expect(target?.ledger).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'slot-value', status: 'satisfied' }),
          ]),
        );
      });
    }
  }

  it('loads TSX through the inspected project toolchain', { timeout: 120_000 }, async () => {
    const cwd = resolve(docsRoot as string, 'apps/typegpu-docs');
    const modulePath = resolve(cwd, 'src/examples/react/confetti/index.tsx');
    const discovered = discoverTypeGpuModule(modulePath, readFileSync(modulePath, 'utf8'));
    const report = await inspectTypegpuSymbols({
      cwd,
      modulePath,
      targets: discovered.targets.map((target) => target.selector),
      includePrivate: true,
      reuseBrowser: true,
      timeoutMs: 60_000,
    });

    expect(discovered.targets.length).toBeGreaterThan(0);
    expect(report.targets).toHaveLength(discovered.targets.length);
    expect(report.causes?.some((cause) => cause.code === 'module-import-failed')).not.toBe(true);
    expect(
      report.targets.some((target) => target.ok),
      JSON.stringify(report.targets, null, 2),
    ).toBe(true);
  });
});
