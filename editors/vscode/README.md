# TypeGPU Inspector for VS Code

TypeGPU shader inspection in the editor. The extension runs the module you are
editing in a headless Chromium with WebGPU and shows what TypeGPU produced, in
the TypeScript buffer:

- hovers with generated WGSL, memory layouts, bindings, and pipeline state,
  below the TypeScript quick info;
- a generated-WGSL document and an inspection report beside the editor, both
  following the cursor;
- ✓/✗ inlay hints per declaration;
- WGSL compiler and WebGPU validation diagnostics, mapped onto your source.

## First run

Opening a TypeGPU file starts warming the inspection session in the background;
the status bar shows "TypeGPU warming up" meanwhile. Before the first
inspection the extension asks, in a dialog, whether it may download
`typegpu-runtime-inspector-mcp` from npm and a Playwright Chromium (about
170 MB to download, 550 MB on disk) into its global storage. It then runs the
project's top-level TypeGPU module code inside that browser, so a module with
import-time side effects performs them. For the same reason the extension
stays off in Restricted Mode.

Nothing is sent anywhere. There is no telemetry, and the only network traffic
is those two downloads plus whatever the module requests itself. Deleting the
download is safe. Answer "Not now" to skip inspection for the session, or set
`typegpuInspector.inspectOn` to `off`.

The first inspection in a workspace can take a few minutes; later ones reuse
the warm session and finish in seconds. Node.js 20 or newer is required.

## Generated WGSL beside the editor

The editor title of a TypeGPU file has an "Open Generated WGSL to the Side"
button. The document it opens follows the cursor: move onto another pipeline
or shader function and it shows that target's WGSL, with the compiler's
diagnostics in place and a link back to the source at the top. "Pin" keeps one
target open in its own tab. Hovers offer the same document as *Open WGSL* and
*Peek*. "Open Inspection Report to the Side" does the same for the full report,
rendered in the Markdown preview.

A file written by a tool or an agent while it is open is inspected as if you
had saved it.

## Settings and commands

Settings live under `typegpuInspector.*` and appear in the settings UI:
inspection trigger, hover and inlay detail, timeouts, and one switch per editor
surface. The
[project README](https://github.com/reczkok/typegpu-inspector#configuration)
documents them.

Under "TypeGPU Inspector:" the command palette offers Open Generated WGSL to
the Side, Open Inspection Report to the Side, Restart Server, Show Output Log,
Run Environment Doctor, Select Hover Detail, and Select Inlay Detail. The
status bar item opens the same menu.

## WGSL syntax

WGSL highlighting for hover previews and generated `.wgsl` files uses the
grammar from [wgsl-analyzer](https://github.com/wgsl-analyzer/wgsl-analyzer),
licensed MIT OR Apache-2.0. An installed WGSL extension still enhances the
generated documents.

## Authorship

A significant part of this codebase was written by Claude, Anthropic's Claude
Fable 5 model, working through Claude Code, with the maintainer directing,
reviewing, and testing the work.
