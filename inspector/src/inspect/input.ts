import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  InspectTypegpuModuleInput,
  StaticAssetRoute,
} from '../types.ts';
import { DEFAULT_INSPECTION_TIMEOUT_MS } from '../shared.ts';
import { createFsModuleUrl, type PackageResolutionOptions } from './paths.ts';
import {
  normalizeDependencyAliases,
  normalizeDependencyResolution,
  normalizeStaticAssetRoutes,
} from './options.ts';
import { createInlineModuleUrl } from './vite.ts';

export type NormalizedInput = Required<
  Pick<
    InspectTypegpuModuleInput,
    | 'exportName'
    | 'timeoutMs'
    | 'features'
    | 'strictNames'
    | 'autoBind'
    | 'reuseBrowser'
  >
> & {
  cwd: string;
  diagnosticsOnly: boolean;
  modulePath?: string | undefined;
  inlineCode?: string | undefined;
  inlineSourcePath?: string | undefined;
  documentHtml?: string | undefined;
  browserSetup?: string | undefined;
  sourceKind: 'modulePath' | 'inlineCode';
  viteConfigPath?: string | undefined;
  dependencyAliases: Record<string, string>;
  fsAllow: string[];
  staticAssetRoutes: StaticAssetRoute[];
  dependencyResolution: PackageResolutionOptions;
};

export type PreparedInput = NormalizedInput & {
  modulePath: string;
  moduleUrl: string;
  cacheDir: string;
  cleanupDirs: string[];
};

export function normalizeInput(input: InspectTypegpuModuleInput): NormalizedInput {
  const cwd = resolve(input.cwd ?? process.cwd());
  const source = input.source;
  if (!source) {
    throw new Error("Pass source with kind 'modulePath', 'inlineCode', or 'inspectBody'.");
  }

  const base = {
    cwd,
    exportName: input.exportName ?? 'inspect',
    timeoutMs: input.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS,
    viteConfigPath: input.viteConfigPath
      ? resolve(cwd, input.viteConfigPath)
      : undefined,
    features: input.features ?? [],
    strictNames: input.strictNames ?? true,
    autoBind: input.autoBind ?? true,
    reuseBrowser: input.reuseBrowser ?? false,
    diagnosticsOnly: input.diagnosticsOnly ?? false,
    documentHtml: input.documentHtml,
    browserSetup: input.browserSetup,
    dependencyAliases: normalizeDependencyAliases(cwd, input.dependencyAliases ?? {}),
    fsAllow: (input.fsAllow ?? []).map((path) => resolve(cwd, path)),
    staticAssetRoutes: normalizeStaticAssetRoutes(cwd, input.staticAssetRoutes ?? []),
    dependencyResolution: normalizeDependencyResolution(cwd, input.dependencyResolution),
  };

  if (source.kind === 'inlineCode' || source.kind === 'inspectBody') {
    return {
      ...base,
      inlineCode: source.kind === 'inlineCode' ? source.inlineCode : wrapInspectBody(source.inspectBody),
      inlineSourcePath: source.inlineSourcePath
        ? resolve(cwd, source.inlineSourcePath)
        : undefined,
      sourceKind: 'inlineCode',
    };
  }

  if (source.kind !== 'modulePath') {
    throw new Error("source.kind must be 'modulePath', 'inlineCode', or 'inspectBody'.");
  }
  const modulePath = resolve(cwd, source.modulePath);
  if (!existsSync(modulePath)) {
    throw new Error(`Module path does not exist: ${modulePath}`);
  }

  return {
    ...base,
    modulePath,
    sourceKind: 'modulePath',
  };
}

function wrapInspectBody(body: string): string {
  return `export async function inspect({ root, device, tgpu, d, std, common }) {
${body}
}
`;
}

