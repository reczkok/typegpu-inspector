import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo, type RuntimeLike } from '../src/cli.js';
import {
  CANCELLED,
  wrapInteractiveMessage,
  type Cancelled,
  type InteractiveUi,
} from '../src/cliInteractive.js';
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
      stdinIsTTY: false,
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

function scriptedUi(actions: Array<string | Cancelled>): { ui: InteractiveUi; transcript: string[] } {
  const transcript: string[] = [];
  const next = (
    message: string,
    options: readonly { value: string; disabled?: boolean }[],
  ): string | Cancelled => {
    const action = actions.shift();
    if (action === undefined) throw new Error(`No scripted answer for ${message}`);
    if (action === CANCELLED) {
      transcript.push(`${message}: cancelled`);
      return action;
    }
    const option = options.find((candidate) => candidate.value === action);
    if (!option || option.disabled) throw new Error(`Scripted answer ${action} is unavailable for ${message}`);
    transcript.push(`${message}: ${action}`);
    return action;
  };
  return {
    transcript,
    ui: {
      intro: (title) => transcript.push(`intro: ${title}`),
      outro: (message) => transcript.push(`outro: ${message}`),
      cancel: (message) => transcript.push(`cancel: ${message}`),
      select: async (message, options) => next(message, options),
      autocomplete: async (message, options, _placeholder, initialInput) => {
        const option = options.find((candidate) => !candidate.disabled);
        if (!option) throw new Error(`No autocomplete option for ${message}`);
        transcript.push(`${message}${initialInput ? ` [${initialInput}]` : ''}: ${stripVTControlCharacters(option.label)} (${stripVTControlCharacters(option.hint ?? '')})`);
        return option.value;
      },
      spinner: () => ({
        start: (text) => transcript.push(`spinner: ${text}`),
        message: (text) => transcript.push(`spinner: ${text}`),
        stop: (text, ok = true) => transcript.push(`${ok ? 'success' : 'failure'}: ${text}`),
        clear: () => transcript.push('spinner cleared'),
      }),
      message: (text, kind = 'plain') =>
        transcript.push(`${kind}: ${Array.isArray(text) ? text.join('\n') : text}`),
      waitForKey: async () => 'key',
      openInEditor: async (path) => {
        transcript.push(`editor: ${path}`);
      },
    },
  };
}

describe('CLI', () => {
  it('wraps long interactive output inside the Clack guide', () => {
    const message =
      "index.ts:222:5: error: blendSprite: Ternary operator '(uv.x > 0.5) ? sampleSprite(uv) : " +
      "sampleSprite(uv)' is invalid. Use std.select or an if/else statement. [target-resolution]";
    const wrapped = wrapInteractiveMessage(message, 60);
    const lines = wrapped.split('\n');

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 57)).toBe(true);
    expect(lines.join(' ')).toContain('Use std.select or an if/else statement.');

    const colored = wrapInteractiveMessage(`\x1b[31m${message}\x1b[39m`, 60).split('\n');
    expect(colored.every((line) => stripVTControlCharacters(line).length <= 57)).toBe(true);
  });

  it('starts the interactive session on a bare TTY and reuses an inspection', async () => {
    const scripted = scriptedUi(['check', 'target', 'wgsl', 'back', 'quit']);
    const h = harness(passingReport, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      createInteractiveUi: async () => scripted.ui,
    });

    expect(await runCli([], h.io)).toBe(0);
    expect(h.calls).toEqual([{ modulePath: brokenFixture, labels: ['badWgsl'] }]);
    expect(scripted.transcript).toContain('What next?: check');
    expect(scripted.transcript).toContain('What next?: target');
    expect(scripted.transcript.some((line) => line.includes('1 target ok in 1 file'))).toBe(true);
    expect(scripted.transcript.some((line) => line.includes('return 1f;'))).toBe(true);
    expect(scripted.transcript.at(-1)).toBe('outro: Done.');
    expect(h.closed()).toBe(true);
  });

  it('offers a failed-target review after a check finds failures', async () => {
    const scripted = scriptedUi(['check', 'failed', 'report', 'back', 'quit']);
    const h = harness(failingReport, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      createInteractiveUi: async () => scripted.ui,
    });

    expect(await runCli(['interactive', 'test/fixtures'], h.io)).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(scripted.transcript).toContain('What next?: failed');
    expect(scripted.transcript).toContain(
      'Which target? [failed]: badWgsl  test/fixtures/wgsl-compilation-error.ts:4 (resolvable · failed)',
    );
    const failure = scripted.transcript.find((line) => line.startsWith('failure: '));
    expect(stripVTControlCharacters(failure ?? '')).toMatch(/^failure: 1 error · 1 target \(0 ok, 1 failed\) in 1 file · \d+ms$/);
    const report = scripted.transcript.map(stripVTControlCharacters).find((line) => line.startsWith('plain: TypeGPU'));
    expect(report).toBeDefined();
    expect(report).not.toContain('**');
    expect(report).not.toContain('](file://');
  });

  it('rejects an explicit interactive session without a terminal', async () => {
    const h = harness(passingReport);
    expect(await runCli(['interactive'], h.io)).toBe(2);
    expect(h.stderr()).toContain('interactive session needs a terminal');
    expect(h.calls).toHaveLength(0);
  });

  it('treats cancelling an interactive prompt as an interruption', async () => {
    const scripted = scriptedUi([CANCELLED]);
    const h = harness(passingReport, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      createInteractiveUi: async () => scripted.ui,
    });

    expect(await runCli(['interactive', 'test/fixtures/wgsl-compilation-error.ts'], h.io)).toBe(130);
    expect(scripted.transcript.at(-1)).toBe('cancel: Interrupted.');
    expect(h.calls).toHaveLength(0);
    expect(h.closed()).toBe(true);
  });

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

  it('narrows a check to the named targets and reports names that match nothing', async () => {
    const h = harness(failingReport);
    expect(await runCli(['check', 'test/fixtures', '-t', 'badWgsl', '--quiet'], h.io)).toBe(1);
    expect(h.calls).toEqual([{ modulePath: brokenFixture, labels: ['badWgsl'] }]);
    expect(h.stdout()).toMatch(/1 target \(0 ok, 1 failed\) in 1 file/);

    const missing = harness(passingReport);
    expect(await runCli(['check', 'test/fixtures', '--target', 'nope', '--quiet'], missing.io)).toBe(1);
    expect(missing.calls).toHaveLength(0);
    expect(missing.stderr()).toContain('No target named "nope"');
    expect(missing.stdout()).toContain('✔ no targets in 0 files');
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
