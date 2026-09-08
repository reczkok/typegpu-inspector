import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { inspectTypegpuSymbols } from '../src/inspect.ts';
import { closeSharedBrowser } from '../src/inspect/browser.ts';
import { closeAllInspectorSessions } from '../src/inspect/session.ts';

const browserIt = process.env.TYPEGPU_MCP_RUN_BROWSER_TESTS === '1' ? it : it.skip;

afterAll(async () => {
  await closeAllInspectorSessions();
  await closeSharedBrowser();
});

browserIt('drains failed dependency builds and compiles a CommonJS-dependent shader afterwards', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'typegpu-optimizer-recovery-'));
  try {
    for (const [name, source] of [
      ['broken-dependency', 'export const value: number = 1;'],
      ['working-dependency', 'exports.value = 7;'],
    ]) {
      const directory = join(cwd, 'node_modules', name!);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
      await writeFile(join(directory, 'index.js'), source!);
    }
    const shader = `
      import tgpu, { d } from 'typegpu';
      export const shade = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(value); });
    `;
    await writeFile(join(cwd, 'bad.ts'), "import { value } from 'broken-dependency';\n" + shader);
    await writeFile(join(cwd, 'good.ts'), `
      import type { value as NeverEvaluated } from 'broken-dependency';
      import { value } from 'working-dependency';
      ${shader}
    `);
    // Repeat in one process, both with a warm session cache and after explicit
    // teardown. A failed build must return its diagnostic and release Vite.
    for (let round = 0; round < 3; round++) {
      const bad = await inspectTypegpuSymbols({
        cwd, modulePath: 'bad.ts', targets: [{ kind: 'resolvable', selector: 'shade' }],
        reuseBrowser: true, timeoutMs: 5_000,
      });
      expect(bad.targets[0]?.outcome).toBe('blocked');
      expect(bad.targets[0]?.error?.name).toBe('DependencyOptimizationError');
      expect(bad.targets[0]?.error?.message).toContain('broken-dependency');
      const good = await inspectTypegpuSymbols({
        cwd, modulePath: 'good.ts', targets: [{ kind: 'resolvable', selector: 'shade' }],
        reuseBrowser: true, timeoutMs: 5_000,
      });
      expect(good.ok, JSON.stringify(good.targets)).toBe(true);
      expect(good.targets[0]?.wgsl).toContain('7');
      expect(good.targets[0]?.compilationSummary.errorCount).toBe(0);
      await closeAllInspectorSessions();
    }
  } finally {
    await closeAllInspectorSessions();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
