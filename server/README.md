# TypeGPU Inspector Language Server

A stdio LSP server that runs TypeGPU modules through a real Chromium/WebGPU
runtime and reports the results in the editor: hovers with generated WGSL and
exact memory layouts, inlay hints, compiler diagnostics mapped back to
TypeScript, and links to the complete generated `.wgsl` documents.

The single-file `dist/server.cjs` bundle is self-contained. On first use it
launches the runtime inspector; in standalone installs the inspector is
fetched as `typegpu-runtime-inspector-mcp` via `npx`, which downloads
Playwright Chromium once.

This package is consumed by the
[TypeGPU Inspector](https://github.com/reczkok/typegpu-inspector) editor
extensions for Zed and VS Code. Settings and behavior are documented in that
repository.

```sh
typegpu-inspector-language-server --stdio
```
