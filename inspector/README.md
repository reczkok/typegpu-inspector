# TypeGPU Runtime Inspector MCP

Local stdio MCP server for validating TypeGPU code in Chromium with WebGPU.

It loads TypeGPU inspection modules through Vite, creates a browser `GPUDevice`,
and reports generated WGSL, shader compilation messages, WebGPU validation
errors, bind group layout stats, console/page errors, and recorded GPU calls.

Agent-facing inspections reuse a bounded workspace/configuration session for
Vite and Chromium. Every request still opens a fresh page/JavaScript realm.
Source and dependency edits are selectively invalidated, concurrent requests
for one session are serialized, and an unhealthy session falls back once to a
fully isolated inspection.

## Quick Setup

Use `npx` from the client you want to configure:

```sh
npx typegpu-runtime-inspector-mcp@latest setup codex
npx typegpu-runtime-inspector-mcp@latest setup claude
npx typegpu-runtime-inspector-mcp@latest setup opencode
npx typegpu-runtime-inspector-mcp@latest setup zed
```

`setup zed` adds a `context_servers` entry for the Zed agent with a
comment-preserving edit of `~/.config/zed/settings.json`. Users of the TypeGPU
Inspector Zed extension do not need it: the extension registers the same MCP
server automatically.

Configure every supported client found on `PATH`:

```sh
npx typegpu-runtime-inspector-mcp@latest setup all
```

The setup command registers a local MCP server named `typegpu_inspector` and
pins it to the package version that performed setup, for example:

```sh
npx typegpu-runtime-inspector-mcp@<version>
```

Existing `typegpu_inspector` entries are left unchanged unless `--upgrade` or
`--force` is provided.

To update a setup created by an older version, run setup again with `--upgrade`:

```sh
npx typegpu-runtime-inspector-mcp@latest setup codex --upgrade
npx typegpu-runtime-inspector-mcp@latest setup all --upgrade
```

Then restart the MCP client and check the local environment with:

```sh
npx typegpu-runtime-inspector-mcp@latest doctor
```

`--upgrade` only replaces entries that already reference this npm package. If a
client has a custom `typegpu_inspector` command, use `--force` to replace it
intentionally.

Requirements:

- Node.js 20 or newer
- Local filesystem access to the inspected project
- Playwright Chromium with WebGPU support

`playwright-chromium` is a runtime dependency of this package. If lifecycle
scripts were skipped during install, enable them and reinstall, then run
`doctor` again.

## Manual Client Config

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.typegpu_inspector]
command = "npx"
args = ["typegpu-runtime-inspector-mcp@<version>"]
```

Codex CLI:

```sh
codex mcp add typegpu_inspector -- npx typegpu-runtime-inspector-mcp@<version>
```

Claude Code:

```sh
claude mcp add --transport stdio --scope user typegpu_inspector -- npx typegpu-runtime-inspector-mcp@<version>
```

OpenCode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "typegpu_inspector": {
      "type": "local",
      "command": ["npx", "typegpu-runtime-inspector-mcp@<version>"],
      "enabled": true
    }
  }
}
```

## MCP Tools

Default discovery exposes three agent-facing tools:

- `inspect_typegpu`: run a browser/WebGPU inspection from a probe, inspection
  module, or exported symbols.
- `list_typegpu_exports`: scan one module and suggest symbol targets for
  `inspect_typegpu`.
- `resolve_typegpu_context`: explain inferred roots, dependency sources,
  warnings, and next actions without launching a browser.

### `inspect_typegpu`

Preferred tool for agents. Accepted target variants:

- `probe`: function body for quick inline probes.
- `module`: path to an inspection module that exports `inspect`.
- `symbols`: exported symbols from an existing module, usually after
  `list_typegpu_exports`.

The MCP infers project/package/workspace roots, local TypeGPU dependencies, and
Vite config. Add `project.root`, `project.dependencyAliases`,
`target.virtualPath`, or `environment` fields only when warnings or diagnostics
ask for them.

In TypeGPU monorepos, package resolution can still fall back to the MCP package
when the current package does not expose a `node_modules/typegpu` workspace
link. Check `dependencySummary.hasBundledTypegpuFallback` and `warnings`. Retry
with `project.root` anchored to the workspace root and a package-root alias
through `project.dependencyAliases` instead of aliasing individual subpaths:

```json
{
  "project": {
    "root": ".",
    "dependencyAliases": {
      "typegpu": "packages/typegpu/src"
    }
  }
}
```

That one alias covers `typegpu`, `typegpu/data`, `typegpu/std`, and
`typegpu/common`. For inline probes that import project files, set
`target.virtualPath` inside the inspected package so relative imports resolve
from the same location as the source being tested.

Quick probe:

```json
{
  "target": {
    "kind": "probe",
    "body": "const main = tgpu.computeFn({ workgroupSize: [1] })(() => { 'use gpu'; }); return { label: 'main', kind: 'compute-pipeline', value: main };"
  }
}
```

Existing exported symbols:

