export const DEFAULT_INSPECTION_TIMEOUT_MS = 15_000;

/**
 * Property under which a generated symbols module attaches its binding
 * sources (setup roots + inspected module namespace) to the returned targets
 * array, so the browser client can hand them to slot auto-binding. A property
 * rather than a separate export: the array crosses no serialization boundary,
 * and the generated module's export surface stays a single inspect function.
 */
export const TYPEGPU_MCP_BINDING_SOURCES_PROP = '__typegpuMcpBindingSources';
/** `[pasted, real]` export pairs a private-inspection wrapper attaches, see `ProviderContext.twins`. */
export const TYPEGPU_MCP_TWINS_PROP = '__typegpuMcpTwins';

// Establishing a reusable session (cold Vite boot, Chromium launch, dependency
// optimization) is a one-time cost that would otherwise consume the whole
// inspection budget. Time spent establishing a session is added back to the
// caller deadline, so timeoutMs keeps describing the inspection itself while
// the total stays bounded by timeoutMs + this constant. A first cold run in a
// large workspace routinely needs minutes (dependency optimization plus the
// first transform of the whole typegpu source, which is excluded from
// prebundling), so this allowance must be generous — raising timeoutMs is not
// a substitute, because establishment does not scale with the caller's budget.
export const MAX_SESSION_ESTABLISHMENT_MS = 240_000;

/**
 * Raised at known infrastructure failure points (closed session, exhausted
 * Vite ports, a lease that could not be obtained). Callers use it to decide
 * whether an inspection can be retried on a fully isolated path instead of
 * matching substrings of error messages.
 */
export class SessionInfrastructureError extends Error {
  public readonly invalidateSession: boolean;

  public constructor(
    message: string,
    options: { cause?: unknown; invalidateSession?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'SessionInfrastructureError';
    this.invalidateSession = options.invalidateSession ?? true;
  }
}

/**
 * Vite's dependency optimizer could not prebundle something the module
 * imports. The server that hit it never serves that module, so the session
 * owning it is retired, and no isolated retry follows: the same build fails
 * the same way.
 */
export class DependencyOptimizationError extends Error {
  public constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'DependencyOptimizationError';
  }
}

export function createAbortError(reason = 'The TypeGPU inspection was cancelled.'): Error {
  const error = new Error(reason);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  try {
    const property = value[key];
    return typeof property === 'string' ? property : undefined;
  } catch {
    return undefined;
  }
}

export function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
