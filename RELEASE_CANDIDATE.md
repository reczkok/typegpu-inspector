# Release acceptance: 0.10.0 · September 8, 2026

The runtime, language server, VS Code extension and Zed extension are versioned
at **0.10.0**. Local artifacts, dependency versions and verification logs are
under `.local/publication/0.10.0` (ignored by Git).

## Acceptance results

| Check | Result |
| --- | --- |
| TypeScript checks and builds | Passed across runtime, server and VS Code |
| Unit tests | 316 server + 252 runtime passed; 14 browser-gated runtime tests skipped |
| Browser tests | 81 passed |
| CLI/LSP smoke | Passed with current hover layout and inspection completion notifications |
| Rust | Check, formatting, Clippy with warnings denied, optimized wasm32-wasip2 build passed |
| Frozen dependency installation | Passed without lockfile changes |
| Clean packaged installation | Both npm server and extracted VSIX server passed CLI/LSP acceptance |

Packaged acceptance verifies private helpers, separate captured closures,
explicit specialization selection and refresh, factory-returned helpers,
caller-derived u32 probes matching pipeline WGSL, compiler failures and
same-process recovery. It also checks direct WGSL links, generated diagnostics,
offset-changing edits and dependency-failure recovery.

The npm and VSIX server bundles are byte-for-byte identical. Their SHA-256 is
`f8688ed01427934160e32fb7071a6c4d7cfaddfcbb86796f547eaa494b6683a0`.

A fresh npm installation outside the repository used an empty dedicated npm
cache, normal install scripts, and the two final tarballs. It resolved TypeGPU
0.12.3, Vite 8.2.2, TypeScript 6.0.3, Playwright Chromium 1.63.0 and
unplugin-typegpu 0.12.2. The existing machine browser cache remained available.
The VSIX was extracted inside that installation so its server could discover
the packaged runtime in an ancestor node_modules, without environment overrides.

All checks for this release preparation were headless. No editor was launched
or controlled. The user previously confirmed the Zed changes in their live
setup. Earlier native editor checks and their limits are documented in
[EDITOR_REMASTER.md](EDITOR_REMASTER.md).

## Cross-project evidence and scope

Two repeated passes over 29 selected app targets retained existing outcomes.
Factory-return inference enabled WeatherVis's two previously blocked helpers;
eleven selected helper bodies matched pipeline specializations. Caller-derived
numeric probing changed only cloth's isPinned WGSL to u32, matching its pipeline
function. Three cloth shaders compiled with synthesized accessor bindings.
Evidence and implementation boundaries are in [EDITOR_REMASTER.md](EDITOR_REMASTER.md).

The broader 0.9.0 corpus is historical evidence, not a repeated 0.10.0 full-corpus
run; see [STRESS_TESTING.md](STRESS_TESTING.md). Inference remains deliberately
bounded: ambiguous factory returns, unknown caller expressions and runtime-sized
accessors can still require explicit context. Synthesized inputs are identified
as assumptions, and compilation does not establish application correctness.

## Reproduction

Install the runtime and server tarballs into an isolated directory, then run:

```sh
node scripts/release-smoke.mjs \
  /absolute/install/node_modules/typegpu-inspector-language-server/dist/server.cjs \
  /absolute/install \
  .local/release-smoke
```

For the VSIX, extract it below the same installation and pass its
`extension/dist/server.cjs`. The script imports only Node APIs and removes
runtime-directory and NODE_PATH overrides before launching children. Reports
and fixtures remain available for inspection. The temporary installation path
is recorded in `.local/publication/0.10.0/install-path.txt`.
