import { createHash } from 'node:crypto';
import { dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  discoverTypeGpuModule,
  type DiscoveredModule,
  type DiscoveredSymbol,
} from './discovery.js';

/**
 * A shader function declared in a module the inspected file imports
 * (directly or through other imports). The runtime's statement map names
 * such helpers exactly; this is how the mapper finds their authored bodies.
 */
export type ExternalShaderSymbol = {
  symbol: DiscoveredSymbol;
  fileName: string;
  uri: string;
  /** Identifier the entry module refers to it by, when it imports it directly. */
  callName?: string;
};

export type ModuleGraphOptions = {
  /** Text of a file, when the editor holds a fresher copy than disk. */
  readText?: (fileName: string) => string | undefined;
  maxModules?: number;
  maxDepth?: number;
};

const DEFAULT_MAX_MODULES = 64;
const DEFAULT_MAX_DEPTH = 4;
const MODULE_CACHE_LIMIT = 256;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

type CachedModule = { hash: string; module: DiscoveredModule };
const moduleCache = new Map<string, CachedModule>();

type CachedOptions = { modifiedAt: number; options: ts.CompilerOptions };
const optionsCache = new Map<string, CachedOptions>();

/**
 * Walks the import graph from `entry` (breadth first, bounded) and returns
 * every shader function declared in the imported modules.
 */
export function collectImportedShaderSymbols(
  entryFileName: string,
  entry: DiscoveredModule,
  options: ModuleGraphOptions = {},
): ExternalShaderSymbol[] {
  const maxModules = options.maxModules ?? DEFAULT_MAX_MODULES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const visited = new Set<string>([entryFileName]);
  const queue: { fileName: string; module: DiscoveredModule; depth: number }[] = [
    { fileName: entryFileName, module: entry, depth: 0 },
  ];
  const directAliases = new Map<string, Map<string, string>>();
  const symbols: ExternalShaderSymbol[] = [];

  while (queue.length > 0 && visited.size <= maxModules) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const edge of current.module.imports) {
      const resolved = resolveImport(edge.specifier, current.fileName);
      if (!resolved) continue;
      if (current.depth === 0 && edge.bindings) {
        const aliases = directAliases.get(resolved) ?? new Map<string, string>();
        for (const binding of edge.bindings) aliases.set(binding.imported, binding.local);
        directAliases.set(resolved, aliases);
      }
      if (visited.has(resolved)) continue;
      if (visited.size >= maxModules) break;
      visited.add(resolved);
      const module = loadModule(resolved, options.readText);
      if (!module) continue;
      const uri = pathToFileURL(resolved).href;
      const aliases = directAliases.get(resolved);
      for (const symbol of module.symbols) {
        if ((symbol.shaderBodies?.length ?? 0) === 0) continue;
        const callName = aliases?.get(symbol.name);
        symbols.push({
          symbol,
          fileName: resolved,
          uri,
          ...(callName ? { callName } : {}),
        });
      }
      queue.push({ fileName: resolved, module, depth: current.depth + 1 });
    }
  }
  return symbols;
}

/** Path of the source module `specifier` names from `fromFileName`; packages resolve to nothing. */
export function resolveImport(specifier: string, fromFileName: string): string | undefined {
  if (specifier.startsWith('data:') || specifier.startsWith('node:')) return undefined;
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    fromFileName,
    compilerOptionsFor(fromFileName),
    ts.sys,
  );
  if (!resolvedModule || resolvedModule.isExternalLibraryImport) return undefined;
  const fileName = resolvedModule.resolvedFileName;
  if (fileName.includes('/node_modules/')) return undefined;
  if (!SOURCE_EXTENSIONS.has(extname(fileName)) || fileName.endsWith('.d.ts')) return undefined;
  return fileName;
}

function loadModule(
  fileName: string,
  readText: ModuleGraphOptions['readText'],
): DiscoveredModule | undefined {
  const text = readText?.(fileName) ?? ts.sys.readFile(fileName);
  if (text === undefined) return undefined;
  const hash = createHash('sha1').update(text).digest('hex');
  const cached = moduleCache.get(fileName);
  if (cached && cached.hash === hash) return cached.module;
  const module = discoverTypeGpuModule(fileName, text);
  moduleCache.delete(fileName);
  moduleCache.set(fileName, { hash, module });
  if (moduleCache.size > MODULE_CACHE_LIMIT) {
    moduleCache.delete(moduleCache.keys().next().value!);
  }
  return module;
}

/**
 * The project's compiler options (for `paths`, `baseUrl`, resolution mode)
 * without enumerating its files. Bundler resolution is the default: it
 * accepts the `.ts` and `.js` specifier styles Vite projects use.
 */
function compilerOptionsFor(fileName: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(dirname(fileName), ts.sys.fileExists);
  const fallback: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    allowJs: true,
  };
  if (!configPath) return fallback;
  const modifiedAt = ts.sys.getModifiedTime?.(configPath)?.getTime() ?? 0;
  const cached = optionsCache.get(configPath);
  if (cached && cached.modifiedAt === modifiedAt) return cached.options;
  const parsed = readCompilerOptions(configPath);
  const bundlerLike = parsed.moduleResolution === ts.ModuleResolutionKind.Bundler ||
    parsed.moduleResolution === ts.ModuleResolutionKind.Node16 ||
    parsed.moduleResolution === ts.ModuleResolutionKind.NodeNext;
  const options: ts.CompilerOptions = {
    ...parsed,
    ...(bundlerLike ? {} : { moduleResolution: ts.ModuleResolutionKind.Bundler }),
    allowImportingTsExtensions: true,
    allowJs: true,
  };
  optionsCache.set(configPath, { modifiedAt, options });
  return options;
}

function readCompilerOptions(configPath: string): ts.CompilerOptions {
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (!config) return {};
  // `readDirectory` is stubbed so `extends`/`paths` resolve without globbing
  // the project's include patterns.
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: () => [],
  };
  return ts.parseJsonConfigFileContent(config, host, dirname(configPath), undefined, configPath)
    .options;
}
