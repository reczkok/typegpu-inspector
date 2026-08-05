import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type InlineConfig, type PluginOption, type ViteDevServer } from 'vite';
import ts from 'typescript';
import { SessionInfrastructureError } from '../shared.ts';
import type { StaticAssetRoute } from '../types.ts';
import type { PreparedInput } from './input.ts';
import {
  createFsModuleUrl,
  findPackageRoots,
  getPackageRoot,
  resolvePackageAliasPath,
  resolvePackagePathFrom,
} from './paths.ts';
import { buildRecordingShimModule } from './recordingShim.ts';

const INLINE_MODULE_QUERY = 'typegpu-mcp-inline';
const SHIM_MODULE_QUERY = 'typegpu-mcp-shim';
export const INSPECTOR_HARNESS_PATH = '/__typegpu_inspector__/harness.html';

// getAvailablePort() reserves a port, closes it, and Vite rebinds it with
// strictPort. Another process can take the port in between, so a bounded
// number of fresh ports is tried before giving up.
const MAX_VITE_PORT_ATTEMPTS = 4;

// TypeGPU libraries contain shader metadata that must be produced from their
// original source or prebuilt package output. Letting Vite prebundle workspace
// sources can lower constructs such as optional seed calls before unplugin-typegpu
// records TGSL metadata, which changes resolution behavior.
const TYPEGPU_OPTIMIZE_DEP_EXCLUDES = [
  'typegpu',
  'typegpu/data',
  'typegpu/std',
  'typegpu/common',
  '@typegpu/color',
  '@typegpu/geometry',
  '@typegpu/noise',
  '@typegpu/sdf',
  '@typegpu/sort',
  '@typegpu/three',
] as const;
type TypegpuVitePluginFactory = (options: { earlyPruning: boolean }) => PluginOption;
type PreparedInputProvider = PreparedInput | (() => PreparedInput);

export async function createInspectorViteServer(
  source: PreparedInputProvider,
  serverErrors: string[],
) {
  const getInput = typeof source === 'function' ? source : () => source;
  const input = getInput();
  const typegpuPath = resolvePackagePathFrom(input.cwd, 'typegpu', input.dependencyResolution);
  const typegpuDataPath = resolvePackagePathFrom(
    input.cwd,
    'typegpu/data',
    input.dependencyResolution,
  );
  const typegpuStdPath = resolvePackagePathFrom(
    input.cwd,
    'typegpu/std',
    input.dependencyResolution,
  );
  const typegpuCommonPath = resolvePackagePathFrom(
    input.cwd,
    'typegpu/common',
    input.dependencyResolution,
  );
  const modulePackageRoots = await findPackageRoots(dirname(input.modulePath));
  const typegpuPlugin = await loadTypegpuVitePlugin(input.cwd, input.dependencyResolution);
  const port = await getAvailablePort();
  const config: InlineConfig = {
    // Dependency optimization and framework resolution must happen from the
    // inspected project. Keeping the inspector package as Vite's root makes a
    // linked project's CommonJS React build bypass that project's optimizer.
    root: input.cwd,
    cacheDir: input.cacheDir,
    configFile: input.viteConfigPath ?? false,
    logLevel: 'error',
    plugins: [
      createHarnessPlugin(),
      createProjectPublicAssetPlugin(input.cwd),
      createStaticAssetPlugin(input.staticAssetRoutes),
      createInlineModulePlugin(getInput),
      createRecordingShimPlugin(typegpuPath),
      createViteErrorCapturePlugin(serverErrors),
      typegpuPlugin({ earlyPruning: false }),
    ],
    resolve: {
      alias: [
        // The recording shim must own the bare 'typegpu' specifier before any
        // other alias producer (including monorepo packageAliases, whose
        // prefix regex would otherwise match it). typegpuPath is already
        // alias-aware, so the shim wraps whatever package the project uses.
        { find: /^typegpu$/, replacement: `${typegpuPath}?${SHIM_MODULE_QUERY}` },
        ...Object.entries(input.dependencyAliases).map(([find, replacement]) => ({
          find,
          replacement,
        })),
        ...createPackageAliasEntries(input.dependencyResolution.packageAliases),
        ...createDefaultTypegpuAliasEntries({
          typegpuPath,
          typegpuDataPath,
          typegpuStdPath,
          typegpuCommonPath,
          hasTypegpuPackageAlias: Boolean(input.dependencyResolution.packageAliases?.typegpu),
        }),
      ],
      // Vite's default realpath resolution must stay on: pnpm keeps transitive
      // dependencies (e.g. @loaders.gl/schema next to @loaders.gl/obj) only as
      // siblings inside .pnpm virtual dirs, so resolving through the symlinked
      // path leaves esbuild prebundles with bare imports that later fail from
      // the tmp cache dir.
      preserveSymlinks: false,
    },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
      fs: {
        allow: withRealpaths([
          getPackageRoot(),
          input.cwd,
          dirname(input.modulePath),
          ...modulePackageRoots,
          ...(input.dependencyResolution.packageRoots ?? []),
          ...(input.dependencyResolution.nodeModulesDir
            ? [input.dependencyResolution.nodeModulesDir]
            : []),
          ...input.fsAllow,
          ...input.staticAssetRoutes.map((route) => route.directory),
          ...Object.values(input.dependencyAliases).map(aliasFsAllowPath),
          ...Object.values(input.dependencyResolution.packageAliases ?? {}).map(aliasFsAllowPath),
          dirname(typegpuPath),
        ]),
      },
    },
    optimizeDeps: {
      // The harness entry does not import the inspected app, so scan the real
      // module to discover CommonJS dependencies such as React.
      entries: [input.modulePath],
      include: collectOptimizerIncludes(input),
      exclude: [...TYPEGPU_OPTIMIZE_DEP_EXCLUDES],
    },
  };

  return createServer(config);
}

