import type { Hover } from 'vscode-languageserver';
import type { EditorTarget, TargetsResponse } from './editorProtocol.js';
import { targetContextLabel, targetStatusLabel } from './editorProtocol.js';
import { documentLink, targetArtifact } from './inspectionDocuments.js';
import { escapeMarkdown } from './markdown.js';
import type { HoverDetailLevel } from './protocol.js';
import type { DocumentInspection, MaterializedTarget } from './surface.js';

/** Code is visible immediately; each specialization opens its own compiler input. */
export function createZedShaderHover(symbolName: string, snapshot: TargetsResponse, inspection: DocumentInspection | undefined, detail: HoverDetailLevel): Hover | undefined {
  const symbol = snapshot.symbols.find(symbol => symbol.name === symbolName);
  const targets = snapshot.targets.filter(target => symbol?.targetIds.includes(target.id) && target.kind !== 'resource');
  if (!symbol || !targets.length) return undefined;
  const statuses = targets.map(shaderStatus);
  const summaries = targets.map(target => target.inputSummary);
  const commonSummary = summaries[0] && summaries.every(summary => summary === summaries[0]) ? summaries[0] : undefined;
  const commonStatus = statuses.every(status => status === statuses[0]) ? statuses[0] : undefined;
  const blocks = [`**${escapeMarkdown(symbolName)}**${targets.length > 1 ? ` · ${targets.length} specializations` : ''}`];
  if (snapshot.stale) blocks.push('Previous saved result · source has changed.');
  if (commonStatus) blocks.push(commonStatus);
  if (commonSummary) blocks.push(escapeMarkdown(commonSummary));

  for (const [index, target] of targets.entries()) {
    const artifact = targetArtifact(inspection, target);
    const label = targetContextLabel(target.context) || target.label;
    const links = artifact?.generatedUri ? documentLink('Open WGSL', artifact.generatedUri) : undefined;
    blocks.push([
      targets.length > 1 ? `**${escapeMarkdown(label)}**` : undefined,
      !commonStatus ? statuses[index] : undefined,
      links,
    ].filter(Boolean).join(' · '));
    if (target.inputSummary && !commonSummary) blocks.push(escapeMarkdown(target.inputSummary));
    const diagnostic = target.requirementSummary ?? target.diagnostics?.find(entry => entry.severity !== 'note')?.message
      ?? artifact?.report.compilationMessages?.find(entry => entry.type === 'error')?.message;
    if (diagnostic) blocks.push(escapeMarkdown(diagnostic.slice(0, 240)));
    // Bound code height, while every remaining specialization retains a direct link.
    if (artifact?.report.wgsl && detail !== 'compact' && index < 2) {
      const limit = detail === 'wgsl' ? 12 : targets.length > 2 ? 5 : 8;
      blocks.push(shaderExcerpt(symbolName, artifact, limit));
    }
  }
  return { contents: { kind: 'markdown', value: blocks.filter(Boolean).join('\n\n') }, range: symbol.range };
}

function shaderStatus(target: EditorTarget): string {
  const status = targetStatusLabel(target);
  if (status === 'Passed') return '✓ WGSL compiled';
  if (status === 'Passed with assumptions') return target.inputSummary ? '✓ WGSL compiled' : '✓ WGSL compiled · with assumptions';
  return status === 'Failed' ? '✕ Inspection failed' : status;
}

/** Start at the selected function, skipping dependencies and the inspection caller. */
function shaderExcerpt(symbolName: string, artifact: MaterializedTarget, limit: number): string {
  const all = artifact.report.wgsl!.trimEnd().split('\n');
  const name = symbolName.split('.').at(-1)!;
  const declarations = artifact.analysis?.declarations ?? [];
  const selected = declarations.find(declaration => declaration.kind === 'fn' && declaration.name === name)
    ?? declarations.find(declaration => declaration.kind === 'fn' && declaration.name.startsWith(`${name}_`))
    ?? declarations.find(declaration => declaration.kind === 'fn');
  const start = selected ? selected.line - 1 : 0;
  const next = declarations.find(declaration => declaration.line - 1 > start);
  const body = all.slice(start, next ? next.line - 1 : undefined).join('\n').trimEnd().split('\n');
  const excerpt = body.slice(0, limit);
  if (body.length > limit) excerpt.push('// …');
  // A WGSL comment may itself contain backticks; keep the fence unambiguous.
  const fence = '`'.repeat(Math.max(3, ...excerpt.flatMap(line => [...line.matchAll(/`+/g)].map(match => match[0].length + 1))));
  return `${fence}wgsl\n${excerpt.join('\n')}\n${fence}`;
}
