# Local shader inspection audit

The audit calls the local inspector API against existing projects under
`~/Projects/TypeGPU`, using their installed TypeGPU dependencies. Project source
files are inputs only. This validates shader generation and browser WGSL
compilation; it does not exercise rendered gameplay or GPU dispatch results.

| Project | Installed TypeGPU | Cases | Results with WGSL | Blocked results |
| --- | --- | --- | --- | --- |
| TypeGPU docs | 0.12.4 | Private geometry helpers, bitpacked compute and helpers, explicit array context | 11 | 1 without the array argument context |
| TypeGPUFire | 0.11.9 | Palette helpers, nested simulation helpers before and after factory setup | 4 | 2 before factory setup |
| TypeGPUStage | 0.11.8 | Default and debug material shaders, parameterized material composition | 3 | 0 |
| TypeGPURL | 0.11.9 | CartPole reset and accessor-bound dynamics | 2 | 0 |

There are **23 target results across 10 cases and 6 modules: 20 compiled, 3
blocked**. Two compiled results pass without assumptions; the other 18 use
explicit schema defaults or existing inference and remain assumption-qualified.
Every deliberately incomplete case has a compiling counterpart with the missing
setup or arguments supplied.

## What the audit changed

1. TypeGPUFire's factory requires a device with `timestamp-query` and a query
   set. The explicit fixture supplies these; the inspector does not guess them.
2. After factory setup, its nested `curl` and `jacobiFn` helpers exposed a scope
   bug: the overlay supported reads but not own-property lookup, so the selector
   reader lost `ctx.d.*` and `setup.*`. The fix preserves lazy access to captured
   locals while exposing inspector roots. Both helpers now compile.
3. Generated target handling was replaced with a runtime evaluator for target
   plans. All **16 previously compiled audit results retained identical WGSL
   and outcomes**, including shaders composed through material and accessor
   APIs. Additional contexts bring the final compiled count to 20.
4. Neighboring-caller scanning was removed. None of those 16 results regressed.
   A dedicated regression test confirms that a neighbor-only binding is blocked
   until setup explicitly imports the caller.
5. Instrumentation now receives declaration offsets from the target request.
   It captures those bindings without recognizing constructor spellings or
   collecting unrelated closures.

The Game of Life helper with an unbounded `number[]` parameter remains blocked
without input context. An explicit four-element `u32` array schema compiles it.
This keeps the required array shape visible instead of adding another source
inference heuristic.

## Reproduction and evidence

The reusable [audit script](scripts/project-shader-audit.mts) accepts a JSON
array with `name`, `cwd`, `modulePath`, and either discovered target labels in
`select` or API target descriptors in `targets`. Entries can also supply
`setupBody`, `features`, and other inspection options. It saves full reports,
individual WGSL files, and a summary after each case. Blocked cases are recorded
for review; the script does not treat every blocked result as an audit failure.

On this machine, the selected cases and raw results are kept in the ignored
`.local` directory:

```sh
pnpm --dir inspector exec tsx ../scripts/project-shader-audit.mts \
  ../.local/project-shader-cases.json ../.local/audit-after
```

- [Case manifest](.local/project-shader-cases.json)
- [Before summary](.local/audit-before/summary.json)
- [After summary](.local/audit-after/summary.json)
- [Fire lookup failure with the required device setup](.local/fire-before/summary.json)

Repository checks: 487 unit tests and 73 browser tests pass; type checks and
runtime/server/VS Code builds pass. No installed TypeGPU/Argent MCP tools,
editor installation, publishing, or remote writes were used.

## Complete binding contexts follow-up

The audit was rerun after replacing per-slot borrowing with complete binding
contexts. All **23 results retained identical WGSL and outcomes**: 20 compiled,
3 deliberately blocked. Raw reports are in `.local/audit-contexts`.
The dedicated browser fixture additionally checks two complete contexts with
different generated constants, incomplete contexts that cannot borrow missing
values from siblings, assumption-qualified candidates, and usage selection.

## Helper planning follow-up

The declaration/planner separation and lexical binding changes preserve all
23 audit results: identical WGSL and outcomes, with 20 compiled and three
intentionally blocked. `.local/audit-helper-planning` contains the reports.
The [coverage matrix](HELPER_PLANNING.md) documents additional composition and
shadowing regressions beyond the external-project corpus.

## Runtime factory results follow-up

Replacing factory return-shape inference preserved all **23 baseline results**
with byte-for-byte identical WGSL and unchanged outcomes. Reports are in
`.local/audit-runtime-factories`.

Two additional cases exercise real returned values directly:

- TypeGPUStage: selecting `setup.material` with `member: ["shade"]` and its
  explicit argument schema produces the same 1,416-byte composed shader as the
  previous direct `setup.material.shade` selector.
- TypeGPUFire: enumerating the actual simulation result finds eight resource
  members and skips its CPU `step` callback. The fixture uses the application's
  `timestamp-query` and `texture-formats-tier1` device features. An initial run
  lacking the latter exposed storage-texture validation failures. Requesting
  the application's actual features produces an explicit blocked report because
  this browser adapter does not support `texture-formats-tier1`. Full validation
  of that resource bundle remains unverified on this adapter; the existing Fire
  shader-helper cases remain unchanged.

Cases and reports are in `.local/factory-shader-cases.json` and
`.local/audit-factory-members`. Local browser regressions additionally cover
conditional pipeline/helper branches, computed member names, bare helpers,
explicit member arguments, uncalled factories, getter/callback counters, exact
stage identity associations, and actual WGSL compiler failures.

Current validation: **513 unit tests**, **76 browser tests**, type checks, and
runtime/server/VS Code builds pass. Changes remain local and uncommitted.

## Broader stress test

[The stress-test report](STRESS_TESTING.md) extends this small audit to 512 modules
across 26 project checkouts. It records the JavaScript discovery crash found and
fixed, released-source and pre-factory comparisons, explicit caller recovery,
and the now-fixed native dependency-failure batch stall. The fresh batch finishes;
all 1,382 previously passing results retain identical WGSL and four additional
Confetti checks pass. Current verification passes 514 unit tests and 77 browser
tests, along with type checks and builds.
