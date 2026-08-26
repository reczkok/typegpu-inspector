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

## What it downloads and runs

The extension asks once, before the first inspection, and then downloads into
its own global storage directory:

- `typegpu-runtime-inspector-mcp` — the runtime inspector, from npm;
- a Playwright Chromium build (~150 MB) — the headless browser it runs in.

It then executes your project's **top-level TypeGPU module code** in that
browser. That is what makes real pipelines, real memory layouts, and the
actually generated WGSL available in the editor, and it also means a module
with import-time side effects will perform them. For that reason the extension
declares itself unsupported in Restricted Mode: trust the folder to enable it.

Nothing is sent anywhere — no telemetry, no analytics, no network traffic
beyond those two downloads and whatever your own module requests. Results
never leave your machine.

The runtime lives in the extension's global storage:

- macOS: `~/Library/Application Support/Code/User/globalStorage/reczkok.typegpu-inspector/runtime`
- Linux: `~/.config/Code/User/globalStorage/reczkok.typegpu-inspector/runtime`
- Windows: `%APPDATA%\Code\User\globalStorage\reczkok.typegpu-inspector\runtime`

Playwright's browsers are cached separately in `~/Library/Caches/ms-playwright`
(macOS), `~/.cache/ms-playwright` (Linux), or `%LOCALAPPDATA%\ms-playwright`
(Windows). Deleting either is safe — the next inspection re-downloads what it
needs. Answer "Not now" to the first-run notice to skip runtime inspection for
the session, or set `typegpuInspector.inspectOn` to `off` permanently.

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
