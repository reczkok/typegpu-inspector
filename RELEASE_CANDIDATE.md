# Local package acceptance: September 8, 2026

The runtime tarball, language-server tarball, VS Code VSIX, and Zed WebAssembly
extension are prepared locally as **0.9.0**. The release contains the shader
inspection refactor from `e38dfb8` and the synchronized version/changelog update.
No tags, remote writes, or package publication were performed.

Artifacts, SHA-256 hashes, dependency versions, and logs are under
[`.local/release-candidate/0.9.0`](.local/release-candidate/0.9.0).
The [manifest](.local/release-candidate/0.9.0/manifest.json) identifies the exact
packages tested:

- `typegpu-runtime-inspector-mcp-0.9.0.tgz`
- `typegpu-inspector-language-server-0.9.0.tgz`
- `typegpu-inspector-0.9.0.vsix`
- `typegpu-inspector-0.9.0.wasm`

## Acceptance results

The same workflow was run against the npm server and the server extracted from
the VSIX. Their server bundles are byte-for-byte identical.

| Workflow | Checked result |
| --- | --- |
| Private helper | Listed by the CLI; generated WGSL available through CLI and LSP |
| Non-exported nested helper | Two captured closures produce separate shaders containing their actual constants; CLI/LSP WGSL matches exactly |
| Explicit specialization | Fixture setup creates a third closure; selecting instance 2 produces the constant 11 and preserves the context label |
| Context refresh | Changing LSP configuration and saving refreshes the target list and generated WGSL |
| Compiler error | CLI exits 1; LSP exposes the invalid WGSL, compiler message, generated-code range, and source diagnostic |
| Shader recovery | Restoring the source clears error diagnostics and restores the original WGSL without restarting the language server |
| Dependency failure recovery | Malformed dependency produces an attributed failure; a later shader inspection succeeds in the same language-server process |

Both packaged suites pass after a clean npm installation. The existing built
CLI/LSP smoke tests also pass. Repository verification passes 514 unit tests,
77 browser tests, type checks, and builds. Rust checks include `cargo check`,
formatting, Clippy with warnings denied for `wasm32-wasip2`, and the optimized
Zed WebAssembly build. The user confirmed that the refactor works in their live
Zed setup before this version bump.

The preceding cross-project stress results remain documented in
[STRESS_TESTING.md](STRESS_TESTING.md): all 1,382 previously passing results retain
identical WGSL, with four additional Confetti passes and no native batch stall.

## Clean installation

The final 0.9.0 tarballs were installed together in a new directory outside the
repository using `npm install` with an empty, dedicated npm cache. No workspace
lockfile, dependency overrides, offline deployment, or source overlays were used.
Normal install scripts ran; the existing machine browser cache remained available.

This installation resolved Vite **8.2.2**, Playwright **1.63.0**, TypeGPU **0.12.3**,
and unplugin-typegpu **0.12.2**. Package acceptance was run against both the
freshly installed npm server and the server extracted from the final VSIX. Their
server bundles are byte-for-byte identical. The smoke script imports only Node
APIs and removes runtime-directory and `NODE_PATH` overrides before launching.

The earlier 0.8.4 local snapshot's offline install failed because its cached
registry metadata lacked a dependency required by Vite 8.2.2. A fresh online
install resolved that graph successfully; no dependency pins were added to hide
the failure. Historical snapshot evidence remains under
[`.local/release-candidate/e38dfb8`](.local/release-candidate/e38dfb8).

The VS Code UI itself was not launched or installed. Its packaged server and
protocol were exercised directly; the live editor acceptance came from Zed.
The version bump and changelog are complete. Publication remains outside the
current local-only scope.

## Reproduction

[`scripts/release-smoke.mjs`](scripts/release-smoke.mjs) accepts the server bundle,
an isolated project directory with the packaged runtime installed in an ancestor
`node_modules`, and a report directory:

```sh
node scripts/release-smoke.mjs \
  /absolute/install/node_modules/typegpu-inspector-language-server/dist/server.cjs \
  /absolute/install \
  .local/release-smoke
```

For the VSIX, pass its extracted `extension/dist/server.cjs` instead. Fixture
directories and reports are retained for inspection. The local installation path
for this run is recorded in the candidate's `install-path.txt`; its temporary
directory may eventually be removed by the operating system.
