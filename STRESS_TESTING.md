# Inspector stress test: September 8, 2026

The factory refactor preserves the shader coverage tested here. The native batch
stall found by the first sweep is now fixed: a fresh 512-module run finishes,
and all 1,382 previously passing results (including the isolated native shader
checks) retain identical WGSL. Four previously blocked Confetti checks now pass.
The reproduced failure and recovery evidence are recorded below.

## Scope and results

| Check | Scope | Result |
| --- | --- | --- |
| Static discovery | 37 installed package roots; 1,010 TypeGPU-related source files in the recorded inventory | Found and fixed a JavaScript discovery crash; no disappeared inspectable symbols versus the pre-factory snapshot |
| Browser sweep | 499 modules across the selected projects | 2,559 reports: 1,282 passing shader/pipeline checks, 97 passing resource checks, 1,157 blocked, 14 unsupported, 9 failed |
| Native project isolation | 13 additional modules | All processes finished; 3 passing shader checks, 25 blocked reports, 1 unsupported report |
| Released-source comparison | 499 modules; source baseline `7c939f5` | 1,165 previously passing targets still pass automatically; 1,128 retain identical WGSL; 37 changed outputs reviewed; no missing target families |
| Explicit caller recovery | Two gravity render-stage checks | Both recover byte-for-byte identical WGSL when setup explicitly imports their caller |
| Factory-change comparison | 44 modules whose target plans changed | All 189 previously passing targets retain identical WGSL |
| Fresh factory runs | Same 44 modules, with frozen copies for changing inputs | All 306 passing results reproduce identical WGSL |
| Stall-fix rerun | 512 modules in one process, plus three repeated 13-module native batches | All finish; 2,588 reports; all 1,382 prior passes retain identical WGSL; four additional Confetti passes |
| Failure recovery regression | Failed dependency build followed by a CommonJS-dependent shader, three cycles | Pre-fix code times out at 30 seconds; fixed code passes in about four seconds |
| Repository verification | Runtime, server, VS Code | 514 unit tests, 77 browser tests, type checks, builds, and whitespace checks pass |

Runtime cases cover **512 modules in 31 package roots across 26 project
checkouts**. Projects include Roads, WeatherVis, BirthdayCard, CanvasOvergrowth,
MetalThingy, TypeGPUTD, TypeGPUSim, TypeGPUFire, TypeGPUAdventure, TypeGPUStage,
TypeGPURL, depth-camera and genetic-algorithm packages, Confetti, Ocean,
GrokShowcase, and current and older TypeGPU examples. Installed TypeGPU versions
span 0.8.2 and 0.11.8–0.12.4; this is not a claim of support for every version
or every project configuration.

Duplicate worktrees, dependencies, build output, tests, and generated
`.tsnotover.*` copies were excluded from the final runtime cases. Some package
roots have no discoverable shader targets. No dependencies were installed into
external projects, and this work did not edit their source files.

## Findings

### Fixed: JavaScript discovery could crash

`sourceBindings()` created an isolated TypeScript program without `allowJs`.
JavaScript files could consequently be absent from the program while their AST
was passed to `getSymbolsInScope`, causing an internal TypeScript exception.
The broad scan reproduced it in VoCoach's `eslint.config.js`.

The fix enables JavaScript in that isolated program, retaining `noLib` and
`noResolve`. Four regression cases cover `.js`, `.jsx`, `.mjs`, and `.cjs`,
including named shader shells and a configuration module with no shader targets.

### Intentional behavior change: caller setup is explicit

The released inspector made `gravity/render.ts` pass by executing a neighboring
module and borrowing its bindings. The current version reports two missing
binding contexts when that file is inspected alone. This is a reduction in
*automatic* coverage, not a disappearing shader capability.

With `setupBody: "await import('./index.ts');"`, each stage pair receives a
complete observed binding set and produces precisely the old WGSL. There are
also blocked alternatives where the other pipeline's complete binding set is
insufficient; those sets are not combined to manufacture a passing context.

The comparison keeps these two automatic passing-to-blocked transitions visible.
They are not silently waived or counted as unchanged defaults.

### Reviewed WGSL differences

The 37 changed successful outputs are in Roads and TypeGPU examples. They reflect:

- Nonzero/identity-matrix synthesized accessor values replacing the old static
  zero bindings, with assumption-qualified outcomes.
- Standalone inspection using explicit synthesis instead of a neighboring
  module's implicitly initialized uniforms.
- Removal of unnecessary zero-argument wrappers.
- Different standalone numeric defaults and separate complete usage contexts
  in the fluid example.

These are different inspection contexts or probes, not byte-for-byte preservation
of the old default behavior. The same-context factory comparison and the explicit
caller checks above provide the stronger equality evidence. Raw WGSL diffs are
retained for review; a passing compiler check alone does not prove semantic
identity.

### Existing failures and unsupported inputs remain visible

Nine ordinary sweep reports fail: six MetalThingy helpers depend on an
uninitialized `config`, one Confetti helper encounters an unresolved atomic
value, and two synthesized TypeGPUSim render pipelines exceed the available
vertex-buffer limit. None is a new passing-to-failing transition against the
released source baseline.

