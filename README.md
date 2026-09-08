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
cd typegpu-inspector && git checkout v0.8.4
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
| `contextFile` | `typegpuInspector.contextFile` | `""` | JSON inspection fixture, relative to the project root; shared with CLI `--context-file` |
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
the editor, with repeated source failures grouped across modules:

```sh
npx -p typegpu-inspector-language-server typegpu-inspector check src
```

Discovery is exploratory: its summary distinguishes shader failures, blocked
or unsupported checks, and successful checks made with inspection assumptions.
Hints are counted but hidden by default; `--severity hint` shows their details.
For CI, export a configured pipeline or caller fixture and select it explicitly:

```sh
typegpu-inspector check test/shaders.ts -t configuredPipeline --require-concrete --json
```

`--require-concrete` rejects assumptions and empty selections as well as errors
and incomplete checks. A pass validates that configuration's generated WGSL and
pipeline creation. It does not test rendered output or every application branch.
Use `report` to inspect the provenance ledger and missing setup.

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

### Private helpers and specialization contexts

Private symbols are inspected through references in the original module. A
shader helper declared inside a CPU factory is listed as `factory.helper`.
When that declaration executes more than once, the inspector compiles each
captured shader separately and labels the results `[instance 0]`, `[instance 1]`,
and so on. Instances keep the closures and slot identities created by the app.
The JSON report includes the source revision and instance index.

Use `--instance 1` to select one instance. Indices follow execution order and
apply to that run, so give important specializations a reproducible fixture:

```json
{
  "module": "./src/blur.ts",
  "setupBody": "module.makeBlur(3); module.makeBlur(7);",
  "targets": {
    "makeBlur.helper": { "label": "radius 7", "instance": 1 }
  }
}
```

With that file saved as `blur.inspection.json`:

```sh
typegpu-inspector wgsl src/blur.ts -t makeBlur.helper --context-file blur.inspection.json
```

This example assumes the app has not already called `makeBlur`. Setup runs
after the module import; existing calls contribute instances too. A factory
that never executes produces a blocked result with a setup hint. The inspector
does not invoke CPU factories automatically.

Each target context can also supply `arguments` (an array of `{ "value":
"setup.input" }`, `{ "schema": "ctx.d.vec3f" }`, or `{ "refSchema":
"ctx.d.vec3f" }`) and `with` (an array of `{ "slot": "module.quality",
"value": "setup.quality" }`). Setup can return the referenced values. Schema
arguments create zero values; reference schemas create mutable reference
locals. Explicit contexts disable automatic binding inference for that target.
The editor uses the same fixture through `contextFile` (VS Code:
`typegpuInspector.contextFile`). Other modules are inspected normally. Save the
shader file after changing the fixture to rebuild its contexts.

Bindings observed on a pipeline or bound function stay together as a complete
set. The inspector produces separate `[usage N]` results for distinct sets;
`--usage N` (or `"usage": N` in a fixture) selects one. Usage indices are local
to the run; reproducible fixtures should prefer explicit `with` values.
Usage selection and explicit `with` are mutually exclusive. Closure `instance`
and binding `usage` are independent and can be selected together.

Reports distinguish a direct shader relationship (`association: "direct"`)
from a set that merely binds a required slot (`association: "candidate"`).
Candidates remain `passed-with-assumptions` even when they compile. Missing
bindings inside a selected set remain blocked; no other set or schema default
fills them in. Schema-only probes remain available when no set matches.

When a helper is blocked, the editor and CLI suggest static module importers,
including aliases and barrel exports. These are leads, not proven shader call
sites. The search reads at most 1,000 source files of at most 1 MB each and
returns up to 20 leads, marking limited results as `truncated`. It never executes
those modules. Load a chosen caller explicitly in fixture setup, for example
`await import('./configured-pipeline.ts');`, or supply the needed values directly.

Inferred helper arguments use one plan format. Complete sampler/texture argument
tuples from different calls produce separate probes, labeled by source location;
partial calls never fill one another's missing arguments. Reports expose the
plan's source and missing inputs in `context.probe`. These probes remain
assumption-qualified. See the [helper planning coverage matrix](HELPER_PLANNING.md).

Nested capture currently covers named shader variable declarations and GPU
function declarations in CPU function blocks. Shader functions declared inside
another GPU body are inspected through the enclosing shader. Returned bundles are enumerated from actual runtime values as described below.
Other anonymous or unreachable values need an accessible target or explicit probe.
An imported module must be able to run in the inspection browser. Partial
inspection selects what to compile; it still executes the selected module's
initialization.

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

### Factory results

Discovery identifies bindings initialized from local TypeGPU factory calls and
result aliases. It no longer predicts factory return shapes. Inspecting a result
walks its actual records and arrays and reports the shaders, pipelines, schemas,
and resources present in that run. Computed property names, destructuring, and
conditional branches therefore use their actual values and object identities.

The editor can select the resulting members independently. A reusable CLI/editor
fixture can select an exact property path and specialize a returned helper:

```json
{
  "module": "./src/shaders.ts",
  "targets": {
    "bundle": {
      "member": ["odd.key", "0"],
      "arguments": [{ "schema": "ctx.d.f32" }]
    }
  }
}
```

Each array index is a string; a property containing a dot remains one segment.
`member: []` selects the result itself. Reports retain the path in
`context.resultPath`. Without an argument/binding context, a member selection
keeps normal observed binding discovery enabled. Supply a member before applying
specialization arguments or bindings to a bundle.

Traversal preserves aliases, terminates cycles, and does not invoke getters or
returned CPU functions. It covers enumerable string-keyed properties of records
and arrays, with limits of 12 nesting levels, 2,048 visited values, and 128
results. Getters and exceeded limits produce blocked results alongside successful
members. Arbitrary class instances and symbol-keyed members are outside this
traversal; expose their shader values through explicit setup.

Returned parameterized bare helpers still need a probe argument context; their
named nested declarations can also use the existing source argument planner.
Pipeline-stage links use recorded descriptors and object identity after runtime
inspection. Before then, stage probes remain independently available. Factories
that have not run still need explicit setup; no neighboring modules are executed
to create their results.
