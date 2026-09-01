import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import {
  displayPath,
  filterBySeverity,
  formatCheckGithub,
  formatCheckJson,
  formatCheckText,
  formatDiagnosticLines,
  summarizeCheck,
  toCliDiagnostics,
  type CliFileResult,
} from '../src/cliOutput.js';

const cwd = '/workspace';

const compilerError: Diagnostic = {
  range: { start: { line: 97, character: 4 }, end: { line: 97, character: 30 } },
  severity: DiagnosticSeverity.Error,
  source: 'TypeGPU Inspector',
  code: 'wgsl-compilation',
  message: 'unresolved value definitely_missing_symbol — in shade (pbr.ts:98) via evaluateLight',
  relatedInformation: [{
    location: {
      uri: 'file:///workspace/src/pbr.ts',
      range: { start: { line: 97, character: 9 }, end: { line: 97, character: 20 } },
    },
    message: 'the statement that produced the line',
  }],
  data: {
    generatedUri: 'file:///tmp/typegpu-inspector/a/b/main__shade.wgsl',
    generatedRange: { start: { line: 39, character: 8 }, end: { line: 39, character: 30 } },
  },
};

const layoutHint: Diagnostic = {
  range: { start: { line: 3, character: 13 }, end: { line: 3, character: 19 } },
  severity: DiagnosticSeverity.Hint,
  source: 'TypeGPU Inspector',
  code: 'target-not-standalone',
  message: 'helper is only inspectable through its callers',
};

const warning: Diagnostic = {
  range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } },
  severity: DiagnosticSeverity.Warning,
  source: 'TypeGPU Inspector',
  message: 'first line\nsecond line',
};

function fileResult(): CliFileResult {
  return {
    path: 'src/main.ts',
    targets: [
      { id: 't1', label: 'main', kind: 'compute-pipeline', status: 'ok', wgslLines: 12 },
      { id: 't2', label: 'shade', kind: 'resolvable', status: 'failed' },
    ],
    diagnostics: toCliDiagnostics('/workspace/src/main.ts', [layoutHint, compilerError, warning], cwd),
    elapsedMs: 1234,
  };
}

