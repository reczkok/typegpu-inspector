# Changelog

All notable changes to TypeGPU Inspector — the Zed extension, the VS Code
extension, the language server, and the runtime inspector — are recorded here.
The four packages are versioned and released in lockstep.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - Unreleased (YYYY-MM-DD)

First public store release: VS Code Marketplace and the Zed extension registry.

### Added

- TypeGPU 0.12 support. The bundled runtime pins `typegpu` 0.12.3 and
  `unplugin-typegpu` 0.12.2, and inspection understands the named `tgpu`
  import (`import { tgpu } from 'typegpu'`) alongside the default import.
- 0.12 resource types (`root`, guarded compute pipelines, command encoders,
  render/compute passes, render bundle encoders) are described in resource
  hovers instead of falling back to a generic runtime type.
- VS Code: an extension icon, a Marketplace gallery banner, and a first-run
  notice that explains — before anything is downloaded — that the extension
  fetches `typegpu-runtime-inspector-mcp` plus a Playwright Chromium
  (~150 MB) into the extension's global storage and executes the project's
  top-level TypeGPU module code in that headless browser.
- VS Code: Workspace Trust is declared and honoured. In Restricted Mode the
  language server is not started; a status-bar hint explains why.
- `pnpm bump <version>` (`scripts/bump-version.mjs`) rewrites the version in
  every manifest in one step.
- This changelog, shipped inside the VSIX so the Marketplace renders it.

### Changed

- Runtime inspection is quiescent by default on every path, including the
  MCP agent tools: `requestAnimationFrame`, `ResizeObserver`, `queue.submit`
  and pipeline draw/dispatch are stubbed before the module is imported, so an
  import-time render loop can no longer lose the WebGPU device and block every
  target in the module. The run is recorded in the report ledger; pass
  `quiescent: false` to observe real frame/submit behaviour.
- VS Code activation no longer loads the language server in projects that do
  not use TypeGPU — the extension activates cheaply and starts the client only
  once a TypeGPU import is seen.
- Version strings are single-sourced. The language server's `serverInfo`, its
  MCP client identity, the runtime inspector spec it installs, and the VS Code
  doctor command are all injected at build time from the owning package's
  `package.json`, so they can no longer drift apart.
- The language server no longer assumes `npm` is on `PATH` when installing the
  runtime inspector; it falls back to the `npm-cli.js` shipped next to the
  discovered `node`, and reports exactly what it searched when neither is
  found.
- The published language server bundle is minified.

## [0.4.7] - 2026-08-05

### Changed

- The runtime inspector installs into the editor's global storage with a
  cross-window lock.
- Warm-up runs once per cold session, and the session is released after the
  last TypeGPU document closes.
- MCP output is compacted with failure categories.
- Slot placeholders are recursively non-degenerate.
- The inspector bin runs the built `dist` entry.

## [0.4.0] - [0.4.6]

Internal iterations: hover and inlay surface work, discovery and diagnostics
tuning, packaging experiments. Not published to any store.

[0.5.0]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.5.0
[0.4.7]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.4.7
