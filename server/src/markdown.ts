const SOFT_BREAK = '\u200b';
const DEFAULT_VALUE_LIMIT = 240;

export function section(lines: string[], title: string): void {
  lines.push('', `**${escapeMarkdown(title)}**`, '');
}

export function code(value: unknown): string {
  return `\`${escapeInline(softWrapTechnical(String(value)))}\``;
}

export function valueText(value: unknown): string {
  return escapeMarkdown(softWrapTechnical(formatInspectableValue(value)));
}

export function tableText(value: unknown): string {
  return valueText(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function tableCode(value: unknown): string {
  return code(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** Rendered width of a cell, ignoring markdown syntax and soft-wrap hints. */
export function visibleWidth(value: string): number {
  return value
    .replaceAll(SOFT_BREAK, '')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .replaceAll(/\\([\\`*_[\]<>|])/g, '$1')
    .length;
}

/** Rendered width of a table row: its cells plus the ` | ` between them. */
export function tableRowWidth(cells: readonly string[]): number {
  return cells.reduce((total, cell) => total + visibleWidth(cell), 0) +
    Math.max(0, cells.length - 1) * 3;
}

export function formatInspectableValue(
  value: unknown,
  limit = DEFAULT_VALUE_LIMIT,
): string {
  return truncate(renderInspectableValue(value, 0), limit);
}

export function escapeMarkdown(value: string): string {
  return value.replaceAll(/([\\`*_[\]<>])/g, '\\$1');
}

export function escapeInline(value: string): string {
  return value.replaceAll('`', '\\`');
}

export function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|');
}

export function softWrapTechnical(value: string): string {
  return value
    .replaceAll(/([,;:{}()[\]<>+|/])/g, `$1${SOFT_BREAK}`)
    .replaceAll(/([.])(?=[A-Za-z_$])/g, `$1${SOFT_BREAK}`);
}

function renderInspectableValue(value: unknown, depth: number): string {
  if (value === null || value === undefined) return '—';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (typeof value === 'function') {
    return `[function ${value.name || 'anonymous'}]`;
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return `[${value.length} items]`;
    const shown = value.slice(0, 8).map((entry) =>
      renderInspectableValue(entry, depth + 1));
    if (shown.length < value.length) shown.push(`… ${value.length - shown.length} more`);
    return `[${shown.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= 2) return `{${entries.length} fields}`;
    const shown = entries.slice(0, 8).map(([name, entry]) =>
      `${name}: ${renderInspectableValue(entry, depth + 1)}`);
    if (shown.length < entries.length) shown.push(`… ${entries.length - shown.length} more`);
    return `{ ${shown.join(', ')} }`;
  }
  return String(value);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
