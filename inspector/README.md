# TypeGPU Runtime Inspector MCP

A local stdio MCP server that validates TypeGPU code in Chromium with WebGPU.
It loads a module through Vite, creates a browser `GPUDevice`, and reports
generated WGSL, shader compilation messages, WebGPU validation errors, bind
group layout stats, console and page errors, and recorded GPU calls.

Inspections reuse a bounded Vite/Chromium session per workspace and
configuration. Every request still gets a fresh page and JavaScript realm.

## Setup

Run from the client you want to configure:

```sh
npx typegpu-runtime-inspector-mcp@latest setup codex
npx typegpu-runtime-inspector-mcp@latest setup claude
npx typegpu-runtime-inspector-mcp@latest setup opencode
npx typegpu-runtime-inspector-mcp@latest setup zed
npx typegpu-runtime-inspector-mcp@latest setup all
```

`setup all` configures every supported client found on `PATH`. Each command
registers a server named `typegpu_inspector`, pinned to the package version
that performed the setup. `setup zed` adds a `context_servers` entry to Zed's
`settings.json` without disturbing comments; the TypeGPU Inspector Zed
extension registers the same server on its own.

An existing `typegpu_inspector` entry is left alone. `--upgrade` replaces
entries that already reference this npm package; `--force` replaces one running
a different command. Restart the client afterwards, then check the environment:

```sh
npx typegpu-runtime-inspector-mcp@latest doctor
```

`doctor` checks Node, npx, and the Chromium/WebGPU launch.

Requirements: Node.js 20 or newer, filesystem access to the inspected project,
and Playwright Chromium with WebGPU. `playwright-chromium` is a runtime
dependency; if install lifecycle scripts were skipped, reinstall with them
enabled and rerun `doctor`.

To configure a client by hand, register `npx
typegpu-runtime-inspector-mcp@<version>` as a stdio command named
`typegpu_inspector`.

## Tools

| Tool | Use |
| --- | --- |
| `inspect_typegpu` | Run a browser/WebGPU inspection from a probe, an inspection module, or exported symbols. |
| `list_typegpu_exports` | Scan one module and suggest symbol targets. Returns `exports`, `likelyTypegpuExports`, `suggestedSymbolTargets`. |
| `resolve_typegpu_context` | Explain inferred roots, dependency sources, warnings, and next actions without launching a browser. |

### `inspect_typegpu`

`target.kind` selects one of three sources:

- `probe` — `body` of `async inspect({ root, device, tgpu, d, std, common })`,
  returning a target or an array of them. `virtualPath` fixes where relative
  imports resolve from.
- `module` — `path` to a module exporting `inspect` (`exportName` overrides the
  name).
- `symbols` — `modulePath` plus `targets`, selectors into the module's exports.
  `setupBody` runs before target creation; `includePrivate` also exposes
  top-level locals.

A target's `kind` is `compute-pipeline`, `render-pipeline`, `resolvable`, or
`resource`. `resource` produces structural reports for schemas, buffers,
textures and views, samplers, query sets, bind group layouts and groups, vertex
layouts, slots, accessors, and GPU variables. Compute targets may return an
entrypoint directly; use `create: () => root.create…` when construction must
happen during target attribution, which is the usual case for render pipelines.

```json
{
  "target": {
    "kind": "symbols",
    "modulePath": "src/shaders.ts",
    "targets": [{ "kind": "compute-pipeline", "compute": "mainCompute" }]
  }
}
```

Roots, local TypeGPU dependencies, and Vite config are inferred. Add
`project.root`, `project.dependencyAliases`, `target.virtualPath`, or
`environment` fields only when warnings or diagnostics ask for them. In a
TypeGPU monorepo, prefer one package-root alias
(`{ "typegpu": "packages/typegpu/src" }`) over aliasing `typegpu/data`,
`typegpu/std`, and `typegpu/common` separately.

Unresolved slots, accessors, and helper arguments go through a provider chain:
explicit `with`/`probeBindings`/`probeArguments` entries, then bindings the
application itself made, then values borrowed or synthesized from module and
import scope, then synthesized descriptor parts. Every decision lands in the
target's `ledger`. `environment.autoBind: false` surfaces raw failures
instead.

### Environment

