# TypeGPU Inspector

An editor extension for Zed and VS Code. It runs the TypeGPU module you are
editing in a headless Chromium with WebGPU and shows the WGSL and runtime
descriptors TypeGPU produced, in the TypeScript buffer.

It is a heavy tool and may not be for everyone. It keeps a Chromium and a Vite
server running next to your editor and re-runs your module on every save.
Expect about 550 MB on disk, a few hundred MB of memory while it works, and a
first run that takes minutes. It executes the module's top-level code, much
like starting your dev server. If you only want syntax highlighting, a WGSL
grammar is enough.

## What you get

- Hovers on TypeGPU declarations: generated WGSL, entry points, bindings,
  pipeline state, resource descriptors.
- Inlay hints with each declaration's inspection status.
- Diagnostics from the WGSL compiler, from WebGPU validation, and from
  TypeGPU's own resolution, placed on the authored statement. With TypeGPU
  0.12 or newer the runtime records which statement produced each generated
  line, so the position is exact; older versions fall back to token matching.
  A helper imported from another file reports at its call site, with the
  helper's statement linked as related information. A problem that several
  targets inherit from one helper is reported once, listing the others.
- Links to the generated `.wgsl` file and the full report. In VS Code, a
  generated-WGSL document and an inspection report open beside the editor and
  follow the cursor.
- Schema layout: offsets, alignment, padding, host shareability, and a tighter
  field order when one is provably smaller.

Recognized: pipelines, shader functions, schemas, buffers, textures, views,
samplers, query sets, bind group layouts and groups, vertex layouts, slots,
accessors, GPU variables, and collections of them.

## Install

**VS Code:** install `reczkok.typegpu-inspector` from the Marketplace.

**Zed:** not in the extension registry, so it is installed as a dev extension.

> [!WARNING]
> A dev extension skips Zed's review. Nobody has checked this code except the
> people who wrote it. Read it before you install it and stay on a release tag.
> It is kept out of the registry because it downloads a headless Chromium and
> runs your project's code, and Zed has no way to ask you first. A clone you
> can read is the closest thing to asking.

```sh
git clone https://github.com/reczkok/typegpu-inspector.git
cd typegpu-inspector && git checkout v0.8.2
```

Then run `zed: install dev extension` and pick that folder. Zed builds it
(needs Rust from rustup) and pulls the language server and runtime from npm on
first use. To update, check out the next tag and install again.

## Requirements