Blocked and unsupported cases include absent nested factory instances, missing
argument/binding contexts, browser-incompatible framework imports, old package
APIs, and device capability limits. They are not included in passing counts.

### Fixed: native batch stalls

The initial current and released batches stopped making progress around native
component dependency failures. A traced reproduction located the deadlock in
Vite shutdown: the client optimizer's `close()` finished, but its plugin container
and two dependency requests (`tsover-runtime` and `typed-binary`) stayed pending.
Vite's speculative initial optimization rejected before settling the processing
promises those requests awaited. The inspector had already caught the build
failure and closed the browser page; awaiting server cleanup prevented returning
the report. This was reproduced with the locally installed Vite 8.1.5.

The inspector now leaves dependency discovery to Vite's on-demand request path,
which catches optimizer failures and releases pending dependency requests. Its
own speculative entry scan and manually collected optimizer imports were removed,
along with the redundant import parser and its three unit tests. No cleanup
race, private Vite patch, or background abandoned server was added. CommonJS
imports and erased type-only imports are covered by the browser regression.

`inspector/test/optimizer-browser.test.ts` builds a malformed dependency, checks
its `DependencyOptimizationError`, then compiles a shader using a valid CommonJS
package. It repeats three times and closes sessions. Running that same test
against a local copy of the immediately pre-fix runtime times out after 30
seconds; the fixed runtime completes in about four seconds.

Three consecutive 13-module native batches completed. The full 512-module rerun
also completed in one process, including all native cases and a successful shader
inspection after earlier native failures. Its 2,588 reports contain 1,386 passes,
1,178 blocked results, 15 unsupported results, and nine existing failures. All
1,382 previously passing results have identical WGSL; four Confetti checks move
from blocked to passing. Blocked and unsupported cases remain visible.

Two Roads files changed after the previous manifest was recorded. The sweep
correctly rejected those inputs; fresh frozen copies were then tested against
both the immediately pre-fix runtime and the fixed runtime. All 13 results have
matching blocked outcomes and diagnostic messages. The final comparison uses
these paired runs, and retains the original source-change errors separately.
The native baseline comes from the earlier isolated reports, since its batch
could not finish. This evidence closes the reproduced stall gate for the tested
corpus; it does not claim that every possible project configuration is supported.

## Method and evidence

The baseline is a local copy of released **source**, with the same installed
inspector dependencies as the candidate. It is not an independently reinstalled
published package. A separate source snapshot from immediately before the
factory refactor supplies its earlier discovery plans, evaluated through the
current runtime. That isolates factory discovery changes; it is not a complete
older-runtime snapshot.

Comparison maps the old target to its current call-site, usage, or exact member
path. A previously passing target must retain a passing counterpart; new blocked
alternatives remain in the raw reports. WGSL hashes are compared without
normalizing constants, bindings, or identifiers.

Source hashes guard the manifests. Roads and mesh-primitives files changed during
this work. Roads cases were refreshed and compared again. Three mesh-primitives
cases were run from a local frozen source copy, with the original installed
dependencies, so both implementations saw identical inputs. The initial
source-change failures remain recorded; final comparisons use the frozen cases.

The broad sweep reuses Chromium but closes each module's inspector sessions.
Factory repetitions use separate output directories and fresh runs. Native
isolation adds a process watchdog; a timeout cannot count as a passing process.
The stall-fix sweep uses a 30-second per-module harness watchdog; none fires.
The final comparison combines the sweep with the two paired frozen Roads runs.

Reproduction tools:

- [`scripts/stress-projects.mts`](scripts/stress-projects.mts): discovery plans,
  source guards, runtime reports, baseline selection, and resumable runs.
- [`scripts/compare-stress.mts`](scripts/compare-stress.mts): missing-target,
  outcome, and exact-WGSL comparisons. Nonpassing transitions keep a nonzero exit
  status; successful-but-changed output still requires review.

Machine-local manifests, baseline copies, raw reports, frozen sources, and diffs
are under the ignored [`.local/stress`](.local/stress) directory. Key artifacts:

- [Stall-fix comparison](.local/stress/comparison-final-stall-before-final-stall-after.json)
- [Stall-fix final reports summary](.local/stress/final-stall-after-summary.json)
- [Stall-fix outcome changes](.local/stress/stall-outcome-changes.json)
- [Failure/recovery test before the fix](.local/stress/logs/stall-regression-before.log)
- [Failure/recovery test after the fix](.local/stress/logs/stall-regression.log)
- [Original sweep counts](.local/stress/final-counts.json)
- [Released-source comparison](.local/stress/comparison-final-released-final-current.json)
- [Factory comparison](.local/stress/comparison-final-previous-final-factory-repeat.json)
- [Fresh-run comparison](.local/stress/comparison-final-factory-repeat-final-current.json)
- [WGSL differences](.local/stress/wgsl-differences.json)
- [Explicit caller report](.local/stress/contexts/gravity-explicit-caller/report.json)
- [Isolated native process results](.local/stress/native-runs.json)

Everything remains local and uncommitted. TypeGPU/Argent MCP tools, publishing,
installation into editors, and remote writes were not used.
