import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { ResolvedTypegpuContext } from './context.ts';
import { getPackageRoot } from './inspect/paths.ts';
import { isRecord, omitUndefined } from './shared.ts';

const CORE_TYPEGPU_SPECIFIERS = [
  'typegpu',
  'typegpu/data',
  'typegpu/std',
  'typegpu/common',
] as const;

type PathAlias = {
  path: string;
  label: string;
};

export function createPublicResolvedContext(
  context: ResolvedTypegpuContext,
  options: { includeDependencies?: boolean } = {},
): Record<string, unknown> {
  return sanitizeForAgent(
    omitUndefined({
      cwd: formatKnownPath(context.cwd, context),
      projectRoot: '<projectRoot>',
      packageRoot: context.packageRoot ? '<packageRoot>' : undefined,
      workspaceRoot: context.workspaceRoot ? '<workspaceRoot>' : undefined,
      workspaceKind: context.workspaceKind,
      packageName: context.packageName,
      packageManager: context.packageManager,
      nodeModulesDir: context.nodeModulesDir ? '<nodeModules>' : undefined,
      dependencyAliases: context.dependencyAliases,
      viteConfigPath: context.viteConfigPath ? '<viteConfig>' : undefined,
      targetPath: context.targetPath,
      targetPathExists: context.targetPathExists,
      targetPathKind: context.targetPathKind,
      targetPathSource: context.targetPathSource,
      targetPathBase: formatKnownPath(context.targetPathBase, context),
      rootSource: context.rootSource,
      dependencies: options.includeDependencies === false
        ? undefined
        : context.dependencies,
      warnings: context.warnings,
      pathAliases: createPathAliasLegend(context),
    }),
    context,
  ) as Record<string, unknown>;
}

function formatKnownPath(
  path: string | undefined,
  context: ResolvedTypegpuContext,
): string | undefined {
  if (!path) {
    return undefined;
  }
  const resolvedPath = resolve(path);
  if (context.packageRoot && resolvedPath === resolve(context.packageRoot)) {
    return '<packageRoot>';
  }
  if (resolvedPath === resolve(context.projectRoot)) {
    return '<projectRoot>';
  }
  if (context.workspaceRoot && resolvedPath === resolve(context.workspaceRoot)) {
    return '<workspaceRoot>';
  }
  if (context.nodeModulesDir && resolvedPath === resolve(context.nodeModulesDir)) {
    return '<nodeModules>';
  }
  if (context.viteConfigPath && resolvedPath === resolve(context.viteConfigPath)) {
    return '<viteConfig>';
  }
  if (resolvedPath === resolve(getPackageRoot())) {
    return '<mcpPackage>';
  }
  return path;
}

export function createDependencySummary(
  context: ResolvedTypegpuContext,
  options: { compact?: boolean } = {},
): Record<string, unknown> {
  const resolvedCoreDependencies = CORE_TYPEGPU_SPECIFIERS.flatMap((specifier) => {
    const dependency = context.dependencies[specifier];
    return dependency ? [{ specifier, dependency }] : [];
  });
  const coreDependencies = Object.fromEntries(
    resolvedCoreDependencies.map(({ specifier, dependency }) => {
      return [
        specifier,
        omitUndefined({
          source: dependency.source,
          version: dependency.version,
          path: dependency.path,
          warning: dependency.warning,
        }),
      ];
    }),
  );
  const coreSources = uniqueValues(
    resolvedCoreDependencies.map(({ dependency }) => dependency.source),
  );
  const coreVersions = uniqueValues(
    resolvedCoreDependencies.map(({ dependency }) => dependency.version),
  );
  const coreTypegpuFamily = options.compact
    ? omitUndefined({
        family: 'typegpu/*',
        specifiers: resolvedCoreDependencies.map(({ specifier }) => specifier),
        source: coreSources.length === 1 ? coreSources[0] : undefined,
        version: coreVersions.length === 1 ? coreVersions[0] : undefined,
        sources: coreSources.length > 1 ? coreSources : undefined,
        versions: coreVersions.length > 1 ? coreVersions : undefined,
      })
    : undefined;
  const bundledFallbacks = Object.values(context.dependencies)
    .filter((dependency) => dependency.source === 'bundled')
    .map((dependency) => dependency.specifier);
  const packageAliases = Object.values(context.dependencies)
    .filter((dependency) => dependency.source === 'packageAlias')
    .map((dependency) => dependency.specifier);

  return sanitizeForAgent(
    {
      coreTypegpu: options.compact ? undefined : coreDependencies,
      coreTypegpuFamily,
      bundledFallbacks,
      packageAliases,
      hasBundledTypegpuFallback: CORE_TYPEGPU_SPECIFIERS.some(
        (specifier) => context.dependencies[specifier]?.source === 'bundled',
      ),
      allCoreTypegpuFromPackageAlias: CORE_TYPEGPU_SPECIFIERS.every(
        (specifier) => context.dependencies[specifier]?.source === 'packageAlias',
      ),
    },
    context,
  ) as Record<string, unknown>;
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

export function createInspectionSurface(formattedReport: unknown): Record<string, unknown> {
  if (!isRecord(formattedReport)) {
    return {};
  }

  return omitUndefined({
    summary: formattedReport.summary,
    causes: formattedReport.causes,
    ledger: formattedReport.ledger,
    targets: formattedReport.targets,
    moduleImport: formattedReport.moduleImport,
    diagnostics: formattedReport.diagnostics,
    environment: formattedReport.environment,
    stats: formattedReport.stats,
    console: formattedReport.console,
    pageErrors: formattedReport.pageErrors,
    calls: formattedReport.calls,
  });
}

export function sanitizeForAgent(
  value: unknown,
  context?: ResolvedTypegpuContext | undefined,
): unknown {
  const aliases = createPathAliases(context);
  return sanitizeValue(value, aliases);
}

function sanitizeValue(value: unknown, aliases: PathAlias[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, aliases);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, aliases));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      sanitizeValue(entryValue, aliases),
    ]),
  );
}