| Field | Default | Effect |
| --- | --- | --- |
| `quiescent` | `true` | Stubs `requestAnimationFrame`, `ResizeObserver`, `queue.submit`, and pipeline dispatch/draw before import. |
| `documentHtml` | — | Assigned to `document.body` before import. |
| `browserSetup` | — | Browser JavaScript run after the quiescent prologue and before import. |
| `staticAssetRoutes` | `[]` | `{ urlPrefix, directory }` routes served by the Vite server. |
| `features` | `[]` | WebGPU features requested from the adapter. |
| `strictNames` | `true` | Deterministic TypeGPU generated names. |
| `autoBind` | `true` | Satisfy missing slot and accessor bindings. |

A browser module that starts a frame loop at import time would otherwise draw
into the inspector's validation scopes and lose the device, so `quiescent`
defaults to `true` and is recorded as a `device-session:quiescent-run` ledger
entry. A passing target is therefore static validation evidence, not proof that
the application renders. Set it to `false` when the run must observe real frame
or submit behaviour, such as a warm-up dispatch that initializes a pipeline.

### Output

| Field | Default | Effect |
| --- | --- | --- |
| `verbosity` | `"summary"` | `"summary"`, `"normal"`, or `"full"`. |
| `includeWgsl` | `"full"` only | Canonical WGSL per target. |
| `includeCalls` | `"full"` only | Recorded GPU calls. |
| `includeCallWgsl` | `false` | Repeat WGSL inside `createShaderModule` descriptors. |
| `maxWgslBytes` | — | Truncate each WGSL string to this many UTF-8 bytes. |
| `diagnosticsOnly` | `false` | Return diagnostics, target status, console messages, page errors. |
| `includeLegacyInspection` | `false` | Repeat the formatted report under `inspection`. |
| `timeoutMs` | `15000` | Wall clock for one inspection, Vite startup included. |

Responses carry `summary`, `targets`, `dependencySummary`, `warnings`, and
`nextActions` at the top level. Local absolute paths are replaced with
`<projectRoot>`, `<packageRoot>`, `<workspaceRoot>`, and `<mcpPackage>`. A
failed target carries `failureCategory`: `source`, `shader-compiler`,
`webgpu-validation`, `environment`, `timeout`, or `harness`. Browser stack
frames appear only at `"full"`. The text block of each result repeats the
JSON payload, for clients that do not surface `structuredContent`.

`body`, `setupBody`, and `browserSetup` are source snippets. Pass real newline
characters; double-escaped text such as `\nconst x = 1` is parsed as literal
source and fails.

### Diagnostic codes

Blocked: `slot-binding-required`, `wrapper-required`,
`reference-wrapper-required`, `selector-not-resolved`, `module-import-failed`,
`canvas-dom-setup-required`, `browser-capability-unavailable`,
`webgpu-device-lost`.

Unsupported: `not-shader-resolvable`, `plain-object-not-inspectable`,
`cpu-function-not-inspectable`, `three-node-not-inspectable`,
`value-not-inspectable`, `unsupported-internal-resource`,
`pipeline-resource-shape`, `raw-webgpu-pipeline-unsupported`,
`typegpu-<stage>-function-not-resolvable`, `typegpu-value-not-resolvable`.

Notes rather than failures: `slot-bindings-auto-applied`,
`inspection-defaults-applied`, `structural-resource-only`,
`direct-symbol-inspection`, `webgpu-validation-unavailable`,
`pipeline-validated-without-recorded-creation`, `pipeline-wrapper-unwrapped`.

Partial results: `module-device-resource`, `resource-wgsl-unavailable`.

Other failures: `inspection-timeout`, `webgpu-validation-timeout`,
`result-serialization-failed`, `typegpu-random-resolution-failed`.

## Development

```sh
pnpm install
pnpm start
pnpm typecheck
pnpm test
pnpm test:browser
```

Browser tests need Playwright Chromium with WebGPU; install it with
`pnpm exec playwright install chromium`. An opt-in survey runs real TypeGPU
docs examples through the inspector:

```sh
TYPEGPU_DOCS_ROOT=/path/to/TypeGPU TYPEGPU_MCP_RUN_BROWSER_TESTS=1 \
  pnpm vitest run test/docs-survey.test.ts
```
