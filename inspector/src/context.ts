import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readPackageJSON,
  resolvePackageJSON,
  type PackageJson,
} from 'pkg-types';
import {
  getPackageRoot,
  resolvePackageAliasPath,
  resolvePackagePath,
  type PackageResolutionOptions,
} from './inspect/paths.ts';

const DEPENDENCY_SPECIFIERS = [
  'typegpu',
  'typegpu/data',
  'typegpu/std',
  'typegpu/common',
  'unplugin-typegpu/vite',
] as const;

const VITE_CONFIG_FILENAMES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
] as const;

export type AgentProjectOptions = {
  root?: string | undefined;
  nodeModulesDir?: string | undefined;
  dependencyAliases?: Record<string, string> | undefined;
  packageVersions?: Record<string, string> | undefined;
  viteConfigPath?: string | undefined;
};

export type ClientRoot = {
  uri: string;
  name?: string | undefined;
};

export type ResolveTypegpuContextOptions = {
  project?: AgentProjectOptions | undefined;
  targetPath?: string | undefined;
  targetPathKind?: 'file' | 'virtual' | undefined;
  cwd?: string | undefined;
  clientRoots?: ClientRoot[] | undefined;
};

export type ResolvedDependency = {
  specifier: string;
  packageName: string;
  path?: string | undefined;
  version?: string | undefined;
  source: DependencySource;
  warning?: string | undefined;
};

export type DependencySource =
  | 'packageAlias'
  | 'nodeModulesDir'
  | 'packageRoot'
  | 'workspaceRoot'
  | 'projectRoot'
  | 'bundled'
  | 'unresolved';

export type ResolvedTypegpuContext = {
  cwd: string;
  projectRoot: string;
  packageRoot?: string | undefined;
  workspaceRoot?: string | undefined;
  workspaceKind?: 'pnpm' | 'npm' | 'yarn' | 'lockfile' | undefined;
  packageName?: string | undefined;
  packageManager?: string | undefined;
  nodeModulesDir?: string | undefined;
  dependencyAliases: Record<string, string>;
  viteConfigPath?: string | undefined;
  targetPath?: string | undefined;
  targetPathExists?: boolean | undefined;
  targetPathKind?: 'file' | 'virtual' | undefined;
  targetPathSource?:
    | 'absolute'
    | 'explicit-project-root'
    | 'mcp-root'
    | 'client-cwd'
    | 'bundled-fallback'
    | undefined;
  targetPathBase?: string | undefined;
  rootSource: 'explicit-project-root' | 'mcp-root' | 'target-path' | 'client-cwd' | 'bundled-fallback';
  dependencies: Record<string, ResolvedDependency>;
  dependencyResolution: PackageResolutionOptions;
  warnings: string[];
};

type RootCandidate = {
  path: string;
  source: ResolvedTypegpuContext['rootSource'];
};

type TargetPathResolution = {
  path: string;
  exists: boolean;
  kind: NonNullable<ResolveTypegpuContextOptions['targetPathKind']>;
  source: NonNullable<ResolvedTypegpuContext['targetPathSource']>;
  base?: string | undefined;
};

