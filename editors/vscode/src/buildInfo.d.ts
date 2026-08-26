/**
 * Version string esbuild substitutes at build time via `--define`, read from
 * this package's own package.json (see the `build` script).
 *
 * The monorepo releases the extension, the language server, and the runtime
 * inspector in lockstep from a single version bump, so the extension version
 * is also the `typegpu-runtime-inspector-mcp` spec the doctor command must
 * probe. It has to match the server's FALLBACK_INSPECTOR_SPEC, because npx
 * caches per spec string.
 */
declare const __TYPEGPU_INSPECTOR_VERSION__: string;