- Node.js 20 or newer on `PATH`.
- About 550 MB of disk for the one-time download (see
  [What it downloads and runs](#what-it-downloads-and-runs)).
- A trusted project. Inspection runs the project's code, so VS Code keeps the
  extension off in Restricted Mode.

## Configuration

Zed reads these keys under `lsp.typegpu-inspector.initialization_options`. VS
Code reads the same names with a `typegpuInspector.` prefix and shows them in
its settings UI.

| Zed key | VS Code key | Default | Meaning |
| --- | --- | --- | --- |
| `inspectOn` | `typegpuInspector.inspectOn` | `"save"` | `save`, `hover`, `save-and-hover`, `off` |
| `warmUpOnOpen` | `typegpuInspector.warmUpOnOpen` | `true` | Prepare the session when a TypeGPU file opens |
| `hoverDetailLevel` | `typegpuInspector.hoverDetailLevel` | `"standard"` | `wgsl`, `compact`, `standard`, `deep` |
| `inlayDetailLevel` | `typegpuInspector.inlayDetailLevel` | `"compact"` | `compact`, `summary`, `detailed` |
| `hoverPresentation` | `typegpuInspector.hoverPresentation` | `{}` | Section visibility, order, budgets |
| `timeoutMs` | `typegpuInspector.timeoutMs` | `45000` | Per inspection; clamped to 1000–600000 |
| `maxWgslBytes` | `typegpuInspector.maxWgslBytes` | `2000000` | Clamped to 16384–64000000 |
| `strictNames` | `typegpuInspector.strictNames` | `true` | TypeGPU strict generated names |
| `features` | not exposed | `[]` | WebGPU features requested from the adapter |
| `hover`, `inlayHints`, `diagnostics`, `documentLinks`, `sourceMapping`, `schemaLayoutHealth`, `schemaPackingSuggestions` | same names, prefixed | `true` | One switch per editor surface |
| `inspectorPackage` | `typegpuInspector.inspectorPackage` | `"bundled"` | `"bundled"` or an npm package name |
| `projectRoot` | `typegpuInspector.projectRoot` | `""` | Override workspace-root inference |

`typegpuInspector.serverPath` is VS Code only and points at a local language
server build. In Zed, set `lsp.typegpu-inspector.binary` to run one; the
extension itself cannot see outside its work directory, so a dev extension
otherwise installs the published server from npm:

```json
"lsp": {
  "typegpu-inspector": {
    "binary": {
      "path": "/path/to/node",
      "arguments": ["/path/to/typegpu-inspector/server/dist/server.cjs", "--stdio"]
    }
  }
}
```

The server then runs the runtime from the checkout's `inspector/` directory.

`wgsl` shows only the generated WGSL for shaders and pipelines (120 lines by
default) and compact facts for everything else. At every level the WGSL comes
before the tables. Hover and inlay detail are independent. `hoverPresentation`
sets each section to `auto`, `show`, or `hide`, reorders them with
`sectionOrder`, and bounds the ones that can grow. `maxColumns` (72 in Zed, 96
elsewhere) is the widest table a hover renders; a wider one is written as
key/value lines. VS Code's settings schema lists the section names and ranges.
`sourceMapping` is exact at statement level on TypeGPU 0.12 or newer and
heuristic below that. Helpers in imported files are located through the
document's imports (`tsconfig` path aliases included; packages are skipped).
A diagnostic always links to the generated WGSL.

Invalid values are dropped and logged. Changes apply without a restart, except
`serverPath`.

## What it downloads and runs

The extension downloads `typegpu-runtime-inspector-mcp` from npm (Zed when
the language server starts, VS Code before the first inspection) and a
Playwright Chromium build (about 170 MB to download, 550 MB on disk), once
per machine; after that, inspection works offline. Each inspection runs the
project's top-level TypeGPU module code inside that browser, so a module with
import-time side effects performs them. VS Code asks once, in a dialog,
before the first download.

Nothing is sent anywhere. There is no telemetry, and the only network traffic
is those two downloads plus whatever the inspected module requests itself.

VS Code keeps the inspector under
`globalStorage/reczkok.typegpu-inspector/runtime` in its user directory
(`~/Library/Application Support/Code/User`, `~/.config/Code/User`, or
`%APPDATA%\Code\User`); Zed installs it into the extension's own work
directory. Playwright caches browsers separately in
`~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright`, or
`%LOCALAPPDATA%\ms-playwright`. Deleting either directory is safe. Setting
`inspectOn` to `off` stops the extension from running anything.

## Limitations

- The harness around the module is generated. It covers DOM lookups, assets,
  TypeGPU setup, and resource creation. A module that needs an application
  shell, a login flow, or a remote API at import time can fail before the
  interesting value is reached.
- Resources, layouts, and pipelines are created and validated; no draw or
  dispatch is submitted. A passing target means WebGPU accepted it. It says
  nothing about what a frame looks like.
- The adapter is usually a software WebGPU implementation, so it says nothing
  about GPU performance or driver behavior.
- Missing shader arguments and slot values are synthesized when the type allows
  it, and the hover says so. Synthesized render targets and vertex inputs are
  inspection defaults; the application's own are not known.
- Packing suggestions are exhaustive up to 14 top-level fields. Larger structs
  get one candidate ordered by alignment and size, so the absence of a
  suggestion does not mean the order is optimal.

## Command line

The language server package is also a CLI, for shells, CI, and agents that
run in a terminal. It uses the same discovery, runtime, and source mapping as
the editor, so it prints exactly the diagnostics the editor shows:

```sh
npx -p typegpu-inspector-language-server typegpu-inspector check src
```

```
src/pbr.ts:98:5: error: shade: uniformity … — in shade (pbr.ts:98) via evaluateLight [wgsl-compilation]
    src/lighting.ts:12:3: note: the statement that produced the line
    wgsl: /tmp/typegpu-inspector/…/pbr__shade.wgsl:40:9

✖ 1 error · 7 targets (6 ok, 1 failed) in 3 files · 1.4s
```

| Command | Does |
| --- | --- |
| `interactive [paths...]` | Opens a terminal session with a fuzzy target picker, checks, generated WGSL, reports, editor integration, and watch mode on one warm browser. Alias: `i`. |
| `check [paths...]` | Inspects every module under the files, directories, or globs (default `.`) and prints one line per diagnostic, then a summary. A helper that fails in several modules is reported once, with the other call sites on an `also in` line; a module that cannot run at all is reported once, not once per target. Exit 1 on errors or failed targets. |
| `wgsl <file>...` | Prints the generated WGSL of each target with the compiler's messages. |
| `report <file>...` | Prints the full inspection report as Markdown: the hover at its deepest level. |
| `targets [paths...]` | Lists what a check would inspect, from source alone. Nothing runs. |

Run `typegpu-inspector` without a command in a terminal to enter the
interactive session for the current directory. Check everything and review
the targets that failed, or pick a target by name or file and check it, read
its generated WGSL or full report, open the generated file with
`$VISUAL`/`$EDITOR`, or keep watching changes — all without restarting
Chromium, and with each module's result remembered until its source changes.

`check` takes `--format text|json|github` (`github` adds workflow
annotations), `--severity error|warning|info|hint`, `--warnings-as-errors`,
`--verbose` for per-target status, `--target <name>` to check only some
targets, and `--watch`, which re-checks a changed module and the modules that
import it while keeping the browser session warm. Walks over directories and
globs honor `.gitignore` files and skip dependency and build folders;
`--ignore <glob>` skips more and `--no-gitignore` inspects ignored files too.
A file named directly is always inspected. `--console` prints what the
modules wrote to the console while they ran, one line per call with repeats
counted, so a module that steps a simulation and logs its statistics reads
like a test. `--evaluate` also imports modules that use TypeGPU but declare
no target of their own (a factory that builds its pipelines inside a
function, say) and reports whether the import threw, what its GPU calls came
back with, and, with `--console`, what it logged; such a module counts as
one target named after its file.
`interactive`, `wgsl`, and `report` share the runtime flags. `wgsl` and
`report` take `--target <name>` (a label or symbol name,
repeatable) and `--json`. The runtime settings from the table above are flags
on all three: `--project-root`, `--timeout-ms`, `--feature`,
`--no-strict-names`, `--no-source-mapping`, `--inspector-package`. Run
`typegpu-inspector help <command>` for the rest.

Colors follow the terminal and `NO_COLOR`; progress goes to stderr and
`--quiet` silences it. Exit codes: 0 no errors, 1 errors or failed targets,
2 usage or environment failure. Installed as a dev dependency, the binary is
`typegpu-inspector` in `package.json` scripts.

In a React Native project, name the shader modules rather than a directory:
`App.tsx` and anything else that imports `react-native` at runtime cannot
run in the inspector's browser, and the check says which import pulled the
package in. Type-only imports of React Native packages are fine.

Through `npx` the CLI fetches the runtime from the registry on every run.
To keep it off the network, install both packages at the same version as
dev dependencies; the CLI then launches the runtime found beside it:

```sh
pnpm add -D typegpu-inspector-language-server typegpu-runtime-inspector-mcp
```

## Agent access

The same runtime is a stdio MCP server. The Zed extension registers it; other
clients use the `typegpu-runtime-inspector-mcp` package. See
[`inspector/README.md`](inspector/README.md).

Agents running inside the editor get the same information from diagnostics: a
file an agent writes while it is open is inspected as if saved, and the
results land in the problems panel. Agents in a terminal get it from
`typegpu-inspector check` (see [Command line](#command-line)), which prints
only the diagnostics and needs no target list and no MCP setup.

## Development

Node.js 20 or newer and pnpm are required. Run scripts from the repository
root; the root lockfile is authoritative.

```sh
pnpm setup
pnpm build
```

Checks are `pnpm check`, `pnpm test`, `pnpm test:browser`, `pnpm test:e2e`, and
`cargo check`; `pnpm validate` runs all of them.
`node inspector/bin/typegpu-runtime-inspector-mcp.mjs doctor` checks Node, npx,
and the Chromium/WebGPU launch.

In Zed, run `zed: install dev extension` and select the repository root. When
`server/dist/server.cjs` exists in the checkout the dev extension uses it
instead of the npm package, so rerun `pnpm build` and restart the language
server after changing it.

In VS Code, build and install a local VSIX. It embeds the language server, so
rebuilding the server alone does not update an installed extension.

```sh
pnpm --dir editors/vscode package
code --install-extension editors/vscode/typegpu-inspector-*.vsix --force
```

`src` holds the Rust Zed extension, `server` the language server and editor
presentation, `inspector` the Chromium runtime and MCP server, and
`editors/vscode` the VS Code client.

### Releases

All four packages move together. `pnpm bump <version>` rewrites the version in
`Cargo.toml`, `extension.toml`, and the four `package.json` files; run
`cargo check` to refresh `Cargo.lock`, then record the release in
`CHANGELOG.md`. Other version strings are injected at build time.

Tags drive the release workflows: `inspector-v<version>` and
`server-v<version>` publish the npm packages through trusted publishing, and
`v<version>` builds the VSIX as a workflow artifact. The Marketplace upload is
manual.

## Authorship

A significant part of this codebase was written by Claude, Anthropic's Claude
Fable 5 model, working through Claude Code. The maintainer directed the work,
reviewed the changes, and tested them.

## License

MIT. See [LICENSE](LICENSE).
