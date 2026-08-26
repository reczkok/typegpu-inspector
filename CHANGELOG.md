# Changelog

All notable changes to TypeGPU Inspector — the Zed extension, the VS Code
extension, the language server, and the runtime inspector — are recorded here.
The four packages are versioned and released together.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-08-26

### Added

- VS Code: a generated-WGSL document beside the editor ("Open Generated WGSL
  to the Side", also a button in the editor title of TypeGPU files). It follows
  the cursor across targets, carries the WGSL compiler's diagnostics, and has a
  CodeLens back to the source; "Pin" keeps one target in its own tab. Hovers
  link to it as *Open WGSL* and *Peek* (the editor's peek view).
- VS Code: "Open Inspection Report to the Side" renders the full report in the
  Markdown preview, following the cursor the same way.
- Language server: `typegpu/targets`, `typegpu/wgsl`, and `typegpu/report`
  requests behind those views. Editors that do not send them are unaffected.
- An open document that changes on disk — a file written by a tool or an
  agent — is inspected as if it had been saved, in editors that support file
  watching.

- `hoverDetailLevel: "wgsl"`: generated WGSL only for shaders and pipelines,
  compact facts for everything else. The generated WGSL now precedes the
  tables at every level, and `hoverPresentation.wgslPreviewLines` accepts up
  to 400.
- `hoverPresentation.maxColumns` bounds the width of hover tables in visible
  characters (72 in Zed, 96 elsewhere, clamped to 40–200). A table that would
  exceed it renders as wrapping key/value lines instead of being clipped.
- `datasheet` is a hover section id. `resource`, `schema`, `pipelineState`, and
  `pipelineContext` address the same section.

### Changed

- VS Code: the TypeScript quick info renders above the TypeGPU hover, so the
  type is visible without scrolling.
- MCP: the text block of every tool result carries the full JSON payload.
  Clients such as Claude Code show only text, and previously saw a four-line
  headline.
- A target whose TypeGPU resolution fails is classified `source`, not
  `harness`.
- Resolution errors no longer mention the inspector's probe wrappers.
- A compiler diagnostic that maps only to a declaration no longer claims an
  approximate location; the related location names the generated WGSL line.

- A hover states each role's facts in one two-column table — stages, primitive
  state, colour targets, and one row per vertex slot and attribute for a
  pipeline; kind, usage, size, format, and layout for a resource — in place of
  a bold heading per fact.
- Inline code marks identifiers from the inspected code and the generated WGSL.
  WebGPU vocabulary is plain text.
- The bindings table is group:binding with the name, type, and stages;
  the WebGPU layout column appears at `deep`.
- Hovers have no nested lists, and state the pipeline stages once.
- `standard` and `compact` carry the generated shader's declaration count on
  the WGSL link; `deep` keeps the full declaration list.
- Hovers decode WebGPU usage bitmasks into names in the resource's `Usage` row
  (`uniform · copy-src · copy-dst`); the raw mask appears only at the `deep`
  level and in the full report.
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
