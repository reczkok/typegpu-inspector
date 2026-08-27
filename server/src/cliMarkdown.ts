import { displayPath, type Colors } from './cliOutput.js';

/**
 * The hover Markdown, made readable on a terminal: headings and emphasis in
 * bold, links as `label → path`, code fences as dim rules. Tables and lists
 * already read fine as text.
 */
export function renderMarkdown(markdown: string, c: Colors, cwd: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of markdown.trimEnd().split('\n')) {
    const fence = /^\s*```(\w*)\s*$/.exec(raw);
    if (fence) {
      inFence = !inFence;
      out.push(c.dim(inFence && fence[1] ? `── ${fence[1]} ──` : '──'));
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(c.bold(inline(heading[2] ?? '', c, cwd)));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(raw)) {
      out.push(c.dim('──'));
      continue;
    }
    out.push(inline(raw, c, cwd));
  }
  return out;
}

function inline(text: string, c: Colors, cwd: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) =>
      `${label} → ${c.dim(displayPath(href, cwd))}`)
    .replace(/\*\*([^*]+)\*\*/g, (_match, inner: string) => c.bold(inner))
    .replace(/(^|[^*\w])_([^_]+)_(?=[^\w]|$)/g, (_match, before: string, inner: string) => `${before}${c.italic(inner)}`)
    .replace(/`([^`]+)`/g, (_match, inner: string) => c.cyan(inner));
}