```json
{
  "target": {
    "kind": "symbols",
    "modulePath": "src/shaders.ts",
    "targets": [{ "kind": "compute-pipeline", "compute": "mainCompute" }]
  }
}
```

Inspection modules export `inspect` by default:

```ts
export async function inspect({ root, device, tgpu, d, std, common }) {
  const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
    'use gpu';
  });

  return {
    label: 'main',
    kind: 'compute-pipeline',
    value: main,
  };
}
```

Use `target.kind: "module"` for these files:

```json
{
  "target": {
    "kind": "module",
    "path": "src/inspect-particle-step.ts"
  }
}
```

The context contains:

- `root`: TypeGPU root backed by the inspector browser device.
- `device`: recorded `GPUDevice` proxy.
- `tgpu`, `d`, `std`, `common`: TypeGPU imports resolved for the inspected
  project.

Return a target or an array of targets:

```ts
{
  label?: string;
  kind?: 'compute-pipeline' | 'render-pipeline' | 'resolvable' | 'resource';
  value?: unknown;
  create?: () => unknown;
  unwrap?: boolean;
}
```

Plain returned values are treated as `{ value }`. Compute pipeline targets may
return a TypeGPU compute entrypoint; the inspector creates the pipeline. Use
`create` when construction should happen during target attribution, especially
for render pipelines and descriptor-heavy probes.

`resource` targets produce bounded structural reports for TypeGPU schemas,
buffers and shorthand bindings, textures/views, ordinary/comparison samplers,
query sets, bind-group layouts, bind groups, vertex layouts, slots/accessors,
and GPU variables. When a resource also resolves as WGSL, the report includes
both its structure and generated declaration.

Editor-generated symbol targets can include `probeArguments` to call shellless
helpers with schema-derived zero values. `probeBindings` can additionally bind
constructible accessors to inspection-only zero values. Struct schemas work
recursively, including selectors such as `module.HitInfo` derived from
`d.Infer<typeof HitInfo>` or `d.InferGPU<typeof HitInfo>`.

**The requirement engine.** Inspection is modeled as requirement
satisfaction: when a target cannot resolve standalone, typed requirements
(currently `slot-value` and `argument-values`) are discovered from the
target's shape or extracted from the failure, then satisfied by an ordered
provider chain:

1. *user-explicit* — `with`, `probeBindings`, `probeArguments` entries;
2. *recorded-app-bindings* — values the application itself bound: a typegpu
   recording shim observes every `root.with(...)`, pipeline creation, and
   `createUniform` during module import and setup;
3. *module scope* / *import scope* — bindings borrowed from bound functions
   and pipelines, or placeholder values synthesized from matching accessors'
   schemas, found among the module's exports, its runtime imports' exports,
   setup values, and sibling targets (placeholders are ones-filled for
   scalars/vectors to avoid comptime NaN traps; structs keep zeros; mutable
   accessors are borrow-only);
4. *synthesis* — descriptor parts (vertex attribs, fragment targets).

Every decision lands in the target's `ledger` (provenance records with
provider attribution); satisfied failure-discovered entries also surface as
the `slot-bindings-auto-applied` note and shape-discovered ones as
`inspection-defaults-applied`. Unsatisfiable requirements fail with a
diagnostic naming exactly what was missing and where the engine looked.
`autoBind: false` disables satisfaction to surface raw failures. Already
created compute pipelines cannot be retro-bound (TypeGPU keeps their
bindings private), but pipelines the recording shim saw being created can be
recreated with engine provisions when needed.

For helpers that mix ordinary data with GPU resources, `probeArgumentPlan`
preserves argument order and can defer concrete selectors until shader
resolution:

```json
{
  "selector": "sampleTexture",
  "kind": "resolvable",
  "probeArgumentPlan": [
    { "schema": "ctx.d.vec2f" },
    { "value": "module.linearSampler.$" }
  ]
}
```

`schema` entries construct zero values. `value` entries read existing module,
setup, or context values inside the generated shader callback, which is
required for resources whose `.$` handles are only legal during code
generation. `probeArguments` remains the concise form when every argument is a
constructible schema.

Editor discovery can also point symbol targets at values an application
factory already created, such as `pipelines.gpu-optimized` or a destructured
`pipeline`. This preserves the application’s concrete return shape without
calling host factories twice. Pre-created pipelines are resolved and compiled
for WGSL, bindings, declarations, size, and compilation diagnostics; when the
pipeline belongs to the module’s own GPU device, exact target-owned
`createPipeline` call statistics are intentionally reported as unavailable.
Local compute, vertex, and fragment symbols referenced by those concrete
pipelines share the same target, so stage inspection preserves authored
accessor/slot bindings. Resource targets may also be arrays or plain nested
records; resource-bearing fields are reported with stable names while
non-resource metadata is ignored.

```ts
return {
  label: 'render',
  kind: 'render-pipeline',
  create: () =>
    root.createRenderPipeline({
      vertex: common.fullScreenTriangle,
      fragment,
      targets: { format: 'bgra8unorm' },
    }),
};
```

