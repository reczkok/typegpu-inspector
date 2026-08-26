# TypeGPU Inspector

An editor extension for Zed and VS Code. It runs the TypeGPU module you are
editing in a headless Chromium with WebGPU and reports the WGSL and runtime
descriptors TypeGPU produced back in the TypeScript buffer. It is not a static
analyzer: it executes the module's top-level code, so use it on projects you
trust.

## What you get

- Hovers on TypeGPU declarations: generated WGSL, entry points, bindings,
  pipeline state, resource descriptors.
- Inlay hints carrying each declaration's inspection status.
- Diagnostics from the WGSL compiler and from WebGPU validation, mapped onto
  the TypeScript token where that mapping is reliable.
- Document links to the generated `.wgsl` file and the full report.
- Schema layout: offsets, alignment, padding, host shareability, and a tighter
  field order when one is provably smaller.

Pipelines, shader functions, schemas, buffers, textures, views, samplers, query
sets, bind group layouts and groups, vertex layouts, slots, accessors, GPU
variables, and collections of them are recognised.

## Install

- VS Code: install `reczkok.typegpu-inspector` from the Marketplace.
- Zed: install "TypeGPU Inspector" from the extension registry.

For a development install, see [Development](#development).

## Requirements

- Node.js 20 or newer on `PATH`.
- About 550 MB of disk for the one-time download described in
  [What it downloads and runs](#what-it-downloads-and-runs).
- A trusted project. Inspection executes the project's top-level TypeGPU
  module code, which is why VS Code declares the extension unsupported in
  Restricted Mode.

## Configuration

Zed reads these keys under `lsp.typegpu-inspector.initialization_options`. VS
Code reads the same names with a `typegpuInspector.` prefix and shows them in
its settings UI.

| Zed key | VS Code key | Default | Meaning |
| --- | --- | --- | --- |
| `inspectOn` | `typegpuInspector.inspectOn` | `"save"` | `save`, `hover`, `save-and-hover`, `off` |
| `warmUpOnOpen` | `typegpuInspector.warmUpOnOpen` | `true` | Prepare the session when a TypeGPU file opens |
| `hoverDetailLevel` | `typegpuInspector.hoverDetailLevel` | `"standard"` | `compact`, `standard`, `deep` |
| `inlayDetailLevel` | `typegpuInspector.inlayDetailLevel` | `"compact"` | `compact`, `summary`, `detailed` |
| `hoverPresentation` | `typegpuInspector.hoverPresentation` | `{}` | Section visibility, order, budgets |
| `timeoutMs` | `typegpuInspector.timeoutMs` | `45000` | Per inspection; clamped to 1000–600000 |
| `maxWgslBytes` | `typegpuInspector.maxWgslBytes` | `2000000` | Clamped to 16384–64000000 |
| `strictNames` | `typegpuInspector.strictNames` | `true` | TypeGPU strict generated names |
| `features` | not exposed | `[]` | WebGPU features requested from the adapter |
| `hover`, `inlayHints`, `diagnostics`, `documentLinks`, `sourceMapping`, `schemaLayoutHealth`, `schemaPackingSuggestions` | same names, prefixed | `true` | One switch per editor surface |
| `inspectorPackage` | `typegpuInspector.inspectorPackage` | `"bundled"` | `"bundled"` or an npm package name |
| `projectRoot` | `typegpuInspector.projectRoot` | `""` | Override workspace-root inference |

The deprecated `detailLevel` maps onto the two detail levels above.
`typegpuInspector.serverPath` is VS Code only and points at a local language
server build.

Hover and inlay detail are independent. `sourceMapping` is heuristic, and a
diagnostic always keeps its link to the generated WGSL location.
`hoverPresentation` sets each hover section to `auto`, `show`, or `hide`,
reorders them with `sectionOrder`, and bounds the ones that can grow; VS Code's
settings schema lists the section names and ranges. A lower detail level never
abbreviates schemas, bindings, render targets, vertex attributes, or short
resource descriptors.

Invalid values are dropped and logged. Changes apply without a restart, except
`serverPath`.

## What it downloads and runs

The first inspection downloads `typegpu-runtime-inspector-mcp` from npm and a
Playwright Chromium build (about 170 MB to download, 550 MB on disk), once
per machine. It then executes
the project's top-level TypeGPU module code inside that browser, so a module
with import-time side effects performs them. VS Code asks once, in a modal
dialog, before the first download.

Nothing is sent anywhere: no telemetry, no analytics, and no network traffic
beyond those two downloads and whatever the inspected module requests.

VS Code keeps the inspector under
`globalStorage/reczkok.typegpu-inspector/runtime` in its user directory
(`~/Library/Application Support/Code/User`, `~/.config/Code/User`, or
`%APPDATA%\Code\User`); Zed installs it into the extension's own work
directory. Playwright caches browsers separately in
`~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`, or
`%LOCALAPPDATA%\ms-playwright`. Deleting either directory is safe. Setting
`inspectOn` to `off` stops the extension from running anything.

## Limitations

- The harness around the module is generated. It covers DOM lookups, assets,
  TypeGPU setup, and resource creation, but a module needing an application
  shell, a login flow, or a remote API at import time can fail before the
  interesting value is reached.
- Resources, layouts, and pipelines are created and validated; no application
  draw or dispatch work is submitted. A passing target is validation evidence,
  not proof that a frame renders correctly.
- The adapter is usually a software WebGPU implementation, so it says nothing
  about GPU performance or driver behaviour.
- Missing shader arguments and slot values are synthesized when the type allows
  it, and the hover records that. Synthesized render targets and vertex inputs
  are inspection defaults, not the application's own.
- Packing suggestions are exhaustive up to 14 top-level fields. Larger
  structures get one candidate ordered by alignment and size, so no suggestion
  does not prove the order is optimal.

## Agent access

The same runtime ships as a stdio MCP server. The Zed extension registers it
automatically; other clients use the published `typegpu-runtime-inspector-mcp`
package. See [`inspector/README.md`](inspector/README.md).

## Development

Node.js 20 or newer and pnpm are required. Run scripts from the repository
root; the root lockfile is authoritative.

```sh
pnpm setup
pnpm build
```

Checks are `pnpm check`, `pnpm test`, `pnpm test:browser`, `pnpm test:e2e`, and
`cargo check`; `pnpm validate` runs all of them.
`node inspector/bin/typegpu-runtime-inspector-mcp.mjs doctor` checks Node, npx,
and the Chromium/WebGPU launch.

In Zed, run `zed: install dev extension` and select the repository root. The
dev extension uses `server/dist/server.cjs` from the checkout, so rerun
`pnpm build` and restart the language server after changing it.

In VS Code, build and install a local VSIX. It embeds the language server, so
rebuilding the server alone does not update an installed extension.

```sh
pnpm --dir editors/vscode package
code --install-extension editors/vscode/typegpu-inspector-*.vsix --force
```

`src` holds the Rust Zed extension, `server` the language server and editor
presentation, `inspector` the Chromium runtime and MCP server, and
`editors/vscode` the VS Code client.

### Releases

All four packages move together. `pnpm bump <version>` rewrites the version in
`Cargo.toml`, `extension.toml`, and the four `package.json` files; run
`cargo check` to refresh `Cargo.lock`, then record the release in
`CHANGELOG.md`. Other version strings are injected at build time.

Tags drive the release workflows: `inspector-v<version>` and
`server-v<version>` publish the npm packages through trusted publishing, and
`v<version>` builds the VSIX as a workflow artifact. The Marketplace upload is
manual.

## Authorship

A significant part of this codebase was written by Claude, Anthropic's Claude
Fable 5 model, working through Claude Code. The maintainer directed the work,
reviewed the changes, and tested them.

## License

MIT. See [LICENSE](LICENSE).