function createHarnessPlugin(): PluginOption {
  const clientUrl = createFsModuleUrl(
    resolve(getPackageRoot(), 'src/browser/client.ts'),
  );
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>TypeGPU Runtime Inspector Harness</title>
  </head>
  <body>
    <script type="module" src="${clientUrl}"></script>
  </body>
</html>`;

  return {
    name: 'typegpu-runtime-inspector-harness',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(
          request.url ?? '/',
          'http://typegpu-inspector.local',
        ).pathname;
        if (pathname !== INSPECTOR_HARNESS_PATH) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(html);
      });
    },
  };
}

function collectOptimizerIncludes(input: PreparedInput): string[] {
  const source = input.inlineCode;
  if (!source) return [];
  const scriptKind = input.modulePath.endsWith('.tsx') || input.modulePath.endsWith('.jsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    input.modulePath,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
  const imports = new Set<string>();
  const add = (specifier: string) => {
    if (
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('#') ||
      TYPEGPU_OPTIMIZE_DEP_EXCLUDES.some((excluded) =>
        specifier === excluded || specifier.startsWith(`${excluded}/`)
      )
    ) return;
    imports.add(specifier);
    if (specifier === 'react') {
      imports.add('react/jsx-runtime');
      imports.add('react/jsx-dev-runtime');
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0].text);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return [...imports];
}

export async function startInspectorViteServer(
  source: PreparedInputProvider,
  serverErrors: string[],
): Promise<ViteDevServer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_VITE_PORT_ATTEMPTS; attempt++) {
    const server = await createInspectorViteServer(source, serverErrors);
    try {
      await server.listen();
      return server;
    } catch (error) {
      await server.close().catch(() => undefined);
      if (!isAddressInUseError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw new SessionInfrastructureError(
    `Could not bind a Vite port for the TypeGPU inspector after ${MAX_VITE_PORT_ATTEMPTS} attempts.`,
    { cause: lastError },
  );
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    return true;
  }
  const message = typeof (error as Error).message === 'string' ? (error as Error).message : '';
  return message.includes('EADDRINUSE') || /Port \d+ is already in use/i.test(message);
}

function createPackageAliasEntries(packageAliases: Record<string, string> | undefined) {
  return Object.entries(packageAliases ?? {}).flatMap(([specifier, replacement]) => {
    const packageJson = resolvePackageAliasPath(
      `${specifier}/package.json`,
      packageAliases,
    );
    return [
      ...(packageJson
        ? [{
            find: new RegExp(`^${escapeRegExp(specifier)}\\/package\\.json$`),
            replacement: realpathIfExists(packageJson),
          }]
        : []),
      {
        find: new RegExp(`^${escapeRegExp(specifier)}(?=\\/|$)`),
        replacement: realpathIfExists(replacement),
      },
    ];
  });
}

function createDefaultTypegpuAliasEntries(input: {
  typegpuPath: string;
  typegpuDataPath: string;
  typegpuStdPath: string;
  typegpuCommonPath: string;
  hasTypegpuPackageAlias: boolean;
}) {
  if (input.hasTypegpuPackageAlias) {
    return [];
  }

  return [
    {
      find: /^typegpu\/data$/,
      replacement: input.typegpuDataPath,
    },
    {
      find: /^typegpu\/std$/,
      replacement: input.typegpuStdPath,
    },
    {
      find: /^typegpu\/common$/,
      replacement: input.typegpuCommonPath,
    },
    {
      find: /^typegpu$/,
      replacement: input.typegpuPath,
    },
  ];
}

/**
 * Module ids are realpath'd by Vite (preserveSymlinks: false), so every
 * fs.allow entry must admit both its symlinked and canonical form or pnpm
 * virtual-store files get served as 403s.
 */
function withRealpaths(paths: string[]): string[] {
  return [...new Set(paths.flatMap((path) => [path, realpathIfExists(path)]))];
}

function aliasFsAllowPath(path: string): string {
  try {
    const realPath = realpathIfExists(path);
    return statSync(realPath).isDirectory() ? realPath : dirname(realPath);
  } catch {
    return path;
  }
}

function realpathIfExists(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.unref();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        if (port === undefined) {
          rejectPort(new Error('Could not reserve an available Vite port.'));
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function loadTypegpuVitePlugin(
  cwd: string,
  dependencyResolution: PreparedInput['dependencyResolution'],
): Promise<TypegpuVitePluginFactory> {
  const resolvedPath = resolvePackagePathFrom(
    cwd,
    'unplugin-typegpu/vite',
    dependencyResolution,
  );
  const modulePath = preferEsmSibling(resolvedPath);

  try {
    const mod = await import(pathToFileURL(modulePath).href);
    return unwrapTypegpuVitePluginFactory(mod, modulePath);
  } catch {
    const requireFromCwd = createRequire(join(cwd, 'package.json'));
    return unwrapTypegpuVitePluginFactory(requireFromCwd(resolvedPath), resolvedPath);
  }
}

function preferEsmSibling(modulePath: string): string {
  if (modulePath.endsWith('.cjs')) {
    const esmPath = `${modulePath.slice(0, -4)}.mjs`;
    if (existsSync(esmPath)) {
      return esmPath;
    }
  }
  return modulePath;
}

function unwrapTypegpuVitePluginFactory(
  mod: unknown,
  modulePath: string,
): TypegpuVitePluginFactory {
  const directDefault = readDefaultExport(mod);
  const nestedDefault = readDefaultExport(directDefault);
  const factory = [mod, directDefault, nestedDefault].find(
    (candidate): candidate is TypegpuVitePluginFactory => typeof candidate === 'function',
  );

  if (!factory) {
    throw new Error(`unplugin-typegpu/vite did not export a Vite plugin factory: ${modulePath}`);
  }

  return factory;
}

function readDefaultExport(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('default' in value)) {
    return undefined;
  }
  return (value as { default?: unknown }).default;
}

function createViteErrorCapturePlugin(serverErrors: string[]): PluginOption {
  const capture = (error: unknown, requestUrl?: string) => {
    const message = formatViteError(error, requestUrl);
    if (!serverErrors.includes(message)) {
      serverErrors.push(message);
    }
  };

  return {
    name: 'typegpu-runtime-inspector-vite-errors',
    configureServer(server) {
      server.httpServer?.on('error', (error) => capture(error));
      return () => {
        const middleware = (
          error: unknown,
          request: { url?: string },
          _response: unknown,
          next: (error?: unknown) => void,
        ) => {
          capture(error, request.url);
          next(error);
        };
        (server.middlewares as { use(handler: typeof middleware): void }).use(middleware);
      };
    },
  };
}

function formatViteError(error: unknown, requestUrl: string | undefined): string {
  if (!error || typeof error !== 'object') {
    return `Vite transform error${requestUrl ? ` for ${requestUrl}` : ''}: ${String(error)}`;
  }

  const record = error as {
    message?: unknown;
    stack?: unknown;
    plugin?: unknown;
    id?: unknown;
    loc?: { line?: unknown; column?: unknown } | undefined;
  };
  const parts = [`Vite transform error${requestUrl ? ` for ${requestUrl}` : ''}`];
  if (typeof record.plugin === 'string') {
    parts.push(`plugin: ${record.plugin}`);
  }
  if (typeof record.id === 'string') {
    parts.push(`id: ${record.id}`);
  }
  if (
    record.loc &&
    (typeof record.loc.line === 'number' || typeof record.loc.column === 'number')
  ) {
    parts.push(`loc: ${record.loc.line ?? '?'}:${record.loc.column ?? '?'}`);
  }
  if (typeof record.message === 'string') {
    parts.push(record.message);
  } else {
    parts.push(String(error));
  }
  if (typeof record.stack === 'string') {
    parts.push(record.stack.split('\n').slice(0, 6).join('\n'));
  }
  return limitDiagnosticText(stripAnsi(parts.join('\n')));
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function limitDiagnosticText(value: string): string {
  const maxLength = 12_000;
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

export function createInlineModuleUrl(path: string): string {
  return `${createFsModuleUrl(path)}?${INLINE_MODULE_QUERY}`;
}

function createInlineModulePlugin(getInput: () => PreparedInput): PluginOption {
  return {
    name: 'typegpu-runtime-inspector-inline-module',
    enforce: 'pre',
    load(id) {
      const input = getInput();
      if (!input.inlineCode || !id.includes(`?${INLINE_MODULE_QUERY}`)) {
        return undefined;
      }

      const [rawPath] = id.split('?', 1);
      if (resolve(rawPath) !== resolve(input.modulePath)) {
        return undefined;
      }

      return input.inlineCode;
    },
  };
}

function createRecordingShimPlugin(typegpuPath: string): PluginOption {
  return {
    name: 'typegpu-runtime-inspector-recording-shim',
    enforce: 'pre',
    load(id) {
      if (!id.includes(`?${SHIM_MODULE_QUERY}`)) {
        return undefined;
      }
      const [rawPath] = id.split('?', 1);
      if (resolve(rawPath) !== resolve(typegpuPath)) {
        return undefined;
      }
      return buildRecordingShimModule(typegpuPath);
    },
  };
}

function createStaticAssetPlugin(routes: StaticAssetRoute[]): PluginOption {
  return {
    name: 'typegpu-runtime-inspector-static-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const assetPath = findStaticAssetPath(request.url ?? '/', routes);
        if (!assetPath) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', getMimeType(assetPath));
        createReadStream(assetPath)
          .on('error', () => {
            response.statusCode = 500;
            response.end();
          })
          .pipe(response);
      });
    },
  };
}

/**
 * Hosted examples commonly author assets below a deployment base
 * (`/project/assets/...`) while Vite serves the same project locally at `/`.
 * Resolve only paths that demonstrably exist in this project's public/assets
 * tree, and mark the response so the in-page ledger records the adaptation.
 */
function createProjectPublicAssetPlugin(projectRoot: string): PluginOption {
  const publicRoot = resolve(projectRoot, 'public');
  return {
    name: 'typegpu-runtime-inspector-project-public-assets',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(
          request.url ?? '/',
          'http://typegpu-inspector.local',
        ).pathname;
        const hostedAsset = /^\/[^/]+\/(assets\/.+)$/.exec(pathname)?.[1];
        if (!hostedAsset) {
          next();
          return;
        }
        const assetPath = resolve(publicRoot, hostedAsset);
        if (!isPathInside(publicRoot, assetPath)) {
          next();
          return;
        }
        try {
          if (!statSync(assetPath).isFile()) {
            next();
            return;
          }
        } catch {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', getMimeType(assetPath));
        response.setHeader('X-TypeGPU-Environment-Provider', 'project-public-prefix');
        createReadStream(assetPath)
          .on('error', () => {
            response.statusCode = 500;
            response.end();
          })
          .pipe(response);
      });
    },
  };
}

function findStaticAssetPath(requestUrl: string, routes: StaticAssetRoute[]): string | undefined {
  if (routes.length === 0) {
    return undefined;
  }

  const { pathname } = new URL(requestUrl, 'http://typegpu-inspector.local');
  for (const route of routes) {
    const relativeUrl = getRouteRelativePath(pathname, route.urlPrefix);
    if (relativeUrl === undefined) {
      continue;
    }

    const assetPath = resolve(route.directory, relativeUrl);
    if (!isPathInside(route.directory, assetPath)) {
      continue;
    }

    try {
      if (statSync(assetPath).isFile()) {
        return assetPath;
      }
    } catch {
      // Keep looking; Vite can handle the request if no static route matches.
    }
  }

  return undefined;
}

function getRouteRelativePath(pathname: string, prefix: string): string | undefined {
  if (prefix === '/') {
    return decodeURIComponent(pathname.slice(1));
  }

  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return undefined;
  }

  return decodeURIComponent(pathname.slice(prefix.length).replace(/^\/+/, ''));
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function getMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.avif':
      return 'image/avif';
    case '.bin':
      return 'application/octet-stream';
    case '.gif':
      return 'image/gif';
    case '.glb':
      return 'model/gltf-binary';
    case '.gltf':
      return 'model/gltf+json';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.mp4':
      return 'video/mp4';
    case '.npy':
      return 'application/octet-stream';
    case '.obj':
      return 'text/plain; charset=utf-8';
    case '.ogg':
      return 'audio/ogg';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.wav':
      return 'audio/wav';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}
