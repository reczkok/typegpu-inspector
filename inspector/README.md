# TypeGPU Runtime Inspector MCP

A local stdio MCP server that validates TypeGPU code in Chromium with WebGPU.
It loads a module through Vite, creates a browser `GPUDevice`, and reports
generated WGSL, shader compilation messages, WebGPU validation errors, bind
group layout stats, console and page errors, and recorded GPU calls.

Inspections share one Vite/Chromium session per workspace and configuration;
each request gets a fresh page and JavaScript realm.

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

- `probe`: `body` of `async inspect({ root, device, tgpu, d, std, common })`,
  returning a target or an array of them. `virtualPath` fixes where relative
  imports resolve from.
- `module`: `path` to a module exporting `inspect` (`exportName` overrides the
  name).
- `symbols`: `modulePath` plus `targets`, selectors into the module's exports.
  `setupBody` runs before target creation; `includePrivate` also exposes
  top-level locals through references to the original module, preserving live
  bindings and object identity. For a nested shader declaration, provide its
  original zero-based source offset as `declaration` and optionally select a
  zero-based `instance`. Without `instance`, reports cover all captured instances
  and include `parentLabel` plus `context` metadata. The enclosing CPU scope must
  execute during module import or explicit setup; GPU bodies are not instrumented.
  A selector target's `context` accepts `label`, `arguments` (schema/refSchema/value
  selector entries), and `with` (slot/value selector pairs), and disables automatic
  binding inference. Missing bindings for nested instances are reported as blocked.
  Neighboring callers are never imported automatically to find bindings;
  `setupBody` can explicitly import a caller or provide the target context.

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

Explicit contexts supply helper arguments and slot bindings. Otherwise, observed
pipeline branches and bound functions supply complete binding sets, each with its
own report and `context.usage` index. Selector `usage` chooses one set. A direct
relationship uses `observed-context` provenance; sharing a slot only identifies a
candidate, which remains assumption-qualified. Sets never borrow from each
other, and missing values inside a set are not synthesized. Without a matching
set, schema synthesis can still produce an explicitly qualified probe.
`environment.autoBind: false` disables automatic context selection and synthesis.
The editor and CLI share `--context-file` JSON fixtures and offer static importer
suggestions for blocked targets; no neighboring module executes implicitly.

Symbol discovery is exploratory: a target may compile with synthesized
arguments, descriptor parts, or a binding borrowed from another caller. Such
results have `outcome: "passed-with-assumptions"`; inspect the ledger before
treating them as evidence about an application's configuration. For validation,
return the configured application pipeline from a `module` or `probe` caller
and require `outcome: "passed"` for every requested target. The CLI exposes the
same gate with `check --require-concrete`. A successful quiescent check validates
generated WGSL and pipeline creation, not rendered output or runtime data.

Runtime-sized array accessors require a real storage buffer binding. They
cannot be represented by an empty array literal: bind the accessor with
`root.with(accessor, buffer.as('readonly'))` in your caller. A missing binding
is a blocked inspection, not a shader compiler error.

### Environment

| Field | Default | Effect |
| --- | --- | --- |
| `quiescent` | `true` | Stubs `requestAnimationFrame`, `ResizeObserver`, `queue.submit`, and pipeline dispatch/draw before import. |
| `documentHtml` | none | Assigned to `document.body` before import. |
| `browserSetup` | none | Browser JavaScript run after the quiescent prologue and before import. |
| `staticAssetRoutes` | `[]` | `{ urlPrefix, directory }` routes served by the Vite server. |
| `features` | `[]` | WebGPU features requested from the adapter. |
| `strictNames` | `true` | Deterministic TypeGPU generated names. |
| `autoBind` | `true` | Satisfy missing slot and accessor bindings. |

`quiescent` defaults to `true` because a module that starts a frame loop at
import time would draw into the inspector's validation scopes and lose the
device. The run is recorded as a `device-session:quiescent-run` ledger entry.
With it on, a passing target means WebGPU accepted the pipelines; no frame was
rendered. Set it to `false` when the run has to observe real frames or
submits, for example a warm-up dispatch that initializes a pipeline.

### Output

| Field | Default | Effect |
| --- | --- | --- |
| `verbosity` | `"summary"` | `"summary"`, `"normal"`, or `"full"`. |
| `includeWgsl` | `"full"` only | Canonical WGSL per target. |
| `includeCalls` | `"full"` only | Recorded GPU calls. |
| `includeCallWgsl` | `false` | Repeat WGSL inside `createShaderModule` descriptors. |
| `maxWgslBytes` | none | Truncate each WGSL string to this many UTF-8 bytes. |
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

Notes: `slot-bindings-auto-applied`,
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

For an existing factory result, set `inspectMembers: true` on a selector target.
The runtime enumerates actual shader/resource leaves in records and arrays.
`member: ["passes", "0", "shade"]` selects one exact property path, including
keys containing dots. `member: []` selects the root value. Combine a member with
`context.arguments` or `context.with` to specialize that returned helper.
Reports expose `context.resultPath`; recorded pipeline descriptors also provide
`context.pipelineStages` for matching module-level stage bindings.

Traversal never invokes getters or returned CPU functions. Getters and traversal
limits are blocked reports; cycles terminate. Only enumerable string-keyed
record/array properties are expanded (12 levels, 2,048 visited values, 128
results). TypeGPU values are leaves; arbitrary class instances require an explicit
selector/setup. Bare GPU functions are recognized by their own directive,
not a directive inside a returned callback. This does not call uninstantiated
factories or infer erased argument types for returned bare helpers.
