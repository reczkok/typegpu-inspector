import { describe, expect, it } from 'vitest';
import { parseCliArgs, type ParsedCliArgs } from '../src/cliArgs.js';

type Captured = { result: ParsedCliArgs; stdout: string; stderr: string };

async function parse(argv: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const result = await parseCliArgs(
    argv,
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    '9.9.9',
  );
  return { result, stdout, stderr };
}

describe('CLI arguments', () => {
  it('parses check with its options and runtime overrides', async () => {
    const { result } = await parse([
      'check',
      'src',
      'shaders/*.ts',
      '--format',
      'github',
      '--severity',
      'warning',
      '--warnings-as-errors',
      '--verbose',
      '--timeout-ms',
      '90000',
      '--feature',
      'timestamp-query',
      '--feature=shader-f16',
      '--no-strict-names',
      '--project-root',
      '../app',
      '-q',
    ]);
    expect(result).toEqual({
      ok: true,
      command: {
        command: 'check',
        paths: ['src', 'shaders/*.ts'],
        format: 'github',
        minSeverity: 'warning',
        warningsAsErrors: true,
        watch: false,
        verbose: true,
        quiet: true,
        color: undefined,
        runtime: {
          projectRoot: '../app',
          timeoutMs: 90000,
          features: ['timestamp-query', 'shader-f16'],
          strictNames: false,
          sourceMapping: true,
        },
      },
    });
  });

  it('defaults check to the current directory, text output, and every severity', async () => {
    const { result } = await parse(['check']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.command).toMatchObject({
      command: 'check',
      paths: ['.'],
      format: 'text',
      minSeverity: 'hint',
      warningsAsErrors: false,
      watch: false,
      verbose: false,
      quiet: false,
      runtime: { features: [], strictNames: true, sourceMapping: true },
    });
  });

  it('treats --json as --format json and --no-color as an explicit choice', async () => {
    const { result } = await parse(['check', '--json', '--no-color']);
    expect(result).toMatchObject({ ok: true, command: { format: 'json', color: false } });
  });

  it('rejects --watch with JSON output', async () => {
    const { result, stderr } = await parse(['check', '--watch', '--json']);
    expect(result).toEqual({ ok: false, exitCode: 2 });
    expect(stderr).toContain('--watch prints text');
  });

  it('rejects a format outside the choices with exit code 2', async () => {
    const { result, stderr } = await parse(['check', '--format', 'yaml']);
    expect(result).toEqual({ ok: false, exitCode: 2 });
    expect(stderr).toContain('Allowed choices are text, json, github');
  });

  it('rejects a non-integer timeout', async () => {
    const { result, stderr } = await parse(['check', '--timeout-ms', 'soon']);
    expect(result).toEqual({ ok: false, exitCode: 2 });
    expect(stderr).toContain('positive integer');
  });

  it('collects repeated targets for wgsl and report', async () => {
    const wgsl = await parse(['wgsl', 'a.ts', 'b.ts', '-t', 'main', '--target', 'blur', '--json']);
    expect(wgsl.result).toMatchObject({
      ok: true,
      command: { command: 'wgsl', paths: ['a.ts', 'b.ts'], targets: ['main', 'blur'], json: true },
    });
    const report = await parse(['report', 'a.ts']);
    expect(report.result).toMatchObject({
      ok: true,
      command: { command: 'report', paths: ['a.ts'], targets: [], json: false },
    });
  });

  it('requires a file for wgsl', async () => {
    const { result, stderr } = await parse(['wgsl']);
    expect(result).toEqual({ ok: false, exitCode: 2 });
    expect(stderr).toContain("missing required argument 'files'");
  });

  it('parses targets without runtime options', async () => {
    const { result } = await parse(['targets', 'src', '--json']);
    expect(result).toEqual({
      ok: true,
      command: { command: 'targets', paths: ['src'], json: true, quiet: false, color: undefined },
    });
    const rejected = await parse(['targets', '--timeout-ms', '5']);
    expect(rejected.result).toEqual({ ok: false, exitCode: 2 });
  });

  it('prints help and version on stdout with exit code 0', async () => {
    const help = await parse(['help', 'check']);
    expect(help.result).toEqual({ ok: false, exitCode: 0 });
    expect(help.stdout).toContain('Usage: typegpu-inspector check');
    expect(help.stdout).toContain('--warnings-as-errors');

    const version = await parse(['--version']);
    expect(version.result).toEqual({ ok: false, exitCode: 0 });
    expect(version.stdout.trim()).toBe('9.9.9');
  });

  it('suggests the nearest command for a typo', async () => {
    const { result, stderr } = await parse(['chekc']);
    expect(result).toEqual({ ok: false, exitCode: 2 });
    expect(stderr).toContain('Did you mean check?');
  });
});
