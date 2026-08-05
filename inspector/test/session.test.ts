import { afterEach, describe, expect, it } from 'vitest';
import {
  closeAllInspectorSessions,
  createInspectorSessionKey,
  getInspectorSessionCount,
  inspectorSessionTestHooks,
} from '../src/inspect/session.ts';
import type { PreparedInput } from '../src/inspect/input.ts';
import { SessionInfrastructureError } from '../src/shared.ts';

describe('inspector session identity', () => {
  it('reuses one project session across modules and source revisions', () => {
    const first = preparedInput({
      modulePath: '/workspace/src/first.ts',
      inlineCode: 'export const revision = 1;',
    });
    const second = preparedInput({
      modulePath: '/workspace/examples/second.ts',
      inlineCode: 'export const revision = 2;',
    });

    expect(createInspectorSessionKey(first)).toBe(
      createInspectorSessionKey(second),
    );
  });

  it('separates sessions when runtime configuration changes', () => {
    const base = preparedInput();
    const changedAlias = preparedInput({
      dependencyAliases: { typegpu: '/workspace/packages/typegpu/src' },
    });
    const changedRoutes = preparedInput({
      staticAssetRoutes: [{
        urlPrefix: '/assets',
        directory: '/workspace/public',
      }],
    });

    expect(createInspectorSessionKey(base)).not.toBe(
      createInspectorSessionKey(changedAlias),
    );
    expect(createInspectorSessionKey(base)).not.toBe(
      createInspectorSessionKey(changedRoutes),
    );
  });

  it('scopes external modules to their containing directory', () => {
    const first = preparedInput({
      modulePath: '/outside/one/probe.ts',
    });
    const second = preparedInput({
      modulePath: '/outside/two/probe.ts',
    });

    expect(createInspectorSessionKey(first)).not.toBe(
      createInspectorSessionKey(second),
    );
  });
});

describe('inspector session lease', () => {
  afterEach(async () => {
    await closeAllInspectorSessions();
  });

  it('keeps the queue usable when a lease wait times out', async () => {
    const session = inspectorSessionTestHooks.createSession('lease-timeout');
    const held = await session.lease(preparedInput());

    const timedOut = await session
      .lease(preparedInput(), { timeoutMs: 10 })
      .catch((error: unknown) => error);

    expect(timedOut).toBeInstanceOf(SessionInfrastructureError);
    expect((timedOut as SessionInfrastructureError).invalidateSession).toBe(false);
    expect(session.activeRuns).toBe(1);

    await held.release();
    const next = await withTestTimeout(
      session.lease(preparedInput(), { timeoutMs: 1_000 }),
    );
    expect(session.activeRuns).toBe(1);
    await next.release();
    expect(session.activeRuns).toBe(0);
  });

  it('does not wedge later leases when several waiters are abandoned', async () => {
    const session = inspectorSessionTestHooks.createSession('lease-abandoned');
    const held = await session.lease(preparedInput());

    const abandoned = await Promise.all([
      session.lease(preparedInput(), { timeoutMs: 10 }).catch((error: unknown) => error),
      session.lease(preparedInput(), { timeoutMs: 10 }).catch((error: unknown) => error),
    ]);
    expect(abandoned.every((error) => error instanceof SessionInfrastructureError)).toBe(true);

    await held.release();
    const first = await withTestTimeout(session.lease(preparedInput(), { timeoutMs: 1_000 }));
    await first.release();
    const second = await withTestTimeout(session.lease(preparedInput(), { timeoutMs: 1_000 }));
    await second.release();
    expect(session.activeRuns).toBe(0);
  });

  it('releases the queue promptly when a waiting lease is aborted', async () => {
    const session = inspectorSessionTestHooks.createSession('lease-abort');
    const held = await session.lease(preparedInput());
    const controller = new AbortController();
    const pending = session.lease(preparedInput(), {
      timeoutMs: 60_000,
      signal: controller.signal,
    });

    controller.abort();
    const aborted = await pending.catch((error: unknown) => error);
    expect((aborted as Error).name).toBe('AbortError');
    expect(session.activeRuns).toBe(1);

    await held.release();
    const next = await withTestTimeout(session.lease(preparedInput(), { timeoutMs: 1_000 }));
    await next.release();
    expect(session.activeRuns).toBe(0);
  });

  it('self-releases a lease requested with an already aborted signal', async () => {
    const session = inspectorSessionTestHooks.createSession('lease-pre-abort');
    const controller = new AbortController();
    controller.abort();

    const aborted = await session
      .lease(preparedInput(), { signal: controller.signal })
      .catch((error: unknown) => error);

    expect((aborted as Error).name).toBe('AbortError');
    expect(session.activeRuns).toBe(0);

    const next = await withTestTimeout(session.lease(preparedInput(), { timeoutMs: 1_000 }));
    await next.release();
    expect(session.activeRuns).toBe(0);
  });

  it('rejects a lease on a closed session without blocking the queue', async () => {
    const session = inspectorSessionTestHooks.createSession('lease-closed');
    await session.close();

    const closed = await session
      .lease(preparedInput(), { timeoutMs: 1_000 })
      .catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(SessionInfrastructureError);

    const second = await session
      .lease(preparedInput(), { timeoutMs: 1_000 })
      .catch((error: unknown) => error);
    expect(second).toBeInstanceOf(SessionInfrastructureError);
  });
});

