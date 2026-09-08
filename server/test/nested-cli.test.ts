import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo, type RuntimeLike } from '../src/cli.js';

describe('nested shader CLI transport', () => {
  it('expands instances, forwards a fixture, selects an instance, and retains failed targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typegpu-nested-cli-'));
    try {
      const path = join(dir, 'shader.ts');
      await writeFile(path, `import { tgpu, d } from 'typegpu';
        function make(radius: number) {
          const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(radius); });
        }`);
      const fixture = join(dir, 'context.json');
      const setupBody = 'module.make(3); module.make(7);';
      await writeFile(fixture, JSON.stringify({ module: './shader.ts', setupBody,
        targets: { 'make.helper': { label: 'test radii' } },
      }));
      let out = '';
      let err = '';
      let fail = false;
      let requestedUsage: number | undefined;
      const runtime: RuntimeLike = {
        async inspect(_path, targets, _signal, setup) {
          if (fail) throw new Error('Runtime disconnected');
          expect(setup).toBe(setupBody);
          return { ok: true, targets: targets.flatMap(target => {
            expect(target.selector).toMatchObject({ context: { label: 'test radii' } });
            expect('selector' in target.selector ? target.selector.usage : undefined).toBe(requestedUsage);
            const selected = 'selector' in target.selector ? target.selector.instance : undefined;
            return (selected === undefined ? [0, 1] : [selected]).map(instance => ({
              label: selected === undefined ? `${target.label} [instance ${instance}]` : target.label,
              ...(selected === undefined ? { parentLabel: target.label } : {}),
              context: { instance, label: 'test radii' }, kind: 'resolvable' as const,
              ok: true, outcome: 'passed' as const, wgsl: `fn helper() -> f32 { return ${instance + 3}f; }`,
            }));
          }) };
        },
        async evaluate() { return { ok: true }; },
        async close() {},
      };
      const io: CliIo = { cwd: dir, env: {}, stdinIsTTY: false, stdoutIsTTY: false,
        stdout: text => { out += text; }, stderr: text => { err += text; }, createRuntime: () => runtime,
      };
      const args = [path, '-t', 'make.helper', '--context-file', fixture, '--json'];
      expect(await runCli(['check', ...args], io), err).toBe(0);
      const checked = JSON.parse(out);
      expect(checked.summary.targets).toBe(2);
      expect(checked.files[0].targets.map((t: { context: { instance: number } }) => t.context.instance)).toEqual([0, 1]);
      out = '';
      expect(await runCli(['wgsl', ...args, '--instance', '1'], io), err).toBe(0);
      expect(JSON.parse(out)).toMatchObject([{ context: { instance: 1 }, wgsl: expect.stringContaining('return 4f;') }]);
      out = '';
      requestedUsage = 2;
      expect(await runCli(['check', ...args, '--usage', '2'], io), err).toBe(0);
      out = '';
      requestedUsage = undefined;
      fail = true;
      expect(await runCli(['check', ...args], io)).toBe(1);
      expect(JSON.parse(out).summary.targets).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
