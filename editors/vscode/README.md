# TypeGPU Inspector for VS Code

Deep TypeGPU shader inspection in the editor. The extension runs your TypeGPU
modules through a real Chromium/WebGPU runtime and brings the results back to
the TypeScript buffer:

- hovers with generated WGSL, exact memory layouts, bindings, and pipeline
  state;
- compact ✓/✗ inlay hints;
- compiler and runtime diagnostics mapped back to your source;
- links to the complete generated `.wgsl` documents.

Opening a TypeGPU TypeScript file starts warming the inspection session in the
background; the status bar shows "TypeGPU warming up" while that happens. The
first run in a workspace can take a few minutes — it downloads the runtime
inspector and Playwright Chromium once, then boots and caches a bundler
session. Every later inspection reuses the warm session and finishes in
seconds. Node.js 20+ is required.

The extension bundles WGSL syntax highlighting (grammar vendored from
[wgsl-analyzer](https://github.com/wgsl-analyzer/wgsl-analyzer)) for hover
previews and generated `.wgsl` files. It coexists with dedicated WGSL
extensions — if you have one installed, its language server also enhances the
generated shader documents.

All settings live under `typegpuInspector.*` — inspection trigger, timeouts,
and per-surface feature toggles. See the
[project repository](https://github.com/reczkok/typegpu-inspector) for full
documentation.

Hover depth and inlay density are configured independently. The defaults are a
role-adaptive `standard` hover and status-only `compact` inlays; use the
TypeGPU status-bar menu to select either one. Hovers keep complete schema
fields, bindings, render targets, vertex attributes, and resource descriptors.
Only unbounded material such as WGSL excerpts, collections, declarations,
notes, and provenance is budgeted. A complete generated inspection report is
linked near the top of every completed target hover.
