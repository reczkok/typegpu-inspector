import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { collectSourceFiles } from './cliFiles.js';
import { resolveImport } from './moduleGraph.js';

export type ContextSuggestion = { path: string; line: number; via: string; kind: 'import' | 'reexport' };
export type ContextSuggestions = { candidates: ContextSuggestion[]; truncated: boolean };
const MAX_FILES = 1000;
const MAX_RESULTS = 20;

/** Static module-level leads, never executable contexts or proof of a shader call. */
export async function findContextSuggestions(root: string, modulePath: string): Promise<ContextSuggestions> {
  const { files } = await collectSourceFiles([root], root);
  const edges: Array<ContextSuggestion & { dependency: string }> = [];
  let truncated = files.length > MAX_FILES;
  for (const path of files.slice(0, MAX_FILES)) {
    try {
      if ((await stat(path)).size > 1_000_000) { truncated = true; continue; }
      const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, false);
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
        if ((ts.isExportDeclaration(node) && node.isTypeOnly) || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)) continue;
        const specifier = node.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const dependency = resolveImport(specifier.text, path);
        if (!dependency) continue;
        edges.push({ path, dependency: resolve(dependency), via: specifier.text,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          kind: ts.isExportDeclaration(node) ? 'reexport' : 'import' });
      }
    } catch { truncated = true; }
  }
  const reachable = new Set([resolve(modulePath)]);
  // Only barrel exports propagate the reverse search. Ordinary consumers are leads.
  for (let depth = 0; depth < 8; depth++) {
    const before = reachable.size;
    for (const edge of edges) if (edge.kind === 'reexport' && reachable.has(edge.dependency)) reachable.add(edge.path);
    if (reachable.size === before) break;
    if (depth === 7) truncated = true;
  }
  const matches = edges.filter(edge => edge.path !== resolve(modulePath) && reachable.has(edge.dependency));
  return { candidates: matches.slice(0, MAX_RESULTS).map(({ dependency: _, ...entry }) => entry), truncated: truncated || matches.length > MAX_RESULTS };
}
