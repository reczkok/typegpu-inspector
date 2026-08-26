import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModulePath } from 'exsolve';
import { resolvePackageJSON } from 'pkg-types';

export function getPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function toViteFsPath(path: string): string {
  return isAbsolute(path) ? path.replaceAll('\\', '/') : resolve(path).replaceAll('\\', '/');
}

export function createFsModuleUrl(path: string): string {
  return `/@fs/${toViteFsPath(path)}`;
}

export function resolvePackagePath(specifier: string): string {
  return resolveModulePath(specifier, { from: import.meta.url });
}

export type PackageResolutionOptions = {
  nodeModulesDir?: string | undefined;
  packageRoots?: string[] | undefined;
  packageAliases?: Record<string, string> | undefined;
  /** Whether a caller permits the MCP package's bundled dependencies as a ledgered fallback. */
  bundledFallback?: 'allow' | 'error' | undefined;
  /** Resolution identities established by the project-context resolver. */
  resolvedDependencies?: Record<string, {
    path?: string | undefined;
    source: string;
    version?: string | undefined;
  }> | undefined;
};

export function resolvePackagePathFrom(
  cwd: string,
  specifier: string,
  options: PackageResolutionOptions = {},
): string {
  const established = options.resolvedDependencies?.[specifier];
  if (established) {
    if (
      options.bundledFallback === 'error' &&
      (established.source === 'bundled' || established.source === 'unresolved')
    ) {
      throw new Error(
        `${specifier} did not resolve from the inspected project (${established.source}); ` +
          'bundled dependency substitution is disabled for project-faithful inspection.',
      );
    }
    if (established.path) return established.path;
  }
  const aliasPath = resolvePackageAliasPath(specifier, options.packageAliases);
  if (aliasPath) {
    return aliasPath;
  }

  const resolvedPath = resolveModulePath(specifier, {
    from: createRequireCandidateFiles(cwd, options),
    try: true,
  });
  if (resolvedPath) {
    return resolvedPath;
  }

  if (options.bundledFallback === 'error') {
    throw new Error(
      `${specifier} did not resolve from the inspected project; ` +
        'bundled dependency substitution is disabled for project-faithful inspection.',
    );
  }
  return resolvePackagePath(specifier);
}

/**
 * `typegpu/~internal` from the same package `typegpuPath` came from, so the
 * statement-map generator subclasses the instance the inspected module uses.
 * Undefined when the package predates the export (TypeGPU < 0.12) or is a
 * source alias without an `internal` module beside its entry.
 */
export function resolveTypegpuInternalPath(typegpuPath: string): string | undefined {
  const packageDir = findPackageDir(dirname(typegpuPath), 'typegpu');
  if (packageDir) {
    const manifest = readJsonFile(join(packageDir, 'package.json'));
    const exportsField = manifest?.exports;
    const entry = exportsField && typeof exportsField === 'object'
      ? (exportsField as Record<string, unknown>)['./~internal']
      : undefined;
    const target = readExportTarget(entry);
    if (target) {
      const candidate = resolve(packageDir, target);
      if (fileExists(candidate)) return candidate;
    }
  }
  for (const sibling of ['internal.ts', 'internal.js', 'internal.mjs']) {
    const candidate = join(dirname(typegpuPath), sibling);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

function readExportTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  const conditions = entry as Record<string, unknown>;
  for (const key of ['browser', 'import', 'default']) {
    const nested = readExportTarget(conditions[key]);
    if (nested) return nested;
  }
  return undefined;
}

function findPackageDir(startDir: string, packageName: string): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 4; depth += 1) {
    const manifest = readJsonFile(join(dir, 'package.json'));
    if (manifest?.name === packageName) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function resolvePackageAliasPath(
  specifier: string,
  packageAliases: Record<string, string> | undefined,
): string | undefined {
  if (!packageAliases) {
    return undefined;
  }

  const packageName = packageNameFromSpecifier(specifier);
  const aliasRoot = packageAliases[packageName];
  if (!aliasRoot) {
    return undefined;
  }

  const suffix = specifier.slice(packageName.length);
  if (suffix === '/package.json') {
    return findNearestPackageJson(aliasRoot) ?? resolve(aliasRoot, 'package.json');
  }

  if (suffix && !suffix.startsWith('/')) {
    return undefined;
  }

  return resolveModulePath(suffix ? join(aliasRoot, suffix.slice(1)) : aliasRoot, {
    extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
    suffixes: ['', '/index'],
  });
}

export async function findPackageRoots(startDir: string): Promise<string[]> {
  try {
    return [dirname(await resolvePackageJSON(startDir))];
  } catch {
    return [];
  }
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0] ?? specifier;
}

function findNearestPackageJson(aliasRoot: string): string | undefined {
  let current = resolve(aliasRoot);
  while (true) {
    const packageJsonPath = join(current, 'package.json');
    if (fileExists(packageJsonPath)) {
      return packageJsonPath;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function createRequireCandidateFiles(
  cwd: string,
  options: PackageResolutionOptions,
): string[] {
  const candidates: string[] = [];
  if (options.nodeModulesDir) {
    candidates.push(join(options.nodeModulesDir, '.typegpu-mcp-resolve.cjs'));
  }

  for (const root of [cwd, ...(options.packageRoots ?? [])]) {
    candidates.push(join(root, 'package.json'));
  }

  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}
