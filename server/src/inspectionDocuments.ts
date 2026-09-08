import { createHash, randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { targetSelectionKey, type EditorTarget } from './editorProtocol.js';
import { escapeMarkdown } from './markdown.js';
import type { DocumentInspection, MaterializedTarget } from './surface.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

/** Declaration offsets may move; labels and explicit context identify the document. */
export function inspectionDocumentPath(workspace: string, modulePath: string, target: Pick<EditorTarget, 'label' | 'context'>, extension = 'wgsl'): string {
  const directory = join(tmpdir(), 'typegpu-inspector', hash(workspace), hash(modulePath));
  const name = safe(basename(modulePath).replace(/\.[^.]+$/, ''));
  return join(directory, `${name}__${safe(target.label)}__${hash(targetSelectionKey(target))}.${extension}`);
}

/** Readers see a whole revision. Unchanged files retain their modification time. */
export async function writeInspectionDocument(path: string, text: string, isCurrent = () => true): Promise<void> {
  if (!isCurrent()) return;
  if (await readFile(path, 'utf8').catch(() => undefined) === text) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, 'utf8');
    // No await between the revision check and replacement.
    if (isCurrent()) renameSync(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function documentLink(label: string, uri: string): string {
  return `[${escapeMarkdown(label)}](<${uri.replaceAll('>', '%3E').replaceAll('<', '%3C')}>)`;
}

export function targetArtifact(inspection: DocumentInspection | undefined, target: EditorTarget): MaterializedTarget | undefined {
  const matches = [...(inspection?.targets.values() ?? [])].filter(entry => targetSelectionKey(entry.report) === targetSelectionKey(target));
  return matches.length === 1 ? matches[0] : undefined;
}

