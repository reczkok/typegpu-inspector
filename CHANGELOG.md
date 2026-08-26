# Changelog

All notable changes to TypeGPU Inspector — the Zed extension, the VS Code
extension, the language server, and the runtime inspector — are recorded here.
The four packages are versioned and released together.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-08-26

### Changed

- Hovers decode WebGPU usage bitmasks into names on the resource line
  (`buffer · uniform · copy-src · copy-dst`); the raw mask appears only at the
  `deep` level and in the full report.
- The `standard` hover replaces the per-entry assumption list with one line
  naming the synthesized input categories; `compact` shows none; `deep` keeps
  the full ledger. `hoverPresentation.sections.assumptions: "show"` forces the
  full list at any level. The editor's quiescent run is reported under runtime
  notes at `deep` and no longer counts as a target assumption.
- Documentation rewritten as reference material, with an authorship note.

## [0.5.0] - 2026-08-26

First public store release: VS Code Marketplace and the Zed extension registry.

### Added

- TypeGPU 0.12 support. The bundled runtime pins `typegpu` 0.12.3 and
  `unplugin-typegpu` 0.12.2, and inspection understands the named `tgpu` import
  (`import { tgpu } from 'typegpu'`) alongside the default import.
- Resource hovers describe the 0.12 types — `root`, guarded compute pipelines,
  command encoders, render and compute passes, render bundle encoders —
  instead of falling back to a generic runtime type.
- VS Code: an extension icon, a Marketplace gallery banner, and a first-run
  notice stating, before anything is downloaded, that the extension fetches
  `typegpu-runtime-inspector-mcp` plus a Playwright Chromium (about 550 MB on disk) into the
  extension's global storage and executes the project's top-level TypeGPU
  module code in that headless browser.
- VS Code: Workspace Trust is declared and honoured. In Restricted Mode the
  language server is not started, and a status-bar hint explains why.
- `pnpm bump <version>` (`scripts/bump-version.mjs`) rewrites the version in
  every manifest in one step.
- This changelog, shipped inside the VSIX so the Marketplace renders it.

### Changed

- Runtime inspection is quiescent by default on every path, including the MCP
  agent tools: `requestAnimationFrame`, `ResizeObserver`, `queue.submit`, and
  pipeline draw/dispatch are stubbed before the module is imported, so an
  import-time render loop can no longer lose the WebGPU device and block every
  target in the module. The run is recorded in the report ledger; pass
  `quiescent: false` to observe real frame and submit behaviour.
- VS Code activation no longer loads the language server in projects that do
  not use TypeGPU. The extension activates cheaply and starts the client once a
  TypeGPU import is seen.
- Version strings are single-sourced. The language server's `serverInfo`, its
  MCP client identity, the runtime inspector spec it installs, and the VS Code
  doctor command are injected at build time from the owning package's
  `package.json`.
- The language server no longer assumes `npm` is on `PATH` when installing the
  runtime inspector. It falls back to the `npm-cli.js` shipped next to the
  discovered `node`, and reports what it searched when neither is found.
- The published language server bundle is minified.

### Fixed

- The first-run Chromium download no longer counts against the inspection
  timeout, and it announces itself on the server's output channel instead of
  running silently for minutes.
- The runtime installer resolves a Node.js shim (Homebrew, nvm, fnm, volta) to
  its real installation before looking for `npm-cli.js` beside it.
- A failed runtime install caused by a not-yet-published package version says
  so, instead of only quoting npm's ETARGET output.

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
