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

export type CliPoint = { path: string; line: number; column: number };

/** A call site in another module that reaches the same finding. */
export type CliAlsoIn = CliPoint & { label: string };

export type CliDiagnostic = CliLocation & {
  severity: CliSeverity;
  code?: string;
  message: string;
  related: CliRelated[];
  /** Where the compiler message sits in the generated WGSL, when known. */
  generatedWgsl?: CliLocation;
  /** The authored statement the finding is about, when it is known and in another file. */
  finding?: CliPoint;
  /** Modules whose own report of this finding folded into this one. */
  alsoIn?: CliAlsoIn[];
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

/** One console call the module made while it ran; repeats fold into `count`. */
export type CliConsoleMessage = {
  type: string;
  text: string;
  count?: number;
};

export type CliFileResult = {
  path: string;
  targets: CliTargetStatus[];
  diagnostics: CliDiagnostic[];
  console?: CliConsoleMessage[];
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
    const relatedSource = isRecord(data.relatedSource) &&
        typeof data.relatedSource.uri === 'string' && isRange(data.relatedSource.range)
      ? location(data.relatedSource.uri, data.relatedSource.range, cwd)
      : undefined;
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
      ...(relatedSource
        ? { finding: { path: relatedSource.path, line: relatedSource.line, column: relatedSource.column } }
        : {}),
    };
  }).sort(compareDiagnostics);
}

/**
 * One finding, one report across files. A helper inlined by several modules
 * fails in each of them and in its own file; the report on the statement
 * itself stays (else the first), and the other modules' call sites are
 * listed on it. Only compiler findings whose statement is known fold.
 */
export function foldAcrossFiles(files: readonly CliFileResult[]): CliFileResult[] {
  type Entry = { file: number; diagnostic: CliDiagnostic };
  const groups = new Map<string, Entry[]>();
  files.forEach((file, index) => {
    for (const diagnostic of file.diagnostics) {
      const key = findingKey(diagnostic, file.path);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), { file: index, diagnostic }]);
    }
  });
  const dropped = new Set<CliDiagnostic>();
  const folded = new Map<CliDiagnostic, CliAlsoIn[]>();
  for (const group of groups.values()) {
    if (new Set(group.map((entry) => entry.file)).size < 2) continue;
    const root = group.find(({ diagnostic, file }) => onFinding(diagnostic, files[file]!.path)) ?? group[0]!;
    const alsoIn: CliAlsoIn[] = [];
    for (const entry of group) {
      if (entry === root || entry.file === root.file) continue;
      dropped.add(entry.diagnostic);
      alsoIn.push({
        path: entry.diagnostic.path,
        line: entry.diagnostic.line,
        column: entry.diagnostic.column,
        label: targetLabel(entry.diagnostic.message),
      });
    }
    folded.set(root.diagnostic, alsoIn);
  }
  if (dropped.size === 0) return [...files];
  return files.map((file) => ({
    ...file,
    diagnostics: file.diagnostics
      .filter((diagnostic) => !dropped.has(diagnostic))
      .map((diagnostic) => {
        const alsoIn = folded.get(diagnostic);
        return alsoIn ? { ...diagnostic, alsoIn: [...(diagnostic.alsoIn ?? []), ...alsoIn] } : diagnostic;
      }),
  }));
}

/**
 * A module that could not run fails every target with the same account, so
 * one report says it, on the first target. Only a failure shared by every
 * target in the run folds; one that some targets share still describes those
 * targets.
 */
export function foldModuleFailures(
  diagnostics: readonly CliDiagnostic[],
  targetCount: number,
): CliDiagnostic[] {
  if (targetCount < 2) return [...diagnostics];
  const groups = new Map<string, CliDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== 'target-resolution' && diagnostic.code !== 'runtime-inspection') continue;
    const key = `${diagnostic.code}|${moduleFailureText(diagnostic)}`;
    groups.set(key, [...(groups.get(key) ?? []), diagnostic]);
  }
  const dropped = new Set<CliDiagnostic>();
  const kept = new Map<CliDiagnostic, string>();
  for (const group of groups.values()) {
    if (group.length !== targetCount) continue;
    const [first, ...rest] = group;
    kept.set(first!, moduleFailureText(first!));
    for (const diagnostic of rest) dropped.add(diagnostic);
  }
  if (kept.size === 0) return [...diagnostics];
  return diagnostics
    .filter((diagnostic) => !dropped.has(diagnostic))
    .map((diagnostic) => {
      const message = kept.get(diagnostic);
      return message === undefined ? diagnostic : { ...diagnostic, message };
    });
}

/** A resolution failure names its target first; the account after it is what folds. */
function moduleFailureText(diagnostic: CliDiagnostic): string {
  if (diagnostic.code !== 'target-resolution') return diagnostic.message;
  const index = diagnostic.message.indexOf(': ');
  return index > 0 ? diagnostic.message.slice(index + 2) : diagnostic.message;
}

