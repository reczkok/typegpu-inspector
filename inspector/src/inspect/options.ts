import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import type { StaticAssetRoute } from '../types.ts';
import { resolvePackagePath, type PackageResolutionOptions } from './paths.ts';

export function normalizeDependencyAliases(
  cwd: string,
  aliases: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(aliases).map(([find, replacement]) => [
      find,
      resolveAliasReplacement(cwd, replacement),
    ]),
  );
}

export function normalizeStaticAssetRoutes(
  cwd: string,
  routes: StaticAssetRoute[],
): StaticAssetRoute[] {
  return routes.flatMap((route, index) => {
    if (!route.urlPrefix || !route.urlPrefix.startsWith('/')) {
      throw new Error(`staticAssetRoutes[${index}].urlPrefix must start with '/'.`);
    }

    // Editors infer asset routes heuristically, so a directory that does not
    // exist from this process's perspective is dropped rather than failing
    // the whole inspection; a genuinely needed asset then surfaces as a
    // fetch failure in pageErrors, which names the missing path.
    const directory = resolve(cwd, route.directory);
    if (!existsSync(directory)) {
      return [];
    }

    return [{
      urlPrefix: normalizeUrlPrefix(route.urlPrefix),
      directory,
    }];
  });
}

export function normalizeDependencyResolution(
  cwd: string,
  options: PackageResolutionOptions | undefined,
): PackageResolutionOptions {
  return {
    nodeModulesDir: options?.nodeModulesDir
      ? resolve(cwd, options.nodeModulesDir)
      : undefined,
    packageRoots: options?.packageRoots?.map((path) => resolve(cwd, path)),
    packageAliases: options?.packageAliases
      ? Object.fromEntries(
          Object.entries(options.packageAliases).map(([specifier, replacement]) => [
            specifier,
            resolve(cwd, replacement),
          ]),
        )
      : undefined,
    bundledFallback: options?.bundledFallback,
    resolvedDependencies: options?.resolvedDependencies,
  };
}

function normalizeUrlPrefix(prefix: string): string {
  return prefix === '/' ? prefix : prefix.replace(/\/+$/, '');
}

function resolveAliasReplacement(cwd: string, replacement: string): string {
  const cwdRelative = resolve(cwd, replacement);
  if (isAbsolute(replacement) || replacement.startsWith('.') || existsSync(cwdRelative)) {
    return cwdRelative;
  }

  const requireFromCwd = createRequire(join(cwd, 'package.json'));
  try {
    return requireFromCwd.resolve(replacement);
  } catch {
    return resolvePackagePath(replacement);
  }
}
