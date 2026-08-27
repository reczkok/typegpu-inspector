import { stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { escapePath, glob, isDynamicPattern } from 'tinyglobby';

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
]);

const SKIPPED_DIRECTORIES = ['node_modules', 'dist', 'build', 'out', 'coverage', 'target'];
const IGNORE_PATTERNS = [...SKIPPED_DIRECTORIES.map((name) => `**/${name}/**`), '**/.*/**'];

export type CollectedFiles = {
  /** Absolute paths, sorted, without duplicates. */
  files: string[];
  /** Arguments that named nothing on disk. */
  missing: string[];
  /** Absolute directories named directly, for a watcher to subscribe to. */
  directories: string[];
};

/**
 * Files named directly are taken as given; directories are walked and globs
 * expanded for source files, skipping dependency and build output folders.
 */
export async function collectSourceFiles(
  patterns: readonly string[],
  cwd: string,
): Promise<CollectedFiles> {
  const files = new Set<string>();
  const missing: string[] = [];
  const directories: string[] = [];
  for (const pattern of patterns) {
    if (isDynamicPattern(pattern)) {
      for (const match of await expand(pattern, cwd)) files.add(match);
      continue;
    }
    const absolute = resolve(cwd, pattern);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      missing.push(pattern);
      continue;
    }
    if (info.isDirectory()) {
      directories.push(absolute);
      for (const match of await expand(`${escapePath(pattern)}/**`, cwd)) files.add(match);
    } else {
      files.add(absolute);
    }
  }
  return { files: [...files].sort(), missing, directories };
}

async function expand(pattern: string, cwd: string): Promise<string[]> {
  const matches = await glob(pattern, {
    cwd,
    absolute: true,
    onlyFiles: true,
    ignore: IGNORE_PATTERNS,
    expandDirectories: false,
  });
  return matches.filter(isSourceFile);
}

export function isSourceFile(path: string): boolean {
  if (path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts')) return false;
  return SOURCE_EXTENSIONS.has(extname(path));
}

/** True for paths inside a skipped or hidden folder, judged relative to `root`. */
export function isIgnoredUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..')) return false;
  return rel.split(sep).some((segment) =>
    segment.startsWith('.') || SKIPPED_DIRECTORIES.includes(segment)
  );
}
