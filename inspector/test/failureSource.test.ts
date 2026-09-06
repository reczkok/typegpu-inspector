import type { ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { attributeModuleFailure, readFailureSource } from '../src/inspect/failureSource.ts';

function serverWithMap(map: unknown) {
  const getModuleByUrl = vi.fn(async (url: string) => ({
    file: url.includes('node_modules') ? '/workspace/node_modules/library.ts' : '/workspace/src/config.ts',
    transformResult: { map },
  }));
  return { server: { moduleGraph: { getModuleByUrl } } as unknown as ViteDevServer, getModuleByUrl };
}

const map = { version: 3, sources: ['/workspace/src/config.ts'], sourcesContent: ['first\n    throw bad;'],
  names: [], mappings: 'AAAA;AACI' };

describe('module failure source attribution', () => {
  it('maps the authored frame after library internals and ignores changing Vite ports and queries', async () => {
    const { server } = serverWithMap(map);
    for (const port of [5173, 5174]) {
      const error = new Error('bad');
      error.stack = `Error: bad\n    at f (http://localhost:${port}/node_modules/library.ts:7:3)\n    at http://localhost:${port}/src/config.ts?t=123:2:8`;
      await attributeModuleFailure(error, server, '/workspace');
      expect(readFailureSource(error)).toEqual({ path: '/workspace/src/config.ts', projectRelativePath: 'src/config.ts', line: 2, column: 5 });
      expect(error.message).toBe('bad');
    }
  });

  it('does not guess source locations from unmapped or malformed transforms', async () => {
    for (const mapping of [undefined, { mappings: '' }, { ...map, mappings: '' }]) {
      const { server } = serverWithMap(mapping);
      const error = new Error('bad');
      error.stack = 'Error: bad\n    at http://localhost:5173/src/config.ts:2:8';
      await attributeModuleFailure(error, server);
      expect(readFailureSource(error)).toBeUndefined();
    }
  });
});