export async function resolveTypegpuContext(
  options: ResolveTypegpuContextOptions = {},
): Promise<ResolvedTypegpuContext> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const warnings: string[] = [];
  const roots = normalizeClientRoots(options.clientRoots ?? [], warnings);
  const explicitRoot = options.project?.root
    ? resolve(cwd, options.project.root)
    : undefined;

  const targetPathResolution = resolveTargetPath(options.targetPath, {
    cwd,
    explicitRoot,
    roots,
    kind: options.targetPathKind ?? 'file',
    warnings,
  });
  const targetPath = targetPathResolution?.path;
  const candidates = await createRootCandidates({
    cwd,
    explicitRoot,
    roots,
    targetPath,
    warnings,
  });
  const selected = selectRootCandidate(candidates, warnings);
  const packageRoot = await findNearestPackageRoot(targetPath ?? selected.path) ??
    await findNearestPackageRoot(selected.path);
  const packageJson = packageRoot ? await readPackageJson(packageRoot) : undefined;
  const workspace = await findWorkspaceRoot(packageRoot ?? selected.path);
  const workspaceJson = workspace?.root ? await readPackageJson(workspace.root) : undefined;
  const projectRoot = selected.path;
  const dependencyAliases = normalizeProjectDependencyAliases(
    options.project?.dependencyAliases ?? {},
    explicitRoot ?? projectRoot,
    warnings,
  );
  const packageAliases = packageRootDependencyAliases(dependencyAliases);
  const nodeModulesDir = resolveNodeModulesDir(options.project?.nodeModulesDir, {
    cwd,
    projectRoot,
    packageRoot,
    workspaceRoot: workspace?.root,
  });
  const viteConfigPath = resolveViteConfigPath(options.project?.viteConfigPath, {
    cwd,
    projectRoot,
    packageRoot,
    workspaceRoot: workspace?.root,
    warnings,
  });
  const dependencies = await resolveDependencies({
    cwd: packageRoot ?? projectRoot,
    projectRoot,
    packageRoot,
    workspaceRoot: workspace?.root,
    nodeModulesDir,
    packageAliases,
    packageVersions: options.project?.packageVersions ?? {},
    warnings,
  });
  const dependencyResolution: PackageResolutionOptions = {
    nodeModulesDir,
    packageRoots: uniqueStrings([packageRoot, workspace?.root, projectRoot]),
    packageAliases,
    // Bundled substitution remains available for dependency-less scratch
    // projects, but every such resolution is surfaced in the module ledger.
    bundledFallback: 'allow',
    resolvedDependencies: Object.fromEntries(
      Object.entries(dependencies).map(([specifier, dependency]) => [
        specifier,
        {
          path: dependency.path,
          source: dependency.source,
          version: dependency.version,
        },
      ]),
    ),
  };

  return {
    cwd: packageRoot ?? projectRoot,
    projectRoot,
    packageRoot,
    workspaceRoot: workspace?.root,
    workspaceKind: workspace?.kind,
    packageName: packageJson?.name,
    packageManager: packageJson?.packageManager ??
      workspaceJson?.packageManager ??
      detectPackageManager(workspace?.root ?? packageRoot ?? projectRoot),
    nodeModulesDir,
    dependencyAliases,
    viteConfigPath,
    targetPath,
    targetPathExists: targetPathResolution?.exists,
    targetPathKind: targetPathResolution?.kind,
    targetPathSource: targetPathResolution?.source,
    targetPathBase: targetPathResolution?.base,
    rootSource: selected.source,
    dependencies,
    dependencyResolution,
    warnings,
  };
}

export function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0] ?? specifier;
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function createRootCandidates(input: {
  cwd: string;
  explicitRoot: string | undefined;
  roots: RootCandidate[];
  targetPath: string | undefined;
  warnings: string[];
}): Promise<RootCandidate[]> {
  const candidates: RootCandidate[] = [];
  if (input.explicitRoot) {
    candidates.push({ path: input.explicitRoot, source: 'explicit-project-root' });
  }

  const roots = input.targetPath
    ? [...input.roots].sort((left, right) =>
        Number(isPathInside(right.path, input.targetPath ?? '')) -
        Number(isPathInside(left.path, input.targetPath ?? '')),
      )
    : input.roots;
  candidates.push(...roots);

  if (input.targetPath) {
    const targetPackageRoot = await findNearestPackageRoot(input.targetPath);
    if (targetPackageRoot) {
      candidates.push({ path: targetPackageRoot, source: 'target-path' });
    }
  }

  const bundledRoot = getPackageRoot();
  if (resolve(input.cwd) !== resolve(bundledRoot)) {
    candidates.push({ path: input.cwd, source: 'client-cwd' });
  }
  candidates.push({ path: bundledRoot, source: 'bundled-fallback' });

  const seen = new Set<string>();
  return candidates
    .map((candidate) => ({ ...candidate, path: resolve(candidate.path) }))
    .filter((candidate) => {
      if (seen.has(candidate.path)) {
        return false;
      }
      seen.add(candidate.path);
      if (!directoryExists(candidate.path)) {
        input.warnings.push(`Skipped missing context root: ${candidate.path}`);
        return false;
      }
      return true;
    });
}

function selectRootCandidate(
  candidates: RootCandidate[],
  warnings: string[],
): RootCandidate {
  const selected = candidates[0];
  if (selected) {
    return selected;
  }

  const fallback = getPackageRoot();
  warnings.push(`No project root candidate existed; using bundled MCP package root: ${fallback}`);
  return { path: fallback, source: 'bundled-fallback' };
}

