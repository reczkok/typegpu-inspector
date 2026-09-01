import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { escapePath, glob, isDynamicPattern } from 'tinyglobby';

export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
]);

const SKIPPED_DIRECTORIES = ['node_modules', 'dist', 'build', 'out', 'coverage', 'target'];
const IGNORE_PATTERNS = [...SKIPPED_DIRECTORIES.map((name) => `**/${name}/**`), '**/.*/**'];

export type CollectOptions = {
  /** Globs, relative to the working directory, that walks and globs skip. */
  ignore?: readonly string[];
  /** Honor `.gitignore` files; on by default. */
  gitignore?: boolean;
};

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
 * expanded for source files, skipping dependency and build output folders,
 * the `--ignore` globs, and whatever `.gitignore` files above or below the
 * walked directories exclude.
 */
export async function collectSourceFiles(
  patterns: readonly string[],
  cwd: string,
  options: CollectOptions = {},
): Promise<CollectedFiles> {
  const files = new Set<string>();
  const missing: string[] = [];
  const directories: string[] = [];
  const walked: Array<{ root: string; matches: string[] }> = [];
  const extraIgnore = [...(options.ignore ?? [])];
  for (const pattern of patterns) {
    if (isDynamicPattern(pattern)) {
      walked.push({ root: cwd, matches: await expand(pattern, cwd, extraIgnore) });
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
      walked.push({
        root: absolute,
        matches: await expand(`${escapePath(pattern)}/**`, cwd, extraIgnore),
      });
    } else {
      files.add(absolute);
    }
  }
  const excluded = options.gitignore === false
    ? () => false
    : await gitignoreMatcher(walked.map((entry) => entry.root));
  for (const entry of walked) {
    for (const match of entry.matches) {
      if (!excluded(match)) files.add(match);
    }
  }
  return { files: [...files].sort(), missing, directories };
}

async function expand(pattern: string, cwd: string, extraIgnore: readonly string[]): Promise<string[]> {
  const matches = await glob(pattern, {
    cwd,
    absolute: true,
    onlyFiles: true,
    ignore: [...IGNORE_PATTERNS, ...extraIgnore],
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

// --- .gitignore ---------------------------------------------------------------

type GitignoreRules = { directory: string; rules: Ignore };

/**
 * A matcher over every `.gitignore` that governs the walked roots: the ones
 * in the roots and below them, and the ones in their ancestors up to the
 * repository root. Each file applies to paths under its own directory, as
 * git does; a rule negated in a deeper file is not resolved against an
 * ancestor's, which git would do.
 */
export async function gitignoreMatcher(roots: readonly string[]): Promise<(path: string) => boolean> {
  const candidates = new Set<string>();
  for (const root of roots) {
    for (const ancestor of ancestorsToRepositoryRoot(root)) candidates.add(resolve(ancestor, '.gitignore'));
    const nested = await glob('**/.gitignore', {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
      ignore: IGNORE_PATTERNS,
      expandDirectories: false,
    });
    for (const file of nested) candidates.add(file);
  }
  const loaded: GitignoreRules[] = [];
  for (const file of [...candidates].sort()) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    loaded.push({ directory: dirname(file), rules: ignore().add(text) });
  }
  if (loaded.length === 0) return () => false;
  return (path) =>
    loaded.some(({ directory, rules }) => {
      const rel = relative(directory, path);
      if (rel === '' || rel.startsWith('..')) return false;
      return rules.ignores(rel.split(sep).join('/'));
    });
}

function ancestorsToRepositoryRoot(start: string): string[] {
  const ancestors: string[] = [];
  let current = start;
  for (;;) {
    ancestors.push(current);
    if (isRepositoryRoot(current)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

/** A `.git` entry, directory or worktree file, marks where git stops looking. */
function isRepositoryRoot(directory: string): boolean {
  return existsSync(resolve(directory, '.git'));
}
