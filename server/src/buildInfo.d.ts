/**
 * Version strings esbuild substitutes at build time via `--define`, read from
 * the package's own package.json. Nothing in `src/` may hard-code a version:
 * a stale literal here silently points editors at the wrong npm package.
 *
 * `__TYPEGPU_INSPECTOR_VERSION__` is the `typegpu-runtime-inspector-mcp`
 * version this server expects. The monorepo releases every package in
 * lockstep from a single version bump, so the server's own version is that
 * spec; if that ever stops holding, this define needs its own source.
 *
 * `vitest.config.ts` injects the same values so unbundled test runs match the
 * shipped bundle.
 */
declare const __TYPEGPU_SERVER_VERSION__: string;
declare const __TYPEGPU_INSPECTOR_VERSION__: string;
