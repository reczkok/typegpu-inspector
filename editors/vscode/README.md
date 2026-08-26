# TypeGPU Inspector for VS Code

TypeGPU shader inspection in the editor. The extension runs the module you are
editing in a headless Chromium with WebGPU and reports what TypeGPU produced
back in the TypeScript buffer:

- hovers with generated WGSL, memory layouts, bindings, and pipeline state;
- ✓/✗ inlay hints per declaration;
- WGSL compiler and WebGPU validation diagnostics, mapped onto your source;
- links to the generated `.wgsl` documents and the full inspection report.

## First run

Opening a TypeGPU file starts warming the inspection session in the background;
the status bar shows "TypeGPU warming up" while that happens. Before the first
inspection the extension asks, in a modal dialog, whether it may download
`typegpu-runtime-inspector-mcp` from npm and a Playwright Chromium build
(about 170 MB to download, 550 MB on disk) into its global storage. It then
executes the project's top-level TypeGPU module code inside that browser, so a
module with import-time side effects performs them. The extension declares
itself unsupported in Restricted Mode for the same reason.

Nothing is sent anywhere: no telemetry, no analytics, and no network traffic
beyond those two downloads and whatever the module requests. Deleting the
download is safe. Answer "Not now" to skip inspection for the session, or set
`typegpuInspector.inspectOn` to `off`.

The first inspection in a workspace can take a few minutes; later ones reuse
the warm session and finish in seconds. Node.js 20 or newer is required.

## Settings and commands

Settings live under `typegpuInspector.*` and appear in the settings UI:
inspection trigger, hover and inlay detail, timeouts, and one switch per editor
surface. The
[project README](https://github.com/reczkok/typegpu-inspector#configuration)
documents them.

Under "TypeGPU Inspector:" the command palette offers Restart Server, Show
Output Log, Run Environment Doctor, Select Hover Detail, and Select Inlay
Detail. The status bar item opens the same detail pickers.

## WGSL syntax

WGSL highlighting for hover previews and generated `.wgsl` files uses the
grammar from [wgsl-analyzer](https://github.com/wgsl-analyzer/wgsl-analyzer),
licensed MIT OR Apache-2.0. An installed WGSL extension still enhances the
generated documents.

## Authorship

A significant part of this codebase was written by Claude, Anthropic's Claude
Fable 5 model, working through Claude Code, with the maintainer directing,
reviewing, and testing the work.
