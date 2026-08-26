import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { InspectionTarget } from './discovery.js';
import { createInspectionDocumentHtml } from './documentFixture.js';
import type { InspectorOutput, InspectorSettings } from './protocol.js';

export class RuntimeInspectorClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private stderrTail = '';
  /** Incremented on every reset so an in-flight connect can detect it. */
  private generation = 0;
  private idleCloseTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly settings: () => InspectorSettings,
  ) {}

  public async inspect(
    modulePath: string,
    targets: InspectionTarget[],
    signal?: AbortSignal,
  ): Promise<InspectorOutput> {
    this.cancelIdleClose();
    try {
      signal?.throwIfAborted();
      const first = await this.inspectOnce(modulePath, targets, signal);
      const firstCoverage = coveredTargets(first, targets);
      if (firstCoverage.size === targets.length || targets.length === 0) {
        return first;
      }

      if (firstCoverage.size === 0) {
        // A whole batch coming back empty points at a wedged runtime
        // session. Restart it and retry the batch once.
        signal?.throwIfAborted();
        await this.resetConnection();
        signal?.throwIfAborted();
        const retry = await this.inspectOnce(modulePath, targets, signal);
        if (coveredTargets(retry, targets).size === 0) {
          const returned = describeReturnedTargets(retry);
          throw new Error(
            `Runtime inspector returned no matching target reports after one fresh-session retry. Requested: ${targets.map((target) => target.label).join(', ')}. Returned: ${returned.length > 0 ? returned.join(' | ') : '<none>'}.${envelopeFailureDetail(retry) || envelopeFailureDetail(first)} If this workspace is large, a first cold run can exceed timeoutMs; consider raising it.`,
          );
        }
        return retry;
      }

      // Partial coverage is usually structural (a target the runtime cannot
      // derive), not a session fault. Retry only the missing labels once,
      // without tearing the session down, and merge what comes back.
      const missing = targets.filter((target) => !firstCoverage.has(target.label));
      signal?.throwIfAborted();
      const retry = await this.inspectOnce(modulePath, missing, signal);
      return mergeTargetReports(first, retry);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      if (!isClosedConnectionError(error)) throw error;
      const firstFailure = errorMessage(error);
      await this.resetConnection();
      try {
        signal?.throwIfAborted();
        return await this.inspectOnce(modulePath, targets, signal);
      } catch (retryError) {
        const stderr = this.stderrTail.trim();
        throw new Error(
          `Runtime inspector connection failed after one automatic retry. First failure: ${firstFailure}. Retry: ${errorMessage(retryError)}${stderr ? `\nInspector stderr:\n${stderr}` : ''}`,
        );
      }
    }
  }

  private async inspectOnce(
    modulePath: string,
    targets: InspectionTarget[],
    signal?: AbortSignal,
  ): Promise<InspectorOutput> {
    const settings = this.settings();
    const client = await this.connect();
    let moduleText: string;
    try {
      moduleText = await readFile(modulePath, 'utf8');
    } catch (error) {
      throw new Error(
        `Could not read ${modulePath} from disk (${errorMessage(error)}). Save the file and retry the inspection.`,
      );
    }
    const result = await client.callTool(
      {
        name: 'inspect_typegpu',
        arguments: {
          target: {
            kind: 'symbols',
            modulePath,
            targets: targets.map((target) => target.selector),
            includePrivate: true,
          },
          project: {
            root: settings.projectRoot ?? this.workspaceRoot,
          },
          output: {
            timeoutMs: settings.timeoutMs,
            verbosity: 'full',
            includeWgsl: true,
            includeCalls: true,
            maxWgslBytes: settings.maxWgslBytes,
          },
          environment: {
            strictNames: settings.strictNames,
            features: settings.features,
            documentHtml: createInspectionDocumentHtml(modulePath, moduleText),
            staticAssetRoutes: inferStaticAssetRoutes(
              modulePath,
              settings.projectRoot ?? this.workspaceRoot,
            ),
            // The inspector prepends its own quiescent prologue.
            quiescent: true,
          },
        },
      },
      undefined,
      {
        ...(signal ? { signal } : {}),
        // The inspector excludes session establishment (cold Vite boot,
        // Chromium launch) from its own timeoutMs budget, so the transport
        // cap must leave room for it or first runs in large workspaces get
        // killed mid-establishment.
        timeout: settings.timeoutMs + ESTABLISHMENT_GRACE_MS,
        maxTotalTimeout: settings.timeoutMs + ESTABLISHMENT_GRACE_MS,
      },
    );

    if (isRecord(result.structuredContent)) {
      return result.structuredContent as InspectorOutput;
    }

    const content = Array.isArray(result.content) ? result.content : [];
    for (const entry of content) {
      if (!isRecord(entry) || entry.type !== 'text' || typeof entry.text !== 'string') {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(entry.text);
        if (isRecord(parsed)) return parsed as InspectorOutput;
      } catch {
        // Keep looking for a structured response.
      }
    }

    throw new Error('Runtime inspector returned no structured inspection result.');
  }

  public async close(): Promise<void> {
    this.cancelIdleClose();
    await this.resetConnection();
  }

  /**
   * Release Chromium/Vite only after the editor has had no TypeGPU document
   * open for a grace period. Reopening during the grace period stays warm.
   */
  public scheduleIdleClose(delayMs: number, onClosed?: () => void): void {
    this.cancelIdleClose();
    if (!this.client && !this.connecting) return;
    this.idleCloseTimer = setTimeout(() => {
      this.idleCloseTimer = undefined;
      void this.resetConnection().finally(onClosed);
    }, delayMs);
    this.idleCloseTimer.unref?.();
  }

  public cancelIdleClose(): void {
    if (!this.idleCloseTimer) return;
    clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = undefined;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    const generation = this.generation;
    this.connecting = (async () => {
      const settings = this.settings();
      const launch = await resolveInspectorLaunch(settings.inspectorPackage);
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        ...(launch.env ? { env: launch.env } : {}),
        cwd: settings.projectRoot ?? this.workspaceRoot,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        this.stderrTail = `${this.stderrTail}${text}`.slice(-8_000);
      });
      const client = new Client({
        name: 'typegpu-zed-language-server',
        version: __TYPEGPU_SERVER_VERSION__,
      });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      if (this.generation !== generation) {
        // The connection was reset while this connect was in flight; do not
        // resurrect it, or the child process would leak without an owner.
        await client.close().catch(() => undefined);
        throw new Error('Runtime inspector connection was reset during startup.');
      }
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (error) {
      if (this.generation === generation) {
        this.connecting = undefined;
        this.client = undefined;
      }
      throw error;
    }
  }

  private async resetConnection(): Promise<void> {
    this.generation += 1;
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    try {
      await client?.close();
    } catch {
      // A dead transport is already closed for our purposes.
    }
  }
}

