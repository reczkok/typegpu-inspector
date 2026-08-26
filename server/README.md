# TypeGPU Inspector Language Server

The stdio language server behind the
[TypeGPU Inspector](https://github.com/reczkok/typegpu-inspector) extensions for
Zed and VS Code. It runs TypeGPU modules through a headless Chromium with
WebGPU and reports hovers, inlay hints, diagnostics, and links to the generated
`.wgsl` documents. The repository README documents its settings.

Editors launch the single-file `dist/server.cjs` bundle:

```sh
typegpu-inspector-language-server --stdio
```

On first use it starts the runtime inspector, installing
`typegpu-runtime-inspector-mcp` when the checkout does not provide it. Two
environment variables steer that:

| Variable | Effect |
| --- | --- |
| `TYPEGPU_INSPECTOR_RUNTIME_DIR` | Absolute directory to install and launch the inspector from. Without it, standalone installs use `npx`. |
| `TYPEGPU_INSPECTOR_NODE` | Absolute path to a Node.js binary whose installation includes npm, used when `npm` is not on `PATH`. |
