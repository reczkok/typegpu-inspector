import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo, type RuntimeLike } from '../src/cli.js';
import type { InspectionTarget } from '../src/discovery.js';
import type { InspectorOutput, InspectorTargetReport } from '../src/protocol.js';

const serverRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtures = join(serverRoot, 'test', 'fixtures');
const brokenFixture = join(fixtures, 'wgsl-compilation-error.ts');

const BROKEN_WGSL = `fn badWgsl() -> f32 {
  return definitely_missing_symbol;
}`;

type Reporter = (target: InspectionTarget) => InspectorTargetReport;

function failingReport(target: InspectionTarget): InspectorTargetReport {
  return {
    label: target.label,
    kind: 'resolvable',
    ok: false,
    wgsl: BROKEN_WGSL,
    compilationMessages: [{
      type: 'error',
      message: 'unresolved value definitely_missing_symbol',
      lineNum: 2,
      linePos: 10,
      offset: BROKEN_WGSL.indexOf('definitely_missing_symbol'),
      length: 'definitely_missing_symbol'.length,
    }],
    error: { message: 'Shader compilation failed.' },
  };
}

function passingReport(target: InspectionTarget): InspectorTargetReport {
  return {
    label: target.label,
    kind: 'resolvable',
    ok: true,
    wgsl: 'fn badWgsl() -> f32 {\n  return 1f;\n}',
    compilationMessages: [],
  };
}

type Harness = {
  io: CliIo;
  stdout(): string;
  stderr(): string;
  calls: Array<{ modulePath: string; labels: string[] }>;
  closed(): boolean;
};