If `kind` is omitted on a `create` target, the inspector infers it from the
created TypeGPU pipeline when possible.

### `list_typegpu_exports`

Statically scans a module and returns:

- `exports`: all exported symbols found.
- `likelyTypegpuExports`: exports that look like TypeGPU symbols.
- `suggestedSymbolTargets`: ready-to-copy `inspect_typegpu.target.targets`
  entries when possible.

```json
{
  "modulePath": "src/shaders.ts"
}
```

### `resolve_typegpu_context`

Returns sanitized `resolvedContext`, `dependencySummary`, `warnings`, and
`nextActions` for a target path. Agent-facing outputs replace local absolute
paths with labels such as `<projectRoot>`, `<packageRoot>`, `<workspaceRoot>`,
and `<mcpPackage>`.

```json
{
  "targetPath": "apps/demo/src/shaders.ts"
}
```

## Browser Setup And Assets

Use these fields when the inspected module expects DOM nodes, globals, static
assets, or non-standard import paths:

```json
{
  "target": {
    "kind": "module",
    "path": "src/examples/image-processing/blur/index.ts"
  },
  "environment": {
    "documentHtml": "<canvas width=\"512\" height=\"512\"></canvas>",
    "browserSetup": "window.__TEST_MODE__ = true;",
    "staticAssetRoutes": [
      { "urlPrefix": "/TypeGPU", "directory": "public" },
      { "urlPrefix": "/", "directory": "public" }
    ]
  }
}
```

Fields:

- `documentHtml`: assigned to `document.body.innerHTML` before import.
- `browserSetup`: browser JavaScript executed before import with `root`,
  `device`, `tgpu`, `d`, `std`, and `common` parameters.
- `staticAssetRoutes`: serves files from local directories through the inspector
  Vite server.
- `features`: WebGPU features to request from the adapter.
- `strictNames`: deterministic TypeGPU generated names. Defaults to `true`.
- `viteConfigPath`: optional project Vite config. Low-level calls resolve it
  relative to `cwd`; agent-facing project hints resolve relative paths from the
  target package first, then project/workspace roots.

## Output

`inspect_typegpu` mirrors the most useful result fields at the top level:

- `summary`: compact target, pipeline, console, and compilation counts.
- `targets`: per-target status, diagnostics, pipeline creation, and optional WGSL.
- `dependencySummary`: core TypeGPU source routing and bundled fallback flags.
- `warnings`: sanitized context/dependency warnings.
- `nextActions`: concrete retry hints.
- `inspection`: the formatted report kept for compatibility.

Agent-facing outputs sanitize local absolute paths into labels such as
`<projectRoot>`, `<packageRoot>`, `<workspaceRoot>`, and `<mcpPackage>`.

Default output is compact. Controls:

- `verbosity`: `"summary"` (default), `"normal"`, or `"full"`.
- `includeWgsl`: include WGSL in targets and shader-module descriptors. Defaults
  to `true` only for `"full"`.
- `includeCalls`: include recorded GPU calls. Defaults to `true` only for
  `"full"`.
- `maxWgslBytes`: truncate each included WGSL string to this many UTF-8 bytes.
- `diagnosticsOnly`: return diagnostics, target status, console messages, and
  page errors.

`inspectBody`, `inlineCode`, `setupBody`, and `browserSetup` are JavaScript or
TypeScript source snippets. Pass actual newline characters in these fields when
you need multiple lines; double-escaped text such as `\\nconst x = 1` is parsed
as literal source and will fail.

```json
{
  "target": {
    "kind": "probe",
    "body": "return { label: 'main', kind: 'resolvable', value: helper };"
  },
  "output": {
    "verbosity": "normal",
    "includeWgsl": true,
    "maxWgslBytes": 4000
  }
}
```

Common diagnostic codes:

- `plain-object-not-inspectable`
- `wrapper-required`
- `slot-binding-required`
- `slot-bindings-auto-applied` (note, not a failure)
- `selector-not-resolved`
- `webgpu-validation-timeout`
- `pipeline-resource-shape`
- `pipeline-validated-without-recorded-creation`
- `raw-webgpu-pipeline-unsupported`
- `typegpu-fragment-function-not-resolvable`
- `module-import-failed`
- `canvas-dom-setup-required`
- `direct-symbol-inspection`
- `typegpu-random-resolution-failed`

## Local Development

```sh
pnpm install
pnpm start
```

Checks:

```sh
pnpm typecheck
pnpm test
pnpm test:browser
```

An opt-in acceptance survey runs real TypeGPU docs examples through the
inspector (cross-module accessor auto-binding regression check):

```sh
TYPEGPU_DOCS_ROOT=/path/to/TypeGPU TYPEGPU_MCP_RUN_BROWSER_TESTS=1 \
  pnpm vitest run test/docs-survey.test.ts
```

Browser tests require Playwright Chromium with WebGPU support. If Chromium is
missing, run:

```sh
pnpm exec playwright install chromium
```
