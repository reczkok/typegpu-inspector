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

Without a transport flag the same bundle is a command line tool, also
exposed as the `typegpu-inspector` binary:

```sh
typegpu-inspector                              # interactive session on a terminal
typegpu-inspector interactive src              # same, scoped to src (alias: i)
typegpu-inspector check src            # diagnostics, exit 1 on errors
typegpu-inspector check src --watch    # re-check on save, browser stays warm
typegpu-inspector check src -t shade   # only the targets named
typegpu-inspector wgsl src/blur.ts -t blurCompute
typegpu-inspector report src/blur.ts
typegpu-inspector targets src          # what a check would inspect; nothing runs
```

The interactive session keeps one browser warm while you fuzzy-search targets,
check them, read generated WGSL or reports, open generated files in
`$VISUAL`/`$EDITOR`, and watch for changes.

`check` prints `path:line:col: severity: message [code]` lines with the
related statements as notes and a link into the generated WGSL, then a summary;
`--format json` and `--format github` serve scripts and workflow
annotations. Directory walks honor `.gitignore`; `--ignore <glob>` skips more.
Run `typegpu-inspector help <command>` for every option. The
repository README documents the commands.

On first use it starts the runtime inspector: the checkout's copy when run
from the monorepo, otherwise a `typegpu-runtime-inspector-mcp` of the same
version found in a `node_modules` directory above the server (a project's
dev dependencies, or Zed's extension directory), otherwise `npx`, which
contacts the npm registry on every launch. Two environment variables steer
that:

| Variable | Effect |
| --- | --- |
| `TYPEGPU_INSPECTOR_RUNTIME_DIR` | Absolute directory to install and launch the inspector from, checked before the `node_modules` lookup. VS Code sets it. |
| `TYPEGPU_INSPECTOR_NODE` | Absolute path to a Node.js binary whose installation includes npm, used when `npm` is not on `PATH`. |