function inferStaticAssetRoutes(
  modulePath: string,
  projectRoot: string,
): Array<{ urlPrefix: string; directory: string }> {
  const routes: Array<{ urlPrefix: string; directory: string }> = [];
  const candidates = [
    { urlPrefix: '/', directory: join(projectRoot, 'public') },
    {
      urlPrefix: '/TypeGPU',
      directory: join(projectRoot, 'apps', 'typegpu-docs', 'public'),
    },
  ];

  let current = dirname(modulePath);
  while (isInsideDirectory(projectRoot, current) && current !== projectRoot) {
    candidates.push({ urlPrefix: '/', directory: join(current, 'public') });
    current = dirname(current);
  }

  const seen = new Set<string>();
  for (const route of candidates) {
    if (!existsSync(route.directory)) continue;
    const key = `${route.urlPrefix}:${route.directory}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(route);
  }
  return routes;
}

function isInsideDirectory(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * npm package spec restricted to name (+ optional version/tag). Rejects
 * shell-ish input so a workspace-provided setting cannot smuggle arguments
 * into `npx`.
 */
const PACKAGE_SPEC_PATTERN =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-zA-Z0-9-._^~><=+ ]+)?$/;

export async function resolveInspectorLaunch(
  inspectorPackage: string,
): Promise<{ command: string; args: string[]; env?: Record<string, string> }> {
  if (inspectorPackage !== 'bundled') {
    if (!PACKAGE_SPEC_PATTERN.test(inspectorPackage)) {
      throw new Error(
        `initialization_options.inspectorPackage must be "bundled" or a plain npm package name, got ${JSON.stringify(inspectorPackage)}.`,
      );
    }
    return {
      command: 'npx',
      args: ['-y', inspectorPackage],
    };
  }

  const serverEntry = process.argv[1] ?? process.cwd();
  const inspectorRoot = resolve(dirname(serverEntry), '..', '..', 'inspector');
  const bin = resolve(
    inspectorRoot,
    'bin',
    'typegpu-runtime-inspector-mcp.mjs',
  );
  if (!existsSync(bin)) {
    const runtimeDir = process.env.TYPEGPU_INSPECTOR_RUNTIME_DIR;
    if (runtimeDir && isAbsolute(runtimeDir)) {
      const installedBin = await ensureInspectorRuntime(runtimeDir);
      return {
        command: process.execPath,
        args: [installedBin],
        env: { ...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
      };
    }
    // Standalone npm-published server builds have no monorepo checkout next
    // to server.cjs; launch the published runtime instead. npx caches the
    // package, and its Playwright Chromium download happens once.
    return {
      command: 'npx',
      args: ['-y', FALLBACK_INSPECTOR_SPEC],
    };
  }
  return {
    command: process.execPath,
    args: [bin],
    // When this server itself runs inside an editor's Electron-as-Node host
    // (VS Code spawns LSP servers with ELECTRON_RUN_AS_NODE=1), execPath is
    // the Electron binary. The MCP transport strips that variable from the
    // child env, so without re-adding it the child boots as a GUI app and
    // dies with "Unable to find helper app".
    env: { ...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
  };
}

// Build-time define; the inspector releases at the server's version.
const FALLBACK_INSPECTOR_VERSION = __TYPEGPU_INSPECTOR_VERSION__;
const FALLBACK_INSPECTOR_SPEC =
  `typegpu-runtime-inspector-mcp@${FALLBACK_INSPECTOR_VERSION}`;

const runtimeInstallPromises = new Map<string, Promise<string>>();

function ensureInspectorRuntime(runtimeDir: string): Promise<string> {
  const normalizedDir = resolve(runtimeDir);
  let installing = runtimeInstallPromises.get(normalizedDir);
  if (!installing) {
    installing = installInspectorRuntime(normalizedDir).catch((error) => {
      runtimeInstallPromises.delete(normalizedDir);
      throw error;
    });
    runtimeInstallPromises.set(normalizedDir, installing);
  }
  return installing;
}

async function installInspectorRuntime(runtimeDir: string): Promise<string> {
  const packageRoot = join(
    runtimeDir,
    'node_modules',
    'typegpu-runtime-inspector-mcp',
  );
  const bin = join(packageRoot, 'bin', 'typegpu-runtime-inspector-mcp.mjs');
  if (await installedRuntimeMatches(packageRoot, bin)) return bin;

  await mkdir(runtimeDir, { recursive: true });
  const releaseLock = await acquireRuntimeInstallLock(runtimeDir);
  try {
    // A second VS Code window may have completed the install while this one
    // waited for the cross-process lock.
    if (await installedRuntimeMatches(packageRoot, bin)) return bin;
    await runRuntimeInstall(runtimeDir);
    if (!(await installedRuntimeMatches(packageRoot, bin))) {
      throw new Error(
        `npm completed but ${FALLBACK_INSPECTOR_SPEC} was not installed under ${runtimeDir}.`,
      );
    }
    return bin;
  } finally {
    await releaseLock();
  }
}

async function installedRuntimeMatches(
  packageRoot: string,
  bin: string,
): Promise<boolean> {
  if (!existsSync(bin)) return false;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    );
    return isRecord(parsed) && parsed.version === FALLBACK_INSPECTOR_VERSION;
  } catch {
    return false;
  }
}

export type NpmInvocation = {
  command: string;
  args: string[];
  shell: boolean;
  source: string;
};

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  // Windows env lookup is case-insensitive.
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  return raw
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stats = statSync(candidate);
    if (!stats.isFile()) return false;
    // No execute bit on Windows.
    return platform === 'win32' ? true : (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findOnPath(
  names: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  for (const directory of pathEntries(env, platform)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Resolves npm from PATH, else `npm-cli.js` inside the Node installation. */
export function resolveNpmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NpmInvocation {
  const searched: string[] = [];

  const npmNames = platform === 'win32'
    ? ['npm.cmd', 'npm.exe', 'npm']
    : ['npm'];
  const onPath = findOnPath(npmNames, env, platform);
  if (onPath) {
    return {
      command: onPath,
      args: [],
      shell: platform === 'win32' && onPath.toLowerCase().endsWith('.cmd'),
      source: `npm on PATH (${onPath})`,
    };
  }
  searched.push(`${npmNames.join(' / ')} on PATH`);

  const configuredNode = env.TYPEGPU_INSPECTOR_NODE;
  const nodeNames = platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  const node = configuredNode && configuredNode.trim() !== ''
    ? configuredNode
    : findOnPath(nodeNames, env, platform);
  if (node) {
    // realpath first: the node on a GUI PATH is usually a version-manager shim.
    const nodeDirectory = dirname(realpathOr(node));
    const cli = platform === 'win32'
      ? join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) {
      return {
        command: node,
        args: [cli],
        shell: false,
        source: `npm-cli.js beside ${node}`,
      };
    }
    searched.push(cli);
  } else {
    searched.push(`${nodeNames.join(' / ')} on PATH or $TYPEGPU_INSPECTOR_NODE`);
  }

  throw new Error(
    `Could not find npm to install ${FALLBACK_INSPECTOR_SPEC}. Searched: ${searched.join('; ')}. Run "TypeGPU Inspector: Run Environment Doctor" to see the environment this server was launched with, or set TYPEGPU_INSPECTOR_NODE to an absolute path to a Node.js binary whose installation includes npm.`,
  );
}

async function runRuntimeInstall(runtimeDir: string): Promise<void> {
  const env = getDefaultEnvironment();
  const npm = resolveNpmInvocation(env);
  const args = [
    ...npm.args,
    'install',
    '--no-save',
    '--package-lock=false',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--prefix',
    runtimeDir,
    FALLBACK_INSPECTOR_SPEC,
  ];
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn(npm.command, args, {
      cwd: runtimeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(npm.shell ? { shell: true } : {}),
    });
    let tail = '';
    const collect = (chunk: unknown) => {
      tail = `${tail}${String(chunk)}`.slice(-8_000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', rejectInstall);
    child.on('close', (code) => {
      if (code === 0) {
        resolveInstall();
      } else {
        rejectInstall(
          new Error(
            `Could not install ${FALLBACK_INSPECTOR_SPEC} using ${npm.source} (npm exited ${code}).${
              /ETARGET|notarget|E404/.test(tail)
                ? ` The npm registry has no ${FALLBACK_INSPECTOR_SPEC} yet; the runtime package is published alongside each editor release, so retry in a few minutes or set typegpuInspector.inspectorPackage to a published version.`
                : ''
            }${tail ? `\n${tail}` : ''}`,
          ),
        );
      }
    });
  });
}

async function acquireRuntimeInstallLock(
  runtimeDir: string,
): Promise<() => Promise<void>> {
  const lockPath = join(runtimeDir, '.install.lock');
  const deadline = Date.now() + RUNTIME_INSTALL_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await runtimeInstallLockOwnerAlive(lockPath))) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error(
    `Timed out waiting for another editor window to install ${FALLBACK_INSPECTOR_SPEC}.`,
  );
}

async function runtimeInstallLockOwnerAlive(lockPath: string): Promise<boolean> {
  try {
    const pid = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const RUNTIME_INSTALL_LOCK_TIMEOUT_MS = 600_000;


function isClosedConnectionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('connection closed') ||
    message.includes('transport closed') ||
    message.includes('server disconnected') ||
    message.includes('-32000');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coveredTargets(
  output: InspectorOutput,
  targets: InspectionTarget[],
): Set<string> {
  const returned = new Set(returnedTargetLabels(output));
  return new Set(
    targets
      .map((target) => target.label)
      .filter((label) => returned.has(label)),
  );
}

/** Merge a targeted follow-up pass into the primary output. */
function mergeTargetReports(
  first: InspectorOutput,
  retry: InspectorOutput,
): InspectorOutput {
  const byLabel = new Map(
    (first.targets ?? []).map((report) => [report.label, report]),
  );
  for (const report of retry.targets ?? []) byLabel.set(report.label, report);
  return {
    ...first,
    targets: [...byLabel.values()],
    calls: [...(first.calls ?? []), ...(retry.calls ?? [])],
    warnings: mergeUnique(first.warnings, retry.warnings),
    pageErrors: mergeUnique(first.pageErrors, retry.pageErrors),
  };
}

function mergeUnique(
  left: string[] | undefined,
  right: string[] | undefined,
): string[] {
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}

function returnedTargetLabels(output: InspectorOutput): string[] {
  return (output.targets ?? [])
    .map((target) => target.label)
    .filter((label): label is string => typeof label === 'string');
}

// Must exceed the inspector's own MAX_SESSION_ESTABLISHMENT_MS (240s) so the
// transport never kills a request the inspector still considers on-budget.
// Also covers the first-run Chromium download at ~5 Mbit/s.
const ESTABLISHMENT_GRACE_MS = 900_000;

// First contact with an npx-launched inspector can include downloading the
// package and its Playwright Chromium, which takes minutes on a fresh
// machine. The SDK's 60s default initialize timeout guarantees failure there.
const CONNECT_TIMEOUT_MS = 600_000;

/** Surfaces the envelope's own failure evidence when no target reports came back. */
function envelopeFailureDetail(output: InspectorOutput): string {
  const parts: string[] = [];
  const error = output.error;
  if (typeof error === 'string') {
    parts.push(error);
  } else if (isRecord(error) && typeof error.message === 'string') {
    parts.push(error.message);
  }
  parts.push(...(output.warnings ?? []));
  parts.push(...(output.pageErrors ?? []).slice(0, 2));
  for (const entry of (output.console ?? []).slice(0, 20)) {
    if (entry.type === 'error' && typeof entry.text === 'string') {
      parts.push(entry.text);
      if (parts.length > 6) break;
    }
  }
  return parts.length > 0 ? ` Runtime detail: ${parts.join(' | ').slice(0, 600)}` : '';
}

function describeReturnedTargets(output: InspectorOutput): string[] {
  return (output.targets ?? []).map((target) => {
    const error = readErrorMessage(target.error);
    const diagnostic = target.diagnostics?.[0];
    const detail = error ??
      (diagnostic
        ? `${diagnostic.message}${diagnostic.hint ? ` — ${diagnostic.hint}` : ''}`
        : undefined);
    return detail ? `${target.label}: ${detail}` : target.label;
  });
}

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (!isRecord(error)) return undefined;
  if (typeof error.message === 'string') return error.message;
  return readErrorMessage(error.cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
