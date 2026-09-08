# Helper discovery and planning

Discovery identifies shader declarations, source ranges, selectors, and existing
factory outputs. `helperPlanning.ts` turns those declarations into argument
plans. The existing runtime combines those probes with captured instances,
complete binding contexts, or explicit fixtures before generating WGSL.

The planner uses one argument representation: `probeArgumentPlan`, with `schema`,
`refSchema`, or `value` entries. The public inspector API still accepts the older
`probeArguments` shorthand, normalized at the probe boundary. Generated plans
carry `probeContext`; reports preserve it as `context.probe`.

## Coverage matrix

| Pattern | Before | Current planning | Evidence |
| --- | --- | --- | --- |
| Typed GPU functions, inline and named shells | Several discovery branches supplied schema arrays | One planner supplies schema argument entries | Existing discovery tests and helper planning matrix |
| Private and nested helpers | Nested schemas had a separate fallback; shell lookup used module names | The same planner consumes captured declarations; lexical binding lookup finds nested shells and local schemas | Matrix plus browser compilation of `make.helper` with a captured `Local` schema |
| Finite generic types | Correlated variants, bounded at eight | Retained; each variant uses the common argument plan and schema provenance | Existing generic tests plus browser compilation of vec2f and vec4f variants |
| Integer arguments and references | Specialized numeric rules and reference probes | Retained; named as schema probes rather than application inputs | Existing texture-array, bitcast, and reference tests |
| Sampler/texture arguments at call sites | The first available value for each position could come from a different call | Each complete resource tuple becomes its own probe; source line and column distinguish calls | Matrix plus two independently compiled sampler tuples |
| Incomplete calls | Separate calls could accidentally complete one another | Remain blocked; report names each missing argument and the needed context | Incomplete-tuple test and browser missing-array/explicit-fixture pair |
| Shadowed names | Text matching could select module bindings or another helper's signature | Lexical binding identity, without loading dependencies | Shadowed resource, helper, shell, and nested parameter tests |
| Accessor values | Static helper/accessor graph supplied zero bindings alongside the runtime provider | Runtime identity-based binding contexts and schema synthesis own this decision | Browser accessor probe and existing binding-context suite |
| Existing factory results | Static analysis describes already-created results | Retained; helper planning never invokes a factory | Existing factory tests and TypeGPUFire audit |

Synthetic schema probes and static call-site probes remain assumption-qualified.
A call-site location identifies the source of the resource tuple; it does not
prove that the application executed that call. Explicit fixtures override the
inferred argument plan and clear its missing-input metadata.

## Actual size change

These counts compare against the local version at the start of this step, and
include the extracted code rather than counting only the smaller discovery file.

| Production area | Before | After |
| --- | ---: | ---: |
| `discovery.ts` | 2,984 | 2,022 |
| `helperPlanning.ts` | Embedded | 667 |
| Shared `shaderSyntax.ts` | Embedded | 135 |
| Combined discovery and planning | **2,984** | **2,824** |

That is **160 fewer lines** across these three files. Small additions elsewhere
carry probe provenance and missing-input diagnostics; the reduction above is
not a claim about the entire working tree. The main cleanup is ownership and
removing overlapping inference paths, rather than moving all complexity out
of sight. Factory-output analysis and numeric/generic rules remain substantial.

## Validation

- 507 unit tests and 75 browser tests pass, alongside type checks and builds.
- The four-project audit retains identical WGSL and outcomes for all 23 results:
  20 compiled and three intentionally blocked. Raw results are local under
  `.local/audit-helper-planning`.
- The new browser fixture exercises private resource tuples, accessor synthesis,
  generic variants, a captured local schema, and a missing array argument that
  compiles once an explicit fixture supplies its schema.

The matrix is executable in `server/test/helperPlanning.test.ts`; the runtime
cases are in `inspector/test/symbol-access-browser.test.ts` and
`inspector/test/fixtures/helper-planning.ts`. No editor installation, live MCP
calls, publication, or external project source changes were made.
