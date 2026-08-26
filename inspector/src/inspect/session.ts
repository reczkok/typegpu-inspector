import { statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type {
  Browser,
  BrowserContext,
} from 'playwright-chromium';
import type { ViteDevServer } from 'vite';
import {
  createAbortError,
  SessionInfrastructureError,
} from '../shared.ts';
import {
  getSharedBrowser,
  INSPECTOR_BROWSER_CONTEXT_OPTIONS,
} from './browser.ts';
import type { PreparedInput } from './input.ts';
import { startInspectorViteServer } from './vite.ts';

const MAX_INSPECTOR_SESSIONS = 3;

type MutableInput = {
  current: PreparedInput;
};

type SessionCreationTimings = {
  startViteMs: number;
  acquireBrowserMs: number;
};

export type InspectorSessionLeaseOptions = {
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type InspectorSessionLease = {
  server: ViteDevServer;
  browser: Browser;
  context: BrowserContext;
  moduleUrl: string;
  serverErrors: string[];
  release(): Promise<void>;
};

export type AcquiredInspectorSession = {
  session: InspectorSession;
  reused: boolean;
  timings: SessionCreationTimings;
  cleanupDirs: string[];
  /** Drops the acquisition reservation that keeps this session out of the LRU prune. */
  release(): void;
};

export class InspectorSession {
  public lastUsedAt = Date.now();
  public activeRuns = 0;
  public reservations = 0;

  private revision = 0;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly fileFingerprints = new Map<string, string>();

  public constructor(
    public readonly key: string,
    public readonly server: ViteDevServer,
    public readonly browser: Browser,
    public readonly context: BrowserContext,
    private readonly input: MutableInput,
    private readonly serverErrors: string[],
    private readonly cleanupDirs: string[],
  ) {}

  public isUsable(): boolean {
    return !this.closed && this.browser.isConnected();
  }

  public isBusy(): boolean {
    return this.activeRuns > 0 || this.reservations > 0;
  }

  public reserve(): void {
    this.reservations++;
  }

  public releaseReservation(): void {
    if (this.reservations > 0) {
      this.reservations--;
    }
  }

  public async lease(
    input: PreparedInput,
    options: InspectorSessionLeaseOptions = {},
  ): Promise<InspectorSessionLease> {
    const previous = this.queue;
    let unlock = () => {};
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.queue = previous.then(() => gate, () => gate);

    try {
      await waitForQueueSlot(previous, options);
    } catch (error) {
      // The gate was already chained onto the queue, so it must be opened here
      // or every later lease would wait on an owner that never existed.
      unlock();
      throw error;
    }

    if (!this.isUsable()) {
      unlock();
      throw new SessionInfrastructureError('Reusable TypeGPU inspector session is closed.');
    }

    this.activeRuns++;
    this.lastUsedAt = Date.now();
    this.input.current = input;
    this.serverErrors.length = 0;
    this.invalidateChangedModules();
    this.server.moduleGraph.onFileChange(input.modulePath);
    this.revision++;

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      this.captureModuleFingerprints();
      this.activeRuns--;
      this.lastUsedAt = Date.now();
      unlock();
      await pruneInspectorSessions(this);
    };

    // The owner may have given up while the queue was draining; an abandoned
    // lease has to release itself instead of holding the session forever.
    if (options.signal?.aborted) {
      await release();
      throw createAbortError();
    }

    return {
      server: this.server,
      browser: this.browser,
      context: this.context,
      moduleUrl: appendRevision(input.moduleUrl, this.revision),
      serverErrors: this.serverErrors,
      release,
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    await this.server.close().catch(() => undefined);
    for (const directory of this.cleanupDirs) {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  private invalidateChangedModules(): void {
    for (const file of this.server.moduleGraph.fileToModulesMap.keys()) {
      const next = fileFingerprint(file);
      const previous = this.fileFingerprints.get(file);
      if (next === undefined) {
        if (previous !== undefined) {
          this.server.moduleGraph.onFileDelete(file);
          this.fileFingerprints.delete(file);
        }
        continue;
      }
      if (previous !== undefined && previous !== next) {
        this.server.moduleGraph.onFileChange(file);
      }
      this.fileFingerprints.set(file, next);
    }
  }

  private captureModuleFingerprints(): void {
    for (const file of this.server.moduleGraph.fileToModulesMap.keys()) {
      const fingerprint = fileFingerprint(file);
      if (fingerprint !== undefined) {
        this.fileFingerprints.set(file, fingerprint);
      }
    }
  }
}

async function waitForQueueSlot(
  previous: Promise<void>,
  options: InspectorSessionLeaseOptions,
): Promise<void> {
  const settled = previous.catch(() => undefined);
  if (options.timeoutMs === undefined && !options.signal) {
    await settled;
    return;
  }

  await new Promise<void>((resolveSlot, rejectSlot) => {
    const { signal, timeoutMs } = options;
    let done = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      settle();
    };
    const onAbort = () => finish(() => rejectSlot(createAbortError()));

    if (signal?.aborted) {
      finish(() => rejectSlot(createAbortError()));
      return;
    }
    signal?.addEventListener('abort', onAbort);
    if (timeoutMs !== undefined) {
      timeout = setTimeout(
        () =>
          finish(() =>
            rejectSlot(
              new SessionInfrastructureError(
                `Timed out after ${timeoutMs}ms while waiting for the reusable TypeGPU inspector session.`,
                // The session itself is healthy, just busy: fall back to an
                // isolated run instead of tearing down a peer's session.
                { invalidateSession: false },
              ),
            ),
          ),
        Math.max(timeoutMs, 0),
      );
    }
    void settled.then(() => finish(resolveSlot));
  });
}

const sessions = new Map<string, Promise<InspectorSession>>();

export async function acquireInspectorSession(
  input: PreparedInput,
): Promise<AcquiredInspectorSession> {
  const key = createInspectorSessionKey(input);
  let promise = sessions.get(key);
  let reused = Boolean(promise);
  let timings: SessionCreationTimings = {
    startViteMs: 0,
    acquireBrowserMs: 0,
  };

  if (promise) {
    const existing = await promise.catch(() => undefined);
    if (!existing?.isUsable()) {
      sessions.delete(key);
      await existing?.close();
      promise = undefined;
      reused = false;
    }
  }

  if (!promise) {
    const created = createInspectorSession(key, input);
    promise = created.then((result) => {
      timings = result.timings;
      return result.session;
    });
    sessions.set(key, promise);
    promise.catch(() => {
      if (sessions.get(key) === promise) {
        sessions.delete(key);
      }
    });
  }

  const session = await promise;
  session.lastUsedAt = Date.now();
  // Reserve before pruning so the session cannot be closed between this
  // acquisition and the lease that follows it.
  session.reserve();
  let reservationReleased = false;
  try {
    await pruneInspectorSessions(session);
  } catch (error) {
    session.releaseReservation();
    throw error;
  }

  return {
    session,
    reused,
    timings,
    cleanupDirs: reused ? input.cleanupDirs : [],
    release: () => {
      if (reservationReleased) return;
      reservationReleased = true;
      session.releaseReservation();
    },
  };
}

export async function invalidateInspectorSession(input: PreparedInput): Promise<void> {
  const key = createInspectorSessionKey(input);
  const promise = sessions.get(key);
  if (!promise) return;
  sessions.delete(key);
  const session = await promise.catch(() => undefined);
  await session?.close();
}

export async function closeAllInspectorSessions(): Promise<void> {
  const pending = [...sessions.values()];
  sessions.clear();
  const resolved = await Promise.all(pending.map((promise) =>
    promise.catch(() => undefined)));
  await Promise.all(resolved.map((session) => session?.close()));
}

export function getInspectorSessionCount(): number {
  return sessions.size;
}

export function createInspectorSessionKey(input: PreparedInput): string {
  const moduleRelative = relative(input.cwd, input.modulePath);
  const moduleScope = moduleRelative === '' ||
      (!moduleRelative.startsWith('..') && !moduleRelative.startsWith('/'))
    ? '<cwd>'
    : dirname(input.modulePath);

  return stableSerialize({
    cwd: input.cwd,
    moduleScope,
    viteConfigPath: input.viteConfigPath,
    dependencyAliases: input.dependencyAliases,
    dependencyResolution: input.dependencyResolution,
    fsAllow: [...input.fsAllow].sort(),
    staticAssetRoutes: [...input.staticAssetRoutes]
      .map((route) => ({
        urlPrefix: route.urlPrefix,
        directory: route.directory,
      }))
      .sort((left, right) =>
        left.urlPrefix.localeCompare(right.urlPrefix) ||
        left.directory.localeCompare(right.directory)),
  });
}

async function createInspectorSession(
  key: string,
  input: PreparedInput,
): Promise<{
  session: InspectorSession;
  timings: SessionCreationTimings;
}> {
  const inputRef: MutableInput = { current: input };
  const serverErrors: string[] = [];
  const viteStartedAt = performance.now();
  const server = await startInspectorViteServer(
    () => inputRef.current,
    serverErrors,
  );
  const startViteMs = roundTiming(performance.now() - viteStartedAt);

  const browserStartedAt = performance.now();
  try {
    const browser = await getSharedBrowser();
    const context = await browser.newContext(INSPECTOR_BROWSER_CONTEXT_OPTIONS);
    return {
      session: new InspectorSession(
        key,
        server,
        browser,
        context,
        inputRef,
        serverErrors,
        input.cleanupDirs,
      ),
      timings: {
        startViteMs,
        acquireBrowserMs: roundTiming(performance.now() - browserStartedAt),
      },
    };
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

async function pruneInspectorSessions(
  keep?: InspectorSession,
): Promise<void> {
  while (sessions.size > MAX_INSPECTOR_SESSIONS) {
    const candidates = await Promise.all(
      [...sessions.entries()].map(async ([key, promise]) => ({
        key,
        session: await promise.catch(() => undefined),
      })),
    );
    const oldest = candidates
      .filter(({ session }) =>
        session &&
        session !== keep &&
        !session.isBusy())
      .sort((left, right) =>
        (left.session?.lastUsedAt ?? 0) - (right.session?.lastUsedAt ?? 0))[0];
    if (!oldest?.session) return;
    sessions.delete(oldest.key);
    await oldest.session.close();
  }
}

/**
 * Test hooks for the session lifecycle. They build sessions backed by stubs so
 * the lease mutex and the LRU refcount can be exercised without booting Vite or
 * Chromium.
 */
export const inspectorSessionTestHooks = {
  createSession(key = `test-session-${sessions.size}`): InspectorSession {
    const server = {
      moduleGraph: {
        fileToModulesMap: new Map<string, unknown>(),
        onFileChange() {},
        onFileDelete() {},
      },
      close: async () => undefined,
    } as unknown as ViteDevServer;
    const browser = {
      isConnected: () => true,
      close: async () => undefined,
    } as unknown as Browser;
    const context = {
      close: async () => undefined,
    } as unknown as BrowserContext;

    return new InspectorSession(
      key,
      server,
      browser,
      context,
      { current: undefined as unknown as PreparedInput },
      [],
      [],
    );
  },
  register(session: InspectorSession): void {
    sessions.set(session.key, Promise.resolve(session));
  },
  prune(keep?: InspectorSession): Promise<void> {
    return pruneInspectorSessions(keep);
  },
};

function appendRevision(moduleUrl: string, revision: number): string {
  const separator = moduleUrl.includes('?') ? '&' : '?';
  return `${moduleUrl}${separator}typegpu-session=${revision}`;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function roundTiming(value: number): number {
  return Math.round(value * 10) / 10;
}

function fileFingerprint(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.mtimeNs}:${stats.size}`;
  } catch {
    return undefined;
  }
}