describe('inspector session pruning', () => {
  afterEach(async () => {
    await closeAllInspectorSessions();
  });

  it('keeps reserved sessions out of the LRU prune', async () => {
    const sessions = ['oldest', 'older', 'newer', 'newest'].map((key, index) => {
      const session = inspectorSessionTestHooks.createSession(`prune-${key}`);
      session.lastUsedAt = 1_000 + index;
      inspectorSessionTestHooks.register(session);
      return session;
    });
    const [oldest, older, newer, newest] = sessions;

    // Reserved between acquire and lease: pruning must skip it.
    oldest!.reserve();
    await inspectorSessionTestHooks.prune();

    expect(getInspectorSessionCount()).toBe(3);
    expect(oldest!.isUsable()).toBe(true);
    expect(older!.isUsable()).toBe(false);
    expect(newer!.isUsable()).toBe(true);
    expect(newest!.isUsable()).toBe(true);
  });

  it('keeps leased sessions and the kept session out of the LRU prune', async () => {
    const sessions = ['a', 'b', 'c', 'd', 'e'].map((key, index) => {
      const session = inspectorSessionTestHooks.createSession(`prune-lease-${key}`);
      session.lastUsedAt = 2_000 + index;
      inspectorSessionTestHooks.register(session);
      return session;
    });
    const [oldest, older, newer] = sessions;

    const lease = await oldest!.lease(preparedInput());
    await inspectorSessionTestHooks.prune(older);

    expect(getInspectorSessionCount()).toBe(3);
    expect(oldest!.isUsable()).toBe(true);
    expect(older!.isUsable()).toBe(true);
    expect(newer!.isUsable()).toBe(false);

    await lease.release();
    expect(oldest!.activeRuns).toBe(0);
  });
});

async function withTestTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Lease did not settle within ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function preparedInput(
  overrides: Partial<PreparedInput> = {},
): PreparedInput {
  return {
    cwd: '/workspace',
    exportName: 'inspect',
    timeoutMs: 30_000,
    features: [],
    strictNames: true,
    autoBind: true,
    reuseBrowser: true,
    diagnosticsOnly: false,
    sourceKind: 'inlineCode',
    modulePath: '/workspace/src/probe.ts',
    moduleUrl: '/@fs/workspace/src/probe.ts?typegpu-mcp-inline',
    inlineCode: 'export async function inspect() { return []; }',
    dependencyAliases: {},
    fsAllow: [],
    staticAssetRoutes: [],
    dependencyResolution: {},
    cacheDir: '/tmp/typegpu-test-cache',
    cleanupDirs: [],
    ...overrides,
  };
}