export async function prepareInspectionInput(input: InspectTypegpuModuleInput): Promise<PreparedInput> {
  const normalized = normalizeInput(input);
  if (normalized.sourceKind === 'modulePath') {
    const modulePath = (normalized as NormalizedInput & { modulePath: string }).modulePath;
    return {
      ...(normalized as NormalizedInput & { modulePath: string }),
      moduleUrl: createFsModuleUrl(modulePath),
      cacheDir: await resolvePersistentCacheDir(normalized, dirname(modulePath)),
      cleanupDirs: [],
    };
  }

  if (normalized.inlineSourcePath) {
    return {
      ...normalized,
      modulePath: normalized.inlineSourcePath,
      moduleUrl: createInlineModuleUrl(normalized.inlineSourcePath),
      cacheDir: await resolvePersistentCacheDir(
        normalized,
        dirname(normalized.inlineSourcePath),
      ),
      cleanupDirs: [],
    };
  }

  const cleanupDir = await mkdtemp(join(tmpdir(), 'typegpu-mcp-'));
  const modulePath = join(cleanupDir, 'inline-inspection.ts');
  await writeFile(modulePath, normalized.inlineCode ?? '', 'utf8');

  return {
    ...normalized,
    modulePath,
    moduleUrl: createFsModuleUrl(modulePath),
    cacheDir: await resolvePersistentCacheDir(normalized, normalized.cwd),
    cleanupDirs: [cleanupDir],
  };
}

/**
 * Vite's dependency pre-bundling dominates cold session establishment, so its
 * cache must survive process restarts instead of living in a throwaway temp
 * dir. The directory is keyed by everything that changes what Vite would
 * optimize; Vite itself re-optimizes in place when the lockfile or config
 * changes, so a stale entry degrades to exactly one cold run.
 */
/**
 * Bumped whenever inspector-side Vite config changes in a way Vite's own
 * re-optimization check cannot see (e.g. resolve.preserveSymlinks), so stale
 * prebundles from older releases never get served.
 */
const CACHE_SCHEMA_VERSION = 3;

async function resolvePersistentCacheDir(
  normalized: NormalizedInput,
  moduleScopeDir: string,
): Promise<string> {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        CACHE_SCHEMA_VERSION,
        normalized.cwd,
        moduleScopeDir,
        normalized.viteConfigPath ?? null,
        normalized.dependencyAliases,
        normalized.dependencyResolution,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
  const baseDir = join(tmpdir(), 'typegpu-inspector-cache', `vite-${key}`);

  // Two live inspectors (e.g. Zed and VS Code on the same workspace) must not
  // share one Vite cache: a mid-session re-optimization in one process
  // rewrites dep chunks the other is actively serving, which surfaces as
  // crashed sessions and dropped MCP connections. Each candidate dir is
  // guarded by a pid lock; contenders fall back to a numbered sibling.
  for (let attempt = 0; attempt < MAX_CACHE_DIR_ATTEMPTS; attempt++) {
    const cacheDir = attempt === 0 ? baseDir : `${baseDir}-${attempt}`;
    await mkdir(cacheDir, { recursive: true });
    if (acquireCacheDirLock(cacheDir)) {
      return cacheDir;
    }
  }

  return mkdtemp(`${baseDir}-`);
}

const MAX_CACHE_DIR_ATTEMPTS = 4;
const ownedCacheDirLocks = new Set<string>();

function acquireCacheDirLock(cacheDir: string): boolean {
  const lockPath = `${cacheDir}.lock`;
  if (ownedCacheDirLocks.has(lockPath)) {
    return true;
  }

  for (let takeover = 0; takeover < 2; takeover++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      ownedCacheDirLocks.add(lockPath);
      if (ownedCacheDirLocks.size === 1) {
        process.once('exit', releaseOwnedCacheDirLocks);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false;
      }
      if (isLockHolderAlive(lockPath)) {
        return false;
      }
      // The holder is gone (crashed or SIGKILLed); take the lock over.
      try {
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }

  return false;
}

function isLockHolderAlive(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
  } catch {
    // Unreadable lock: treat as stale so a corrupt file cannot wedge the dir.
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else; anything else
    // (ESRCH) means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function releaseOwnedCacheDirLocks(): void {
  for (const lockPath of ownedCacheDirLocks) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort: a stale lock is recovered by the liveness check anyway.
    }
  }
  ownedCacheDirLocks.clear();
}
