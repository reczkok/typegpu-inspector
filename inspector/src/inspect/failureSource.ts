import { SourceMap } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import type { SerializedError } from '../types.ts';

/** Map the first authored stack frame before Vite's transform cache is released. */
export async function attributeModuleFailure(error: unknown, server: ViteDevServer, projectRoot?: string): Promise<void> {
  if (!(error instanceof Error) || !error.stack) return;
  for (const line of error.stack.split('\n').slice(1)) {
    const frame = /(?:\(|\s)(https?:\/\/[^\s)]+):(\d+):(\d+)\)?$/.exec(line);
    if (!frame) continue;
    try {
      const url = new URL(frame[1]!);
      const module = await server.moduleGraph.getModuleByUrl(`${url.pathname}${url.search}`);
      if (!module?.file || module.file.includes('/node_modules/') || !module.transformResult?.map) continue;
      const map = module.transformResult.map;
      if (!('sources' in map)) continue;
      const entry = new SourceMap({ sourceRoot: '', ...map, version: 3 }).findEntry(Number(frame[2]) - 1, Number(frame[3]) - 1);
      if (!('originalSource' in entry) || !entry.originalSource) continue;
      const source = entry.originalSource.startsWith('file:')
        ? fileURLToPath(entry.originalSource)
        : entry.originalSource;
      const path = isAbsolute(source) ? source : resolve(dirname(module.file), source);
      if (path.includes('/node_modules/') || path.includes('/__typegpu_inspector__/')) continue;
      const sourceLocation = { path, line: entry.originalLine + 1, column: entry.originalColumn + 1,
        ...(projectRoot ? { projectRelativePath: relative(projectRoot, path) } : {}),
      };
      Object.assign(error, { sourceLocation });
      return;
    } catch {
      // Attribution must never replace the original failure or guess a source line.
    }
  }
}

export function readFailureSource(error: unknown): SerializedError['sourceLocation'] {
  if (!error || typeof error !== 'object' || !('sourceLocation' in error)) return undefined;
  return (error as { sourceLocation: SerializedError['sourceLocation'] }).sourceLocation;
}
