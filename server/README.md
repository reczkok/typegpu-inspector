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
typegpu-inspector check src            # exploratory checks, exit 1 on findings or incomplete checks
typegpu-inspector check src --watch    # re-check on save, browser stays warm
typegpu-inspector check src -t shade   # only the targets named
typegpu-inspector wgsl src/blur.ts -t blurCompute
typegpu-inspector report src/blur.ts
typegpu-inspector targets src          # what a check would inspect; nothing runs
```

The interactive session keeps one browser warm while you fuzzy-search targets,
check them, read generated WGSL or reports, open generated files in
`$VISUAL`/`$EDITOR`, and watch for changes.
Bulk checks and watch show errors and warnings; hint/info counts stay in the
summary. Pick a target and choose Check to see its full diagnostic details.

`check` prints `path:line:col: severity: message [code]` lines with the
related statements as notes and a link into the generated WGSL, then a summary;
`--format json` and `--format github` serve scripts and workflow
annotations. Directory walks honor `.gitignore`; `--ignore <glob>` skips more.
`check` defaults to errors and warnings. Add `--severity hint` to include all
diagnostics. Filtering only changes diagnostic details: summary counts, exit
status, and `--warnings-as-errors` still use all findings.

The summary separates shader failures from targets blocked by missing setup,
unsupported targets, and targets that were not inspected. These incomplete
checks exit with status 1. Successful checks that substituted inspection values
are counted as passing with assumptions; they do not validate the application's
actual bindings. JSON preserves each target's `outcome` and includes separate
`blocked`, `unsupported`, `notInspected`, and `assumed` counts. Unknown requested
target names set `ok: false` and appear in `unmatchedTargets`.
Blocked/unsupported targets carry concise `notes` with their missing setup or
unsupported operation even when `--severity` hides detailed diagnostics.

For CI, provide a small module exporting the actual configured pipeline or a
caller that exercises the intended shader with its real bindings, then select
that target explicitly:

```sh
typegpu-inspector check test/shaders.ts -t configuredPipeline --require-concrete --json
```

`--require-concrete` also exits 1 for assumption-qualified checks and for an
empty selection. The JSON result records `requireConcrete: true`. Synthesized
values, arguments, descriptors, bindings borrowed from another caller, and
structural-only inspections are all assumption-qualified. Use `report` on the
target to see its provenance ledger and supply missing setup. A concrete pass
means the inspected WGSL/pipeline was accepted with the supplied configuration;
it does not assert correct pixels, runtime data, or coverage of every branch.
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
