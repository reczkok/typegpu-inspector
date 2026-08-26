# Changelog

Changes to TypeGPU Inspector: the Zed extension, the VS Code extension, the
language server, and the runtime inspector. The four packages are versioned
and released together. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Statement-level source mapping. On TypeGPU 0.12 or newer the runtime
  inspector records, while TypeGPU generates WGSL, which authored statement
  produced each line (`statementMap` on every target report), and the
  language server places compiler diagnostics and resolution errors on that
  statement. A helper inlined into another target's WGSL maps to its call site
  with the statement as related information, or sits on the statement itself
  when the helper reports nothing of its own (uniformity errors only exist in
  the caller's context). Compiler notes join the error or warning they
  explain as related information instead of appearing as diagnostics of their
  own. Older TypeGPU versions keep the token heuristics.

### Fixed

- A compiler selection that merely contains a call (an operator's operand)
  no longer pins the diagnostic to that call's callee.

## [0.6.1] - 2026-08-26

### Changed

- VS Code: the extension icon is the TypeGPU mark with binoculars, and the
  first-run dialog is shorter.

## [0.6.0] - 2026-08-26

### Added

- VS Code: a generated-WGSL document beside the editor. It follows the cursor
  across targets, shows the compiler's diagnostics in place, and has a
  CodeLens back to the source. Hovers link to it as Open WGSL and Peek.
- VS Code: an inspection report beside the editor, rendered in the Markdown
  preview.
- `hoverDetailLevel: "wgsl"`: generated WGSL only for shaders and pipelines.
  The WGSL now comes before the tables at every level, and
  `hoverPresentation.wgslPreviewLines` accepts up to 400.
- `hoverPresentation.maxColumns` bounds hover table width (72 in Zed, 96
  elsewhere). A wider table renders as key/value lines.
- Language server requests `typegpu/targets`, `typegpu/wgsl`, and
  `typegpu/report` for editor views.
- An open document that changes on disk, for example one written by an agent,
  is inspected as if it had been saved.

### Changed

- Zed is installed as a dev extension; the extension is not in Zed's registry.
- VS Code: the TypeScript quick info renders above the TypeGPU hover.
- Hovers are datasheets: one two-column table per role, usage names instead of
  bitmasks, bindings as group:binding with name, type, and stages. `standard`
  summarizes synthesized inputs in one line; `deep` keeps the full ledger.
- MCP tool results repeat the JSON payload in the text block, for clients that
  show only text.
- A failed TypeGPU resolution is classified `source`, not `harness`, and no
  longer mentions the inspector's probe wrappers.
- A compiler diagnostic that maps only to a declaration no longer claims an
  approximate location; the related location names the generated WGSL line.
- Documentation rewritten, with an authorship note.

## [0.5.0] - 2026-08-26

First public release: VS Code Marketplace, and Zed as a dev extension.

### Added

- TypeGPU 0.12 support (`typegpu` 0.12.3, `unplugin-typegpu` 0.12.2),
  including the named `tgpu` import.
- Resource hovers for the 0.12 types: root, guarded compute pipelines, command
  encoders, render and compute passes, render bundle encoders.
- VS Code: icon, gallery banner, a first-run notice before anything is
  downloaded, and Workspace Trust support (the server stays off in Restricted
  Mode).
- `pnpm bump <version>` and this changelog.

### Changed

- Runtime inspection is quiescent by default on every path: frame loops,
  ResizeObserver, queue submits, and draw/dispatch are stubbed before import,
  so an import-time render loop cannot lose the WebGPU device. Pass
  `quiescent: false` to observe real frame behavior.
- VS Code activates cheaply and starts the language server once a TypeGPU
  import is seen.
- Version strings are injected at build time from each package's
  `package.json`.
- The runtime installer no longer needs `npm` on `PATH`; it falls back to the
  `npm-cli.js` next to the discovered `node`.
- The published language server bundle is minified.

### Fixed

- The first-run Chromium download is excluded from the inspection timeout and
  announced on the output channel.
- Node.js shims (Homebrew, nvm, fnm, volta) resolve to the real installation
  before `npm-cli.js` is looked up.
- A runtime install that fails on a not-yet-published version says so.

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

[0.6.1]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.6.1
[0.6.0]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.6.0
[0.5.0]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.5.0
[0.4.7]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.4.7
