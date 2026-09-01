# Changelog

Changes to TypeGPU Inspector: the Zed extension, the VS Code extension, the
language server, and the runtime inspector. The four packages are versioned
and released together. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.1] - 2026-09-01

### Fixed

- Inspecting a project on TypeGPU 0.11 failed every `'use gpu'` function and
  pipeline with `Cannot read properties of undefined (reading 'length')`. The
  statement-map recorder assumed the 0.12 generator, whose statements resolve
  to `{ code }`, while 0.11 returns the code string; 0.11 exports the
  generator too, so the recorder was installed there. Such a generator now
  passes its output through untouched and records no statement map, so
  diagnostics fall back to the heuristic placement; the failing statement is
  still named.

## [0.8.0] - 2026-09-01

### Added

- A command line interface in the language server package, exposed as the
  `typegpu-inspector` binary and as `typegpu-inspector-language-server`
  without a transport flag. `check [paths...]` discovers the TypeGPU modules
  under files, directories, or globs, inspects them through the runtime, and
  prints the editor's diagnostics compiler-style (`path:line:col: severity:
  message [code]`, related statements as notes, a link into the generated
  WGSL) followed by a summary; it exits 1 on errors or failed targets and 2 on
  usage or environment failures. `--format json` prints the full result,
  `--format github` adds workflow annotations, `--severity` and
  `--warnings-as-errors` tune what counts, `--verbose` lists every target,
  and `--watch` re-checks a changed module and the modules that import it
  while the browser session stays warm. `wgsl <file>` prints a target's
  generated WGSL with the compiler's messages, `report <file>` prints the
  full Markdown report, and `targets [paths...]` lists what a check would
  inspect without running anything. Runtime settings (`--project-root`,
  `--timeout-ms`, `--feature`, `--no-strict-names`,
  `--no-source-mapping`, `--inspector-package`) mirror the editor
  settings. Progress goes to stderr, colors follow the terminal and
  `NO_COLOR`, and `--quiet` silences everything but results. Running the CLI
  without a command on a terminal starts an interactive session on one warm
  browser: check everything, review the targets that failed, search targets
  by name or file, read a target's generated WGSL or its report, open the
  generated file in `$VISUAL`/`$EDITOR`, and watch for changes;
  `interactive [paths...]` and its `i` alias start it explicitly. Results
  are remembered per module until its source changes, so reading WGSL after
  a check is instant. Reports render as terminal text rather than raw
  Markdown, and long lines wrap at spaces inside the guide so paths stay
  intact. Directory walks honor `.gitignore` files above and below the
  walked directories; `--ignore <glob>` skips more and `--no-gitignore`
  turns the rule off, while a file named directly is always inspected.
  `check --target <name>` narrows a run to some targets. A helper that
  fails in several modules is reported once across files, on its own
  statement when that file is in the run, with the other modules' call
  sites listed on an `also in` line; the JSON carries them as `alsoIn` and
  the finding's statement as `finding`. `check --console` prints what the
  modules wrote to the console while they ran, one line per call with
  repeats counted, and the JSON output carries the messages per file.
  `check --evaluate` also imports modules that use TypeGPU but declare no
  target (a factory that builds its pipelines inside a function) and reports
  whether the import threw, what its GPU calls came back with, and what it
  logged; the module counts as one target named after its file.

### Fixed

- A type-only import of a package the browser build cannot parse no longer
  breaks the module. The runtime added every import of the inspected source
  to Vite's prebundle list, `import type { … } from 'react-native-webgpu'`
  included, which dragged React Native's Flow-typed entry into the optimizer.
  Erased imports stay out of the list.
- A dependency Vite's optimizer cannot bundle no longer takes the runtime
  down. Vite 8 reports that failure as an unhandled rejection on a cold
  server and through its logger on a warm one, and the rejection ended the
  process, so every later module in the same run reported `Not connected`
  per target. The runtime now catches both, fails the one inspection with
  the compiler's reason, the failing file, and the import of the inspected
  module that pulled the package in (`water.ts:15 imports
  'react-native-webgpu', which depends on 'react-native'`), and retires the
  wedged server; the next module gets a fresh one.
- The language server reconnects to the runtime after it dies. The client
  kept a closed transport, so every inspection after a crash failed with
  `Not connected`; a closed transport now drops the client, the error
  counts as a lost connection, and the runtime's last words on stderr go
  into the message once rather than as a tail of every launch.
- A module that cannot run is reported once. Whether the runtime threw or
  every target came back with the same account, the CLI printed it once per
  target; it now prints one report on the first target, and the verbose
  listing still marks every target failed.
- Inspectors started together no longer race to download Chromium: the
  download takes a lock in the temp directory, and the others find the
  browser installed when it is released.
- The CLI launched through a symlink (a global `bin` link, a package's
  `.bin` entry) missed the checkout or install beside it and fell back to
  `npx`. The server now locates itself through its module URL, which Node
  resolves through symlinks, instead of `argv[1]`.

- Zed inspections no longer need the network after the first install. The
  language server launched the runtime through `npx`, which contacts the npm
  registry on every start even when the package is cached, so an inspection
  failed offline. The server now runs the `typegpu-runtime-inspector-mcp`
  copy installed in a `node_modules` directory above it when the versions
  match, and the Zed extension installs that copy when the language server
  starts instead of only when the agent's context server does. The same
  lookup keeps the CLI off the network in a project that installs both
  packages as dev dependencies. `npx` remains the fallback when neither a
  monorepo checkout nor such an install exists.
- The Zed extension no longer probes the monorepo checkout it was compiled
  from: the wasm sandbox cannot see outside the extension work directory, so
  a dev extension always ran the npm-published server. The README documents
  `lsp.typegpu-inspector.binary` as the way to run a local build in Zed.

## [0.7.0] - 2026-08-27

### Added

- Statement-level source mapping. On TypeGPU 0.12 or newer the runtime
  inspector records, while TypeGPU generates WGSL, which authored statement
  produced each line (`statementMap` on every target report), and the
  language server places compiler diagnostics and resolution errors on that
  statement. A helper inlined into another target's WGSL maps to its call site
  with the statement as related information, or sits on the statement itself
  when the helper reports nothing of its own (uniformity errors only exist in
  the caller's context). Helpers imported from other files map too: the
  server follows the document's imports (relative paths, `.js`-for-`.ts`
  specifiers, and `tsconfig` path aliases; packages are skipped), and a
  diagnostic inside such a helper sits on the call site with the helper's
  statement, in its own file, as related information; when the target
  reaches the helper only through other helpers, the anchor is the call
  nearest to it (`in evaluateLight (pbr.ts) via shade`); import aliases and
  re-exports along the way are followed. One finding is
  reported once: every target that inlines a broken helper reports it, and
  the best-anchored report keeps the squiggle and its hover lists the other
  targets (the first declaration, when no call reaches the helper). A
  statement in another file is
  also named in the message (`— in shade (pbr.ts:98) via evaluateLight`),
  and hovering the diagnostic shows a link to it, since not every editor
  renders related information that points into another file. Compiler notes join
  the error or warning they explain as related information instead of
  appearing as diagnostics of their own. Older TypeGPU versions keep the
  token heuristics.

### Fixed

- A compiler selection that merely contains a call (an operator's operand)
  no longer pins the diagnostic to that call's callee.

## [0.6.1] - 2026-08-26

### Changed

- VS Code: the extension icon is the TypeGPU mark with binoculars, and the
  first-run dialog is shorter.

## [0.6.0] - 2026-08-26

### Added

- VS Code: a generated-WGSL document beside the editor. It follows the cursor
  across targets, shows the compiler's diagnostics in place, and has a
  CodeLens back to the source. Hovers link to it as Open WGSL and Peek.
- VS Code: an inspection report beside the editor, rendered in the Markdown
  preview.
- `hoverDetailLevel: "wgsl"`: generated WGSL only for shaders and pipelines.
  The WGSL now comes before the tables at every level, and
  `hoverPresentation.wgslPreviewLines` accepts up to 400.
- `hoverPresentation.maxColumns` bounds hover table width (72 in Zed, 96
  elsewhere). A wider table renders as key/value lines.
- Language server requests `typegpu/targets`, `typegpu/wgsl`, and
  `typegpu/report` for editor views.
- An open document that changes on disk, for example one written by an agent,
  is inspected as if it had been saved.

### Changed

- Zed is installed as a dev extension; the extension is not in Zed's registry.
- VS Code: the TypeScript quick info renders above the TypeGPU hover.
- Hovers are datasheets: one two-column table per role, usage names instead of
  bitmasks, bindings as group:binding with name, type, and stages. `standard`
  summarizes synthesized inputs in one line; `deep` keeps the full ledger.
- MCP tool results repeat the JSON payload in the text block, for clients that
  show only text.
- A failed TypeGPU resolution is classified `source`, not `harness`, and no
  longer mentions the inspector's probe wrappers.
- A compiler diagnostic that maps only to a declaration no longer claims an
  approximate location; the related location names the generated WGSL line.
- Documentation rewritten, with an authorship note.

## [0.5.0] - 2026-08-26

First public release: VS Code Marketplace, and Zed as a dev extension.

### Added

- TypeGPU 0.12 support (`typegpu` 0.12.3, `unplugin-typegpu` 0.12.2),
  including the named `tgpu` import.
- Resource hovers for the 0.12 types: root, guarded compute pipelines, command
  encoders, render and compute passes, render bundle encoders.
- VS Code: icon, gallery banner, a first-run notice before anything is
  downloaded, and Workspace Trust support (the server stays off in Restricted
  Mode).
- `pnpm bump <version>` and this changelog.

### Changed

- Runtime inspection is quiescent by default on every path: frame loops,
  ResizeObserver, queue submits, and draw/dispatch are stubbed before import,
  so an import-time render loop cannot lose the WebGPU device. Pass
  `quiescent: false` to observe real frame behavior.
- VS Code activates cheaply and starts the language server once a TypeGPU
  import is seen.
- Version strings are injected at build time from each package's
  `package.json`.
- The runtime installer no longer needs `npm` on `PATH`; it falls back to the
  `npm-cli.js` next to the discovered `node`.
- The published language server bundle is minified.

### Fixed

- The first-run Chromium download is excluded from the inspection timeout and
  announced on the output channel.
- Node.js shims (Homebrew, nvm, fnm, volta) resolve to the real installation
  before `npm-cli.js` is looked up.
- A runtime install that fails on a not-yet-published version says so.

## [0.4.7] - 2026-08-05

### Changed

- The runtime inspector installs into the editor's global storage with a
  cross-window lock.
- Warm-up runs once per cold session, and the session is released after the
  last TypeGPU document closes.
- MCP output is compacted with failure categories.
- Slot placeholders are recursively non-degenerate.
- The inspector bin runs the built `dist` entry.

## [0.4.0] - [0.4.6]

Internal iterations: hover and inlay surface work, discovery and diagnostics
tuning, packaging experiments. Not published to any store.

[0.8.1]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.8.1
[0.8.0]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.8.0
[0.7.0]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.7.0
[0.6.1]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.6.1
[0.6.0]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.6.0
[0.5.0]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.5.0
[0.4.7]: https://github.com/reczkok/typegpu-inspector/releases/tag/v0.4.7