function findingKey(diagnostic: CliDiagnostic, filePath: string): string | undefined {
  if (diagnostic.code !== 'wgsl-compilation') return undefined;
  const finding = diagnostic.finding ?? { path: filePath, line: diagnostic.line, column: diagnostic.column };
  return `${diagnostic.severity}|${finding.path}:${finding.line}:${finding.column}|${compilerMessage(diagnostic.message)}`;
}

function onFinding(diagnostic: CliDiagnostic, filePath: string): boolean {
  const finding = diagnostic.finding;
  if (!finding) return true;
  return finding.path === filePath && finding.line === diagnostic.line && finding.column === diagnostic.column;
}

/** The label a compiler diagnostic's message starts with: `shade: …` → `shade`. */
export function targetLabel(message: string): string {
  const index = message.indexOf(': ');
  return index > 0 ? message.slice(0, index) : message;
}

/** The compiler's own words: no target label, no mapping note, no cross-file suffix. */
function compilerMessage(message: string): string {
  const [head = ''] = message.split('\n');
  const body = head.indexOf(': ') > 0 ? head.slice(head.indexOf(': ') + 2) : head;
  return body
    .replace(/ — in .*$/, '')
    .replace(/ \((approximate source location|generated WGSL line \d+)\)$/, '');
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
  fileResults: readonly CliFileResult[],
  elapsedMs: number,
  warningsAsErrors: boolean,
): CheckResult {
  const files = foldAcrossFiles(fileResults);
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
  /** Print the modules' console output. */
  console?: boolean;
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
  for (const line of tail) lines.push(indent(line, 4));
  const generated = diagnostic.generatedWgsl;
  // A note that only names the generated location folds into the wgsl line.
  const generatedNotes: string[] = [];
  for (const related of diagnostic.related) {
    if (generated && sameLocation(related, generated)) {
      generatedNotes.push(related.message);
      continue;
    }
    const [first = '', ...more] = related.message.split('\n');
    lines.push(`    ${related.path}:${related.line}:${related.column}: ${c.dim('note')}: ${first}`);
    for (const line of more) lines.push(indent(line, 8));
  }
  if (generated) {
    const note = generatedNotes.length > 0 ? c.dim(` (${generatedNotes.join('; ')})`) : '';
    lines.push(`    ${c.dim('wgsl')}: ${generated.path}:${generated.line}:${generated.column}${note}`);
  }
  if (diagnostic.alsoIn && diagnostic.alsoIn.length > 0) {
    lines.push(`    ${c.dim('also in')}: ${diagnostic.alsoIn.map(describeAlsoIn).join(', ')}`);
  }
  return lines;
}

function formatConsoleLines(path: string, message: CliConsoleMessage, c: Colors): string[] {
  const [head = '', ...tail] = message.text.split('\n');
  const times = message.count !== undefined && message.count > 1 ? c.dim(` (×${message.count})`) : '';
  return [
    `${c.bold(path)}: ${c.dim(`console.${message.type}`)}: ${head}${times}`,
    ...tail.map((line) => indent(line, 4)),
  ];
}

function describeAlsoIn(entry: CliAlsoIn): string {
  return `${entry.label} (${entry.path}:${entry.line}:${entry.column})`;
}

export function formatCheckText(result: CheckResult, style: TextStyle): string {
  const c = colors(style.color);
  const lines: string[] = [];
  for (const file of result.files) {
    for (const diagnostic of file.diagnostics) {
      lines.push(...formatDiagnosticLines(diagnostic, style));
    }
  }
  if (style.console) {
    const output = result.files.flatMap((file) =>
      (file.console ?? []).flatMap((message) => formatConsoleLines(file.path, message, c))
    );
    if (output.length > 0 && lines.length > 0) lines.push('');
    lines.push(...output);
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

export function formatSummaryLine(
  result: CheckResult,
  style: TextStyle,
  options: { mark?: boolean } = {},
): string {
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
  const mark = options.mark === false ? '' : result.ok ? `${c.green('✔')} ` : `${c.red('✖')} `;
  const parts = [
    ...(counts.length > 0 ? [counts.join(', ')] : []),
    `${targets} in ${plural(summary.files, 'file')}`,
    formatDuration(summary.elapsedMs),
  ];
  return `${mark}${parts.join(' · ')}`;
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
        ...(diagnostic.alsoIn && diagnostic.alsoIn.length > 0
          ? [`also in: ${diagnostic.alsoIn.map(describeAlsoIn).join(', ')}`]
          : []),
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

function indent(line: string, columns: number): string {
  return line.trim() === '' ? '' : `${' '.repeat(columns)}${line}`;
}

function sameLocation(a: CliLocation, b: CliLocation): boolean {
  return a.path === b.path && a.line === b.line && a.column === b.column;
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