function normalizeClientRoots(roots: ClientRoot[], warnings: string[]): RootCandidate[] {
  const candidates: RootCandidate[] = [];
  for (const root of roots) {
    const path = rootPathFromUri(root.uri);
    if (!path) {
      warnings.push(`Ignored non-file MCP root URI: ${root.uri}`);
      continue;
    }
    candidates.push({ path, source: 'mcp-root' });
  }
  return candidates;
}

function rootPathFromUri(uri: string): string | undefined {
  try {
    if (uri.startsWith('file://')) {
      return fileURLToPath(uri);
    }
    if (isAbsolute(uri)) {
      return uri;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveTargetPath(
  targetPath: string | undefined,
  options: {
    cwd: string;
    explicitRoot: string | undefined;
    roots: RootCandidate[];
    kind: NonNullable<ResolveTypegpuContextOptions['targetPathKind']>;
    warnings: string[];
  },
): TargetPathResolution | undefined {
  if (!targetPath) {
    return undefined;
  }
  if (isAbsolute(targetPath)) {
    const path = resolve(targetPath);
    const exists = existsSync(path);
    if (options.kind === 'file' && !exists) {
      options.warnings.push(`Target path does not exist: ${path}`);
    }
    return { path, exists, kind: options.kind, source: 'absolute' };
  }

  const bundledRoot = getPackageRoot();
  const bases = uniquePathCandidates([
    options.explicitRoot
      ? { path: options.explicitRoot, source: 'explicit-project-root' as const }
      : undefined,
    ...options.roots.map((root) => ({ path: root.path, source: 'mcp-root' as const })),
    resolve(options.cwd) !== resolve(bundledRoot)
      ? { path: options.cwd, source: 'client-cwd' as const }
      : undefined,
    { path: bundledRoot, source: 'bundled-fallback' as const },
  ]);

  if (options.kind === 'virtual') {
    const base = bases[0];
    const path = resolve(base?.path ?? options.cwd, targetPath);
    const exists = existsSync(path);
    if (base?.source === 'bundled-fallback') {
      options.warnings.push(
        `Virtual target path "${targetPath}" resolved inside the MCP package root. Pass project.root, advertise an MCP root, or use an absolute virtualPath when the probe imports project files.`,
      );
    }
    return {
      path,
      exists,
      kind: options.kind,
      source: base?.source ?? 'client-cwd',
      base: base?.path,
    };
  }

  for (const base of bases) {
    const candidate = resolve(base.path, targetPath);
    if (existsSync(candidate)) {
      return {
        path: candidate,
        exists: true,
        kind: options.kind,
        source: base.source,
        base: base.path,
      };
    }
  }

  const fallbackBase = bases[0];
  const fallbackPath = resolve(fallbackBase?.path ?? options.cwd, targetPath);
  options.warnings.push(
    `Relative target path "${targetPath}" was not found under explicit project root, MCP roots, or cwd; resolved to "${fallbackPath}". Pass project.root or use an absolute path if this is not intended.`,
  );
  if (fallbackBase?.source === 'bundled-fallback') {
    options.warnings.push(
      `Relative target path "${targetPath}" resolved inside the MCP package root. The MCP server cwd is not a reliable project cwd; pass project.root or advertise MCP roots.`,
    );
  }
  return {
    path: fallbackPath,
    exists: false,
    kind: options.kind,
    source: fallbackBase?.source ?? 'client-cwd',
    base: fallbackBase?.path,
  };
}

async function findNearestPackageRoot(startPath: string): Promise<string | undefined> {
  try {
    return dirname(await resolvePackageJSON(directoryForSearch(startPath)));
  } catch {
    return undefined;
  }
}

async function findWorkspaceRoot(
  startPath: string,
): Promise<{ root: string; kind: NonNullable<ResolvedTypegpuContext['workspaceKind']> } | undefined> {
  let current = directoryForSearch(startPath);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return { root: current, kind: 'pnpm' };
    }
    const packageJson = await readPackageJson(current);
    if (packageJson?.workspaces !== undefined) {
      return { root: current, kind: 'npm' };
    }
    if (existsSync(join(current, 'yarn.lock'))) {
      return { root: current, kind: 'yarn' };
    }
    if (existsSync(join(current, 'pnpm-lock.yaml')) || existsSync(join(current, 'package-lock.json'))) {
      return { root: current, kind: 'lockfile' };
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function directoryForSearch(path: string): string {
  const resolvedPath = resolve(path);
  try {
    return statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath);
  } catch {
    return extname(basename(resolvedPath)) ? dirname(resolvedPath) : resolvedPath;
  }
}

function resolveNodeModulesDir(
  nodeModulesDir: string | undefined,
  roots: {
    cwd: string;
    projectRoot: string;
    packageRoot: string | undefined;
    workspaceRoot: string | undefined;
  },
): string | undefined {
  if (nodeModulesDir) {
    const base = roots.projectRoot ?? roots.cwd;
    return resolve(base, nodeModulesDir);
  }

  for (const root of uniqueStrings([roots.packageRoot, roots.workspaceRoot, roots.projectRoot])) {
    const candidate = join(root, 'node_modules');
    if (directoryExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveViteConfigPath(
  viteConfigPath: string | undefined,
  roots: {
    cwd: string;
    projectRoot: string;
    packageRoot: string | undefined;
    workspaceRoot: string | undefined;
    warnings: string[];
  },
): string | undefined {
  if (viteConfigPath) {
    if (isAbsolute(viteConfigPath)) {
      return resolve(viteConfigPath);
    }

    const bases = uniqueStrings([
      roots.packageRoot,
      roots.projectRoot,
      roots.workspaceRoot,
      roots.cwd,
    ]);
    for (const root of bases) {
      const candidate = resolve(root, viteConfigPath);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const fallbackBase = roots.packageRoot ?? roots.projectRoot ?? roots.cwd;
    const fallbackPath = resolve(fallbackBase, viteConfigPath);
    roots.warnings.push(
      `Relative Vite config path "${viteConfigPath}" was not found under target package root, project root, workspace root, or cwd; resolved to "${fallbackPath}". Pass an absolute project.viteConfigPath if this is not intended.`,
    );
    return fallbackPath;
  }

  for (const root of uniqueStrings([roots.packageRoot, roots.projectRoot, roots.workspaceRoot])) {
    for (const filename of VITE_CONFIG_FILENAMES) {
      const candidate = join(root, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function resolveDependencies(input: {
  cwd: string;
  projectRoot: string;
  packageRoot: string | undefined;
  workspaceRoot: string | undefined;
  nodeModulesDir: string | undefined;
  packageAliases: Record<string, string>;
  packageVersions: Record<string, string>;
  warnings: string[];
}): Promise<Record<string, ResolvedDependency>> {
  const packageJsonCache = new Map<string, PackageJson>();
  return Object.fromEntries(
    await Promise.all(DEPENDENCY_SPECIFIERS.map(async (specifier) => {
      const dependency = await resolveDependency(specifier, { ...input, packageJsonCache });
      const expectedVersion = input.packageVersions[dependency.packageName] ??
        input.packageVersions[specifier];
      if (
        expectedVersion &&
        dependency.version &&
        expectedVersion !== dependency.version
      ) {
        const warning =
          `${specifier} resolved ${dependency.version}, which does not match requested packageVersions hint ${expectedVersion}.`;
        dependency.warning = warning;
        input.warnings.push(warning);
      }
      if (dependency.source === 'bundled') {
        input.warnings.push(`${specifier} fell back to the MCP package dependency at ${dependency.path}.`);
      }
      if (dependency.warning && !input.warnings.includes(dependency.warning)) {
        input.warnings.push(dependency.warning);
      }
      return [specifier, dependency];
    })),
  );
}

async function resolveDependency(
  specifier: string,
  input: {
    cwd: string;
    projectRoot: string;
    packageRoot: string | undefined;
    workspaceRoot: string | undefined;
    nodeModulesDir: string | undefined;
    packageAliases: Record<string, string>;
    packageJsonCache: Map<string, PackageJson>;
  },
): Promise<ResolvedDependency> {
  const packageName = packageNameFromSpecifier(specifier);
  const aliasPath = resolvePackageAliasPath(specifier, input.packageAliases);
  if (aliasPath) {
    return {
      specifier,
      packageName,
      path: aliasPath,
      version: await readPackageVersionNearPath(aliasPath, packageName, input.packageJsonCache),
      source: 'packageAlias',
    };
  }

  const candidates = createDependencyCandidates(input);
  let bundledPath: string | undefined;
  try {
    bundledPath = resolvePackagePath(specifier);
  } catch {
    // The ordinary project candidates can still resolve this dependency.
  }
  for (const candidate of candidates) {
    try {
      const path = createRequire(candidate.file).resolve(specifier);
      const source =
        candidate.source !== 'nodeModulesDir' &&
          bundledPath &&
          resolve(path) === resolve(bundledPath)
          ? 'bundled'
          : candidate.source;
      return {
        specifier,
        packageName,
        path,
        version: await readPackageVersionNearPath(path, packageName, input.packageJsonCache) ??
          await readResolvedPackageVersion(packageName, candidates, input.packageJsonCache),
        source,
      };
    } catch {
    }
  }

  try {
    const path = resolvePackagePath(specifier);
    return {
      specifier,
      packageName,
      path,
      version: await readPackageVersionNearPath(path, packageName, input.packageJsonCache),
      source: 'bundled',
    };
  } catch {
    return {
      specifier,
      packageName,
      source: 'unresolved',
      warning: `Could not resolve ${specifier} from project context or bundled dependencies.`,
    };
  }
}

function normalizeProjectDependencyAliases(
  aliases: Record<string, string>,
  baseRoot: string,
  warnings: string[],
): Record<string, string> {
  const normalized = Object.fromEntries(
    Object.entries(aliases).map(([specifier, replacement]) => [
      specifier,
      isAbsolute(replacement) ? resolve(replacement) : resolve(baseRoot, replacement),
    ]),
  );

  const hasTypegpuRootAlias = Object.hasOwn(normalized, 'typegpu');
  const hasTypegpuSubpathAlias = Object.keys(normalized).some((specifier) =>
    specifier.startsWith('typegpu/'),
  );
  if (hasTypegpuSubpathAlias && !hasTypegpuRootAlias) {
    warnings.push(
      'TypeGPU subpath dependency aliases were provided without a root "typegpu" alias. Prefer a package-root alias such as { "typegpu": "packages/typegpu/src" } so typegpu, typegpu/data, typegpu/std, and typegpu/common resolve consistently.',
    );
  }

  return normalized;
}

function packageRootDependencyAliases(aliases: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(aliases).filter(([specifier]) => specifier === packageNameFromSpecifier(specifier)),
  );
}

function createDependencyCandidates(input: {
  cwd: string;
  projectRoot: string;
  packageRoot: string | undefined;
  workspaceRoot: string | undefined;
  nodeModulesDir: string | undefined;
}): Array<{ file: string; source: DependencySource }> {
  const candidates: Array<{ file: string; source: DependencySource }> = [];
  if (input.nodeModulesDir) {
    candidates.push({
      file: join(input.nodeModulesDir, '.typegpu-mcp-resolve.cjs'),
      source: 'nodeModulesDir',
    });
  }
  for (const [root, source] of [
    [input.packageRoot, 'packageRoot'],
    [input.workspaceRoot, 'workspaceRoot'],
    [input.projectRoot, 'projectRoot'],
    [input.cwd, 'projectRoot'],
  ] as const) {
    if (root) {
      candidates.push({ file: join(root, 'package.json'), source });
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${resolve(candidate.file)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function readResolvedPackageVersion(
  packageName: string,
  candidates: Array<{ file: string; source: DependencySource }>,
  cache: Map<string, PackageJson>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      const packageJsonPath = createRequire(candidate.file).resolve(`${packageName}/package.json`);
      const packageJson = await readPackageJson(packageJsonPath, cache);
      if (packageJson?.version) {
        return packageJson.version;
      }
    } catch {
    }
  }
  return undefined;
}

async function readPackageVersionNearPath(
  path: string,
  packageName: string,
  cache: Map<string, PackageJson>,
): Promise<string | undefined> {
  let current = dirname(path);
  while (true) {
    const packageJsonPath = join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = await readPackageJson(packageJsonPath, cache);
      if (packageJson?.name === packageName) {
        return packageJson.version;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function detectPackageManager(root: string): string | undefined {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  if (existsSync(join(root, 'package-lock.json'))) {
    return 'npm';
  }
  return undefined;
}

async function readPackageJson(
  rootOrPackageJsonPath: string,
  cache?: Map<string, PackageJson>,
): Promise<PackageJson | undefined> {
  try {
    return await readPackageJSON(rootOrPackageJsonPath, { cache });
  } catch {
    return undefined;
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function uniquePathCandidates<T extends { path: string }>(
  values: Array<T | undefined>,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    const path = resolve(value.path);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push({ ...value, path });
  }
  return result;
}
