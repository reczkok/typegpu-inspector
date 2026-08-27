import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createColors } from 'picocolors';
import { DiagnosticSeverity, type Diagnostic, type Range } from 'vscode-languageserver/node';
import type { CliSeverity } from './cliArgs.js';
import { SEVERITIES } from './cliArgs.js';

export type CliLocation = {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

export type CliRelated = CliLocation & { message: string };

export type CliDiagnostic = CliLocation & {
  severity: CliSeverity;
  code?: string;
  message: string;
  related: CliRelated[];
  /** Where the compiler message sits in the generated WGSL, when known. */
  generatedWgsl?: CliLocation;
};

export type CliTargetStatus = {
  id: string;
  label: string;
  kind?: string;
  status: 'ok' | 'failed' | 'not-inspected';
  wgslLines?: number;
  /** Path of the generated `.wgsl` file, when the target produced WGSL. */
  generatedWgsl?: string;
};

export type CliFileResult = {
  path: string;
  targets: CliTargetStatus[];
  diagnostics: CliDiagnostic[];
  elapsedMs: number;
};

export type CliSummary = {
  files: number;
  targets: number;
  passed: number;
  failed: number;
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  elapsedMs: number;
};

export type CheckResult = {
  ok: boolean;
  files: CliFileResult[];
  summary: CliSummary;
};

export function severityRank(severity: CliSeverity): number {
  return SEVERITIES.indexOf(severity);
}

export function lspSeverityName(severity: DiagnosticSeverity | undefined): CliSeverity {
  switch (severity) {
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
      return 'info';
    case DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'error';
  }
}

/** Paths inside `cwd` print relative to it; anything else keeps its absolute form. */
export function displayPath(target: string, cwd: string): string {
  const path = target.startsWith('file:') ? safeFileUrlToPath(target) : target;
  const rel = relative(cwd, path);
  if (rel === '') return '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel;
}

function safeFileUrlToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

function location(path: string, range: Range, cwd: string): CliLocation {
  return {
    path: displayPath(path, cwd),
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export function toCliDiagnostics(
  sourcePath: string,
  diagnostics: readonly Diagnostic[],
  cwd: string,
): CliDiagnostic[] {
  return diagnostics.map((diagnostic): CliDiagnostic => {
    const data = isRecord(diagnostic.data) ? diagnostic.data : {};
    const generatedUri = typeof data.generatedUri === 'string' ? data.generatedUri : undefined;
    const generatedRange = isRange(data.generatedRange) ? data.generatedRange : undefined;
    return {
      ...location(sourcePath, diagnostic.range, cwd),
      severity: lspSeverityName(diagnostic.severity),
      ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
      message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
      related: (diagnostic.relatedInformation ?? []).map((info) => ({
        ...location(info.location.uri, info.location.range, cwd),
        message: info.message,
      })),
      ...(generatedUri && generatedRange
        ? { generatedWgsl: location(generatedUri, generatedRange, cwd) }
        : {}),
    };
  }).sort(compareDiagnostics);
}

function compareDiagnostics(a: CliDiagnostic, b: CliDiagnostic): number {
  return a.line - b.line || a.column - b.column || severityRank(a.severity) - severityRank(b.severity);
}

export function filterBySeverity(
  diagnostics: readonly CliDiagnostic[],
  minSeverity: CliSeverity,
): CliDiagnostic[] {
  const max = severityRank(minSeverity);
  return diagnostics.filter((diagnostic) => severityRank(diagnostic.severity) <= max);
}

export function summarizeCheck(
  files: readonly CliFileResult[],
  elapsedMs: number,
  warningsAsErrors: boolean,
): CheckResult {
  const summary: CliSummary = {
    files: files.length,
    targets: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    warnings: 0,
    infos: 0,
    hints: 0,
    elapsedMs,
  };
  for (const file of files) {
    for (const target of file.targets) {
      summary.targets += 1;
      if (target.status === 'ok') summary.passed += 1;
      else summary.failed += 1;
    }
    for (const diagnostic of file.diagnostics) {
      if (diagnostic.severity === 'error') summary.errors += 1;
      else if (diagnostic.severity === 'warning') summary.warnings += 1;
      else if (diagnostic.severity === 'info') summary.infos += 1;
      else summary.hints += 1;
    }
  }
  const ok = summary.errors === 0 && summary.failed === 0 &&
    (!warningsAsErrors || summary.warnings === 0);
  return { ok, files: [...files], summary };
}

export type TextStyle = {
  color: boolean;
  verbose: boolean;
};

export type Colors = ReturnType<typeof createColors>;

export function colors(enabled: boolean): Colors {
  return createColors(enabled);
}

function severityText(c: Colors, severity: CliSeverity): string {
  switch (severity) {
    case 'error':
      return c.red(severity);
    case 'warning':
      return c.yellow(severity);
    case 'info':
      return c.blue(severity);
    case 'hint':
      return c.cyan(severity);
  }
}

export function formatDiagnosticLines(diagnostic: CliDiagnostic, style: TextStyle): string[] {
  const c = colors(style.color);
  const lines: string[] = [];
  const where = c.bold(`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}`);
  const [head = '', ...tail] = diagnostic.message.split('\n');
  const code = diagnostic.code ? c.dim(` [${diagnostic.code}]`) : '';
  lines.push(`${where}: ${severityText(c, diagnostic.severity)}: ${head}${code}`);
  for (const line of tail) lines.push(`    ${line}`);
  for (const related of diagnostic.related) {
    const [first = '', ...more] = related.message.split('\n');
    lines.push(`    ${related.path}:${related.line}:${related.column}: ${c.dim('note')}: ${first}`);
    for (const line of more) lines.push(`        ${line}`);
  }
  if (diagnostic.generatedWgsl) {
    const generated = diagnostic.generatedWgsl;
    lines.push(`    ${c.dim('wgsl')}: ${generated.path}:${generated.line}:${generated.column}`);
  }
  return lines;
}

export function formatCheckText(result: CheckResult, style: TextStyle): string {
  const c = colors(style.color);
  const lines: string[] = [];
  for (const file of result.files) {
    for (const diagnostic of file.diagnostics) {
      lines.push(...formatDiagnosticLines(diagnostic, style));
    }
  }
  if (style.verbose) {
    if (lines.length > 0) lines.push('');
    for (const file of result.files) {
      for (const target of file.targets) {
        const status = target.status === 'ok'
          ? c.green('ok')
          : target.status === 'failed'
          ? c.red('failed')
          : c.dim('not inspected');
        const detail = [
          target.kind,
          target.wgslLines !== undefined ? `${target.wgslLines} lines` : undefined,
        ].filter(Boolean).join(', ');
        lines.push(`${file.path}: ${target.label} ${status}${detail ? c.dim(` (${detail})`) : ''}`);
      }
    }
  }
  if (lines.length > 0) lines.push('');
  lines.push(formatSummaryLine(result, style));
  return `${lines.join('\n')}\n`;
}

export function formatSummaryLine(result: CheckResult, style: TextStyle): string {
  const c = colors(style.color);
  const { summary } = result;
  const counts: string[] = [];
  if (summary.errors > 0) counts.push(c.red(plural(summary.errors, 'error')));
  if (summary.warnings > 0) counts.push(c.yellow(plural(summary.warnings, 'warning')));
  if (summary.infos > 0) counts.push(plural(summary.infos, 'info', 'infos'));
  if (summary.hints > 0) counts.push(plural(summary.hints, 'hint'));
  const targets = summary.targets === 0
    ? 'no targets'
    : summary.failed === 0
    ? `${plural(summary.targets, 'target')} ok`
    : `${plural(summary.targets, 'target')} (${summary.passed} ok, ${summary.failed} failed)`;
  const mark = result.ok ? c.green('✔') : c.red('✖');
  const parts = [
    ...(counts.length > 0 ? [counts.join(', ')] : []),
    `${targets} in ${plural(summary.files, 'file')}`,
    formatDuration(summary.elapsedMs),
  ];
  return `${mark} ${parts.join(' · ')}`;
}

/** GitHub Actions workflow commands, then the plain text output for the log. */
export function formatCheckGithub(result: CheckResult, style: TextStyle): string {
  const lines: string[] = [];
  for (const file of result.files) {
    for (const diagnostic of file.diagnostics) {
      const command = diagnostic.severity === 'error'
        ? 'error'
        : diagnostic.severity === 'warning'
        ? 'warning'
        : 'notice';
      const properties = [
        `file=${escapeProperty(diagnostic.path)}`,
        `line=${diagnostic.line}`,
        `col=${diagnostic.column}`,
        `endLine=${diagnostic.endLine}`,
        `endColumn=${diagnostic.endColumn}`,
        `title=${escapeProperty(diagnostic.code ? `TypeGPU Inspector (${diagnostic.code})` : 'TypeGPU Inspector')}`,
      ];
      const message = [
        diagnostic.message,
        ...diagnostic.related.map((related) =>
          `${related.path}:${related.line}:${related.column}: ${related.message}`
        ),
      ].join('\n');
      lines.push(`::${command} ${properties.join(',')}::${escapeData(message)}`);
    }
  }
  return `${lines.length > 0 ? `${lines.join('\n')}\n` : ''}${formatCheckText(result, { ...style, color: false })}`;
}

export function formatCheckJson(result: CheckResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRange(value: unknown): value is Range {
  if (!isRecord(value)) return false;
  return isPosition(value.start) && isPosition(value.end);
}

function isPosition(value: unknown): boolean {
  return isRecord(value) && typeof value.line === 'number' && typeof value.character === 'number';
}