function harness(report: Reporter, overrides: Partial<CliIo> = {}): Harness {
  let out = '';
  let err = '';
  let closed = false;
  const calls: Harness['calls'] = [];
  const runtime: RuntimeLike = {
    inspect: async (modulePath, targets) => {
      calls.push({ modulePath, labels: targets.map((target) => target.label) });
      const reports = targets.map(report);
      const output: InspectorOutput = {
        ok: reports.every((entry) => entry.ok),
        targets: reports,
        summary: {
          targetCount: reports.length,
          passedTargetCount: reports.filter((entry) => entry.ok).length,
          failedTargetCount: reports.filter((entry) => !entry.ok).length,
        },
      };
      return output;
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    io: {
      cwd: serverRoot,
      env: {},
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      stdoutIsTTY: false,
      createRuntime: () => runtime,
      ...overrides,
    },
    stdout: () => out,
    stderr: () => err,
    calls,
    closed: () => closed,
  };
}

describe('CLI', () => {
  it('lists targets from source without a runtime', async () => {
    const h = harness(failingReport, {
      createRuntime: () => {
        throw new Error('targets must not start the runtime');
      },
    });
    const code = await runCli(['targets', 'test/fixtures'], h.io);
    expect(code).toBe(0);
    expect(h.stdout()).toContain('test/fixtures/wgsl-compilation-error.ts:4: badWgsl  resolvable');
    expect(h.stdout()).toMatch(/1 target in 1 module; \d+ other source files? without any/);

    const json = harness(failingReport);
    await runCli(['targets', 'test/fixtures/wgsl-compilation-error.ts', '--json'], json.io);
    expect(JSON.parse(json.stdout())).toMatchObject({
      files: 1,
      targets: [{ path: 'test/fixtures/wgsl-compilation-error.ts', line: 4, label: 'badWgsl', kind: 'resolvable' }],
    });
  });

  it('reports compiler errors on the authored statement and exits 1', async () => {
    const h = harness(failingReport);
    const code = await runCli(['check', 'test/fixtures/wgsl-compilation-error.ts'], h.io);
    expect(code).toBe(1);
    expect(h.calls).toEqual([{ modulePath: brokenFixture, labels: ['badWgsl'] }]);
    const text = h.stdout();
    expect(text).toMatch(
      /^test\/fixtures\/wgsl-compilation-error\.ts:5:\d+: error: badWgsl: unresolved value definitely_missing_symbol \[wgsl-compilation\]$/m,
    );
    expect(text).toMatch(/^    wgsl: .*wgsl-compilation-error__badWgsl\.wgsl:2:10 \(in fn badWgsl\)$/m);
    expect(text).toMatch(/✖ .*1 target \(0 ok, 1 failed\) in 1 file/);
    expect(h.closed()).toBe(true);
  });

  it('exits 0 with a one-line summary when everything passes', async () => {
    const h = harness(passingReport);
    const code = await runCli(['check', 'test/fixtures/wgsl-compilation-error.ts', '--verbose'], h.io);
    expect(code).toBe(0);
    expect(h.stdout()).toContain('test/fixtures/wgsl-compilation-error.ts: badWgsl ok (resolvable, 3 lines)');
    expect(h.stdout()).toMatch(/✔ 1 target ok in 1 file · \d+ms\n$/);
  });

  it('prints JSON with targets, diagnostics, and a summary', async () => {
    const h = harness(failingReport);
    const code = await runCli(['check', 'test/fixtures/wgsl-compilation-error.ts', '--json'], h.io);
    expect(code).toBe(1);
    const parsed = JSON.parse(h.stdout());
    expect(parsed.ok).toBe(false);
    expect(parsed.files[0].targets).toEqual([
      expect.objectContaining({ label: 'badWgsl', kind: 'resolvable', status: 'failed', wgslLines: 3 }),
    ]);
    expect(parsed.files[0].diagnostics.some((d: { severity: string }) => d.severity === 'error')).toBe(true);
    expect(parsed.summary).toMatchObject({ files: 1, targets: 1, failed: 1 });
  });

  it('hides diagnostics below the requested severity but still fails on failed targets', async () => {
    const h = harness(failingReport);
    const code = await runCli(
      ['check', 'test/fixtures/wgsl-compilation-error.ts', '--severity', 'error', '--quiet'],
      h.io,
    );
    expect(code).toBe(1);
    expect(h.stdout()).not.toContain('hint:');
    expect(h.stderr()).toBe('');
  });

  it('turns a runtime failure into a diagnostic instead of a crash', async () => {
    const h = harness(failingReport, {
      createRuntime: () => ({
        inspect: async () => {
          throw new Error('Runtime inspector connection failed after one automatic retry.');
        },
        close: async () => undefined,
      }),
    });
    const code = await runCli(['check', 'test/fixtures/wgsl-compilation-error.ts'], h.io);
    expect(code).toBe(1);
    expect(h.stdout()).toMatch(
      /wgsl-compilation-error\.ts:4:\d+: error: Runtime inspector connection failed after one automatic retry\. \[runtime-inspection\]/,
    );
  });

  it('explains missing paths and exits 2', async () => {
    const h = harness(failingReport);
    expect(await runCli(['check', 'no/such/dir'], h.io)).toBe(2);
    expect(h.stderr()).toContain('No such file or directory: no/such/dir');
    expect(h.calls).toHaveLength(0);
  });

  it('passes a directory without targets', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'typegpu-cli-'));
    await writeFile(join(empty, 'plain.ts'), 'export const answer = 42;\n');
    const h = harness(failingReport, { cwd: empty });
    expect(await runCli(['check'], h.io)).toBe(0);
    expect(h.stderr()).toContain('No TypeGPU targets in 1 source file');
    expect(h.stdout()).toContain('✔ no targets in 0 files');
  });

  it('prints generated WGSL for a selected target and reports unknown names', async () => {
    const h = harness(passingReport);
    const code = await runCli(['wgsl', 'test/fixtures/wgsl-compilation-error.ts', '-t', 'badWgsl'], h.io);
    expect(code).toBe(0);
    expect(h.stdout()).toBe(
      '// test/fixtures/wgsl-compilation-error.ts: badWgsl (resolvable)\nfn badWgsl() -> f32 {\n  return 1f;\n}\n',
    );

    const missing = harness(passingReport);
    expect(await runCli(['wgsl', 'test/fixtures/wgsl-compilation-error.ts', '-t', 'nope'], missing.io)).toBe(2);
    expect(missing.stderr()).toContain('No target named "nope"');
  });

  it('appends compiler messages to the WGSL and exits 1 for a failed target', async () => {
    const h = harness(failingReport);
    const code = await runCli(['wgsl', 'test/fixtures/wgsl-compilation-error.ts', '--json'], h.io);
    expect(code).toBe(0);
    const [entry] = JSON.parse(h.stdout());
    expect(entry).toMatchObject({
      label: 'badWgsl',
      ok: true,
      wgsl: BROKEN_WGSL,
      messages: [{ type: 'error', line: 2, column: 10 }],
    });
  });

  it('prints the Markdown report for a target', async () => {
    const h = harness(passingReport);
    const code = await runCli(['report', 'test/fixtures/wgsl-compilation-error.ts'], h.io);
    expect(code).toBe(0);
    expect(h.stdout()).toContain('## test/fixtures/wgsl-compilation-error.ts: badWgsl');
    expect(h.stdout()).toContain('```wgsl');
  });
});