describe('CLI output', () => {
  it('shows paths relative to the working directory and keeps outside paths absolute', () => {
    expect(displayPath('/workspace/src/a.ts', cwd)).toBe('src/a.ts');
    expect(displayPath('file:///workspace/src/a.ts', cwd)).toBe('src/a.ts');
    expect(displayPath('/tmp/generated.wgsl', cwd)).toBe('/tmp/generated.wgsl');
    expect(displayPath('/workspace', cwd)).toBe('.');
  });

  it('converts LSP diagnostics to one-based locations, sorted by position', () => {
    const diagnostics = toCliDiagnostics('/workspace/src/main.ts', [compilerError, layoutHint], cwd);
    expect(diagnostics.map((diagnostic) => diagnostic.line)).toEqual([4, 98]);
    expect(diagnostics[1]).toMatchObject({
      path: 'src/main.ts',
      line: 98,
      column: 5,
      endLine: 98,
      endColumn: 31,
      severity: 'error',
      code: 'wgsl-compilation',
      related: [{ path: 'src/pbr.ts', line: 98, column: 10, message: 'the statement that produced the line' }],
      generatedWgsl: { path: '/tmp/typegpu-inspector/a/b/main__shade.wgsl', line: 40, column: 9 },
    });
  });

  it('filters by minimum severity', () => {
    const diagnostics = toCliDiagnostics('/workspace/src/main.ts', [layoutHint, compilerError, warning], cwd);
    expect(filterBySeverity(diagnostics, 'error').map((d) => d.severity)).toEqual(['error']);
    expect(filterBySeverity(diagnostics, 'warning').map((d) => d.severity)).toEqual(['warning', 'error']);
    expect(filterBySeverity(diagnostics, 'hint')).toHaveLength(3);
  });

  it('summarizes targets and diagnostics and decides success', () => {
    const result = summarizeCheck([fileResult()], 1234, false);
    expect(result.summary).toEqual({
      files: 1,
      targets: 2,
      passed: 1,
      failed: 1,
      errors: 1,
      warnings: 1,
      infos: 0,
      hints: 1,
      elapsedMs: 1234,
    });
    expect(result.ok).toBe(false);

    const clean = summarizeCheck([{ ...fileResult(), targets: [], diagnostics: [] }], 5, false);
    expect(clean.ok).toBe(true);

    const warned: CliFileResult = {
      ...fileResult(),
      targets: [{ id: 't', label: 'x', status: 'ok' }],
      diagnostics: toCliDiagnostics('/workspace/src/main.ts', [warning], cwd),
    };
    expect(summarizeCheck([warned], 5, false).ok).toBe(true);
    expect(summarizeCheck([warned], 5, true).ok).toBe(false);
  });

  it('renders compiler-style text with notes, generated locations, and a summary', () => {
    const text = formatCheckText(summarizeCheck([fileResult()], 1234, false), { color: false, verbose: true });
    expect(text).toBe(
      [
        'src/main.ts:4:14: hint: helper is only inspectable through its callers [target-not-standalone]',
        'src/main.ts:11:1: warning: first line',
        '    second line',
        'src/main.ts:98:5: error: unresolved value definitely_missing_symbol — in shade (pbr.ts:98) via evaluateLight [wgsl-compilation]',
        '    src/pbr.ts:98:10: note: the statement that produced the line',
        '    wgsl: /tmp/typegpu-inspector/a/b/main__shade.wgsl:40:9',
        '',
        'src/main.ts: main ok (compute-pipeline, 12 lines)',
        'src/main.ts: shade failed (resolvable)',
        '',
        '✖ 1 error, 1 warning, 1 hint · 2 targets (1 ok, 1 failed) in 1 file · 1.2s',
      ].join('\n') + '\n',
    );
  });

  it('folds a note at the generated location into the wgsl line and drops blank message lines', () => {
    const [diagnostic] = toCliDiagnostics('/workspace/src/main.ts', [{
      ...compilerError,
      message: "no matching call to 'dot(vec3<f32>, vec2<f32>)'\n\n1 candidate function:\n • 'dot(vecN<T>, vecN<T>) -> T'",
      relatedInformation: [{
        location: {
          uri: 'file:///tmp/typegpu-inspector/a/b/main__shade.wgsl',
          range: { start: { line: 39, character: 8 }, end: { line: 39, character: 30 } },
        },
        message: 'in fn projectPointOnLine',
      }],
    }], cwd);
    expect(formatDiagnosticLines(diagnostic!, { color: false, verbose: false })).toEqual([
      "src/main.ts:98:5: error: no matching call to 'dot(vec3<f32>, vec2<f32>)' [wgsl-compilation]",
      '',
      '    1 candidate function:',
      "     • 'dot(vecN<T>, vecN<T>) -> T'",
      '    wgsl: /tmp/typegpu-inspector/a/b/main__shade.wgsl:40:9 (in fn projectPointOnLine)',
    ]);
  });

  it('reports a helper finding once across files and lists the other call sites', () => {
    const tint = "no matching call to 'dot(vec3<f32>, vec2<f32>)'";
    const helperStatement = {
      uri: 'file:///workspace/src/helpers.ts',
      range: { start: { line: 6, character: 25 }, end: { line: 6, character: 40 } },
    };
    const inHelper: Diagnostic = {
      range: helperStatement.range,
      severity: DiagnosticSeverity.Error,
      code: 'wgsl-compilation',
      message: `projectPointOnLine: ${tint}`,
      data: { sourceUri: helperStatement.uri, targetId: 'helper' },
    };
    const viaCaller = (label: string, line: number): Diagnostic => ({
      range: { start: { line, character: 15 }, end: { line, character: 33 } },
      severity: DiagnosticSeverity.Error,
      code: 'wgsl-compilation',
      message: `${label}: ${tint} — in projectPointOnLine (helpers.ts:7)`,
      relatedInformation: [{ location: helperStatement, message: 'in projectPointOnLine' }],
      data: {
        sourceUri: `file:///workspace/src/${label}.ts`,
        targetId: label,
        relatedSource: { ...helperStatement, sourceSymbol: 'projectPointOnLine' },
      },
    });
    const files: CliFileResult[] = [
      {
        path: 'src/compute.ts',
        targets: [{ id: 'simulate', label: 'simulate', status: 'failed' }],
        diagnostics: toCliDiagnostics('/workspace/src/compute.ts', [viaCaller('simulate', 60)], cwd),
        elapsedMs: 1,
      },
      {
        path: 'src/helpers.ts',
        targets: [{ id: 'helper', label: 'projectPointOnLine', status: 'failed' }],
        diagnostics: toCliDiagnostics('/workspace/src/helpers.ts', [inHelper], cwd),
        elapsedMs: 1,
      },
      {
        path: 'src/render.ts',
        targets: [{ id: 'render', label: 'render', status: 'failed' }],
        diagnostics: toCliDiagnostics('/workspace/src/render.ts', [viaCaller('render', 20)], cwd),
        elapsedMs: 1,
      },
    ];
    const result = summarizeCheck(files, 3, false);
    expect(result.summary).toMatchObject({ errors: 1, failed: 3, targets: 3 });
    expect(result.files.map((file) => file.diagnostics.length)).toEqual([0, 1, 0]);
    const [kept] = result.files[1]!.diagnostics;
    expect(kept?.alsoIn).toEqual([
      { path: 'src/compute.ts', line: 61, column: 16, label: 'simulate' },
      { path: 'src/render.ts', line: 21, column: 16, label: 'render' },
    ]);
    expect(formatCheckText(result, { color: false, verbose: false })).toBe(
      [
        `src/helpers.ts:7:26: error: projectPointOnLine: ${tint} [wgsl-compilation]`,
        '    also in: simulate (src/compute.ts:61:16), render (src/render.ts:21:16)',
        '',
        '✖ 1 error · 3 targets (0 ok, 3 failed) in 3 files · 3ms',
      ].join('\n') + '\n',
    );

    // Without the helper's own file the first caller keeps the report.
    const callersOnly = summarizeCheck([files[0]!, files[2]!], 2, false);
    expect(callersOnly.summary.errors).toBe(1);
    expect(callersOnly.files[0]!.diagnostics[0]?.alsoIn).toEqual([
      { path: 'src/render.ts', line: 21, column: 16, label: 'render' },
    ]);
    expect(callersOnly.files[0]!.diagnostics[0]?.finding).toEqual({ path: 'src/helpers.ts', line: 7, column: 26 });
  });

  it('renders a bare summary for a clean run', () => {
    const result = summarizeCheck(
      [{ path: 'src/ok.ts', targets: [{ id: 't', label: 'main', status: 'ok' }], diagnostics: [], elapsedMs: 80 }],
      80,
      false,
    );
    expect(formatCheckText(result, { color: false, verbose: false })).toBe('✔ 1 target ok in 1 file · 80ms\n');
  });

  it('colors only when asked', () => {
    const result = summarizeCheck([fileResult()], 1, false);
    expect(formatCheckText(result, { color: false, verbose: false })).not.toMatch(/\[/);
    expect(formatCheckText(result, { color: true, verbose: false })).toMatch(/\[31merror\[39m/);
  });

  it('emits GitHub workflow commands with escaped properties before the text', () => {
    const github = formatCheckGithub(summarizeCheck([fileResult()], 1, false), { color: true, verbose: false });
    const lines = github.split('\n');
    expect(lines[0]).toBe(
      '::notice file=src/main.ts,line=4,col=14,endLine=4,endColumn=20,title=TypeGPU Inspector (target-not-standalone)::helper is only inspectable through its callers',
    );
    expect(lines[1]).toBe(
      '::warning file=src/main.ts,line=11,col=1,endLine=11,endColumn=6,title=TypeGPU Inspector::first line%0Asecond line',
    );
    expect(lines[2]).toContain('::error file=src/main.ts,line=98,col=5,');
    expect(lines[2]).toContain('%0Asrc/pbr.ts:98:10: the statement that produced the line');
    expect(lines[2]).toContain('via evaluateLight');
    expect(github).not.toMatch(/\[/);
    expect(github.endsWith('in 1 file · 1ms\n')).toBe(true);
  });

  it('serializes the whole result as JSON', () => {
    const result = summarizeCheck([fileResult()], 1, false);
    const parsed = JSON.parse(formatCheckJson(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.files[0].diagnostics[2].generatedWgsl.line).toBe(40);
    expect(parsed.summary.errors).toBe(1);
  });
});