function createPathAliasLegend(context: ResolvedTypegpuContext): Record<string, string> {
  const legend = omitUndefined({
    cwd: context.cwd ? '<cwd>' : undefined,
    projectRoot: context.projectRoot ? '<projectRoot>' : undefined,
    packageRoot: context.packageRoot ? '<packageRoot>' : undefined,
    workspaceRoot: context.workspaceRoot ? '<workspaceRoot>' : undefined,
    targetBase: context.targetPathBase ? '<targetBase>' : undefined,
    nodeModulesDir: context.nodeModulesDir ? '<nodeModules>' : undefined,
    viteConfigPath: context.viteConfigPath ? '<viteConfig>' : undefined,
    mcpPackage: '<mcpPackage>',
  });
  return {
    ...Object.fromEntries(
      Object.entries(legend).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string',
      ),
    ),
    ...Object.fromEntries(
      Object.keys(context.dependencyAliases).map((specifier) => [
        `alias:${specifier}`,
        `<alias:${specifier}>`,
      ]),
    ),
  };
}

function createPathAliases(context?: ResolvedTypegpuContext | undefined): PathAlias[] {
  const aliases: PathAlias[] = [];
  const add = (path: string | undefined, label: string) => {
    if (!path || !isAbsolute(path)) {
      return;
    }
    const resolvedPath = resolve(path);
    if (aliases.some((alias) => alias.path === resolvedPath && alias.label === label)) {
      return;
    }
    aliases.push({ path: resolvedPath, label });
  };

  add(context?.packageRoot, '<packageRoot>');
  add(context?.projectRoot, '<projectRoot>');
  add(context?.workspaceRoot, '<workspaceRoot>');
  add(context?.cwd, '<cwd>');
  add(context?.targetPathBase, '<targetBase>');
  add(context?.nodeModulesDir, '<nodeModules>');
  add(context?.viteConfigPath, '<viteConfig>');
  for (const [specifier, replacement] of Object.entries(context?.dependencyAliases ?? {})) {
    add(replacement, `<alias:${specifier}>`);
  }
  add(getPackageRoot(), '<mcpPackage>');
  add(homedir(), '~');

  return aliases
    .filter((alias, index, all) =>
      all.findIndex((candidate) => candidate.path === alias.path) === index,
    )
    .sort((left, right) => right.path.length - left.path.length);
}

function redactString(value: string, aliases: PathAlias[]): string {
  let redacted = value;
  for (const alias of aliases) {
    redacted = replacePathVariant(redacted, alias.path, alias.label);
    redacted = replacePathVariant(redacted, alias.path.replaceAll('\\', '/'), alias.label);
  }
  return redacted;
}

function replacePathVariant(value: string, path: string, label: string): string {
  if (!path) {
    return value;
  }
  return value.replace(new RegExp(escapeRegExp(path), 'g'), label);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
