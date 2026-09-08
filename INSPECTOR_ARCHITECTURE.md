# Shader inspection: local implementation

The primary result is generated WGSL and compiler diagnostics for a selected
shader under an identifiable context. Private access must preserve the actual
TypeGPU objects, including slots, accessors, and captured values.

The previous private-symbol path copied source into a generated probe while
dependencies could import the original module. That created separate object
identities and required a second mechanism to associate corresponding objects.
This change instruments the original module and gives the probe references to
its bindings. It removes the copying and identity-pair machinery.

| Area | Current, before this change | Proposed, now implemented locally | LOC estimate | Cleanliness | Reliability |
| --- | --- | --- | --- | --- | --- |
| Private symbols | Copy module source into the probe; associate copied and original objects | Instrument original module; read live private bindings | 178 lines for transform and registry, replacing old access machinery | One source of runtime identity | Module evaluated once; aliases and slots retain identity |
| Nested CPU-created helpers | Mostly infer accessible factory outputs; unreturned locals inaccessible | Capture each executed named declaration, retaining its shader object and lexical scope | About 100 lines of discovery and instance expansion | Declaration offset identifies source; instance index identifies execution | Distinct captures compile independently; missing instances are blocked |
| Helper specialization | Probe generation and binding inference mixed with symbol access | Separate probe builder; explicit argument and slot contexts | 147 extracted lines plus 62 for fixture loading and validation | Probe construction has a separate responsibility | Explicit values compile as chosen; schema defaults remain assumption-qualified |
| Target preparation | Generate error handlers, pipeline builders, and nested loops; rewrite generated strings | Serialize target plans and prepare them in ordinary TypeScript; generate only GPU call wrappers | 94 runtime lines replace roughly 200 lines of generation | One execution path for selectors, contexts, errors, and pipelines | Each failed instance retains context without losing successful siblings |
| Binding discovery | Scan and execute nearby callers containing `.with(...)` | Use explicit setup for execution; offer static importer suggestions | Roughly 80 lines removed | Static discovery is separate from execution; no copied-object aliases | The selected module cannot silently acquire bindings by executing a neighbor |
| Human and agent output | One requested target normally maps to one report | Expand a declaration into reports for each captured instance; expose context in JSON and hover | About 100 lines of transport, CLI, and refresh changes | CLI and editor consume the same result metadata | Coverage and refresh handle changing instance counts |
| WGSL validation | Browser compiler, generated artifacts, source maps | Reuse these components with source-map-preserving instrumentation | Small integration changes | No second WGSL compiler or code generator | Invalid nested WGSL reaches compiler diagnostics |
| Resources and environment | Existing resource reports and environment inference | Retained at existing scope | No feature expansion | Keeps this migration focused | Existing regression coverage retained |

The estimates describe implementation areas and are not additive. The measured
production TypeScript diff is **810 lines added, 745 removed, net +65**; this
excludes tests, documentation, dependencies, and generated builds. The original
`symbols.ts` shrank from 1,046 to 469 lines, with probe construction extracted.
The second cleanup removed **200 net production lines** compared with the first
local implementation. These counts include the new nested inspection and
context features, rather than only measuring files made smaller by extraction.

Discovery selects source declarations. Instrumentation receives those offsets
and captures only the requested bindings; it no longer maintains a second list
of constructor patterns for recognizing shaders. Runtime preparation owns
selector lookup, closure expansion, context metadata, bindings, pipeline
descriptors, and error isolation. Generated callbacks contain only the helper
probe that the TypeGPU transform must process.

## Context contract

- A source declaration identifies what to inspect. Executed instances identify
  which closures actually exist. Instance numbers follow capture order within
  one run and are accompanied by a source revision.
- Explicit setup creates contexts when module initialization has not done so.
  The CLI accepts a reusable `--context-file`; `--instance` selects one capture.
- A fixture can provide helper argument values, zero-value schemas, mutable
  reference schemas, and slot/value pairs. Explicit contexts disable automatic
  binding inference for that target.
- A successful check validates the generated shader for that context. Schema
  defaults remain `passed-with-assumptions`; they cannot certify application
  inputs or every possible specialization.

The [README](README.md#private-helpers-and-specialization-contexts) contains the
fixture format and an example command.

## Boundaries retained deliberately

Selected modules still execute their initialization. This implementation does
not slice arbitrary JavaScript dependencies or invent calls to CPU factories.
Nested capture covers named shader variables and GPU function declarations in
CPU function blocks. Destructured and anonymous results need an accessible
target or an explicit probe. GPU bodies remain untouched; their nested shader
functions are inspected through the enclosing shader.

Complete observed binding sets replace individual slot borrowing. Each branch or
bound function gets its own usage index and resolution attempt. A known bound
helper or direct pipeline stage is distinguished from a candidate sharing a
required slot. Candidates remain assumption-qualified; incomplete sets stay
blocked. The schema provider only serves standalone probes. `--usage` selects
one set, independently of a closure's `--instance`.

The editor's `contextFile` setting shares the CLI fixture parser. For blocked
helpers, static source scanning suggests importers through aliases and barrel
exports without executing them. Suggestions are module-level leads; they do not
prove a helper call, identify every nested specialization, or generate setup.
Search limits are explicit (1,000 source files, 1 MB per file, 20 results).
Captures are bounded at 128 instances per declaration, with overflow reported
as blocked instead of silently certifying a truncated set.

## Local validation

Unit tests cover binding identity, reassignment, lexical scopes, discovery,
instance expansion and refresh, fixture validation, CLI transport, and report
serialization. Browser tests cover separate captured constants, module
evaluation count, explicit setup and bindings, compiler failures, argument
provenance, and existing shader/pipeline scenarios. Type checks and builds cover
the runtime, language server, and VS Code extension. Live MCP tools and editor
installation were not used.

The [real-project audit](SHADER_AUDIT.md) covers four projects, including a
nested-scope lookup bug found in TypeGPUFire and fixed in the runtime scope
adapter. All 16 previously compiled results retained identical WGSL after the
cleanup. The context-stage audit retains identical WGSL and outcomes for all 23 results
(20 compiled, 3 deliberately blocked). Dedicated browser regressions cover
complete correlated bindings, missing values, candidate provenance, and usage
selection.

## Helper planning follow-up

[Helper planning and its coverage matrix](HELPER_PLANNING.md) records the next
cleanup: source discovery hands declarations to one argument planner, which
uses lexical bindings and emits complete call-site resource tuples. Runtime
binding contexts replace the old static accessor graph. Missing-input metadata
and schema/call-site provenance are carried into the shader report.
Discovery plus the extracted planner and shared syntax code shrank from 2,984
to 2,824 lines at that stage; numeric/generic planning was retained. The
factory-output analysis is replaced in the follow-up below.

## Actual factory results

Static return-shape interpretation is removed. `factoryResults.ts` locates
existing local factory call results and aliases using lexical bindings.
`resultTargets.ts` enumerates their runtime values; version-sensitive TypeGPU
markers remain in `typegpuIntrospection.ts`. Member selection, closure instances,
and complete binding usages share the ordinary target preparation/report path.

Discovery shrank again from **2,022 to 1,418 lines**. The new root locator is 77
lines and runtime traversal is 63 lines, with about 34 lines of marker handling
and small transport/fixture integrations. This is a net reduction, rather than
moving the removed 600-line factory analysis elsewhere.

Returned records/arrays, conditional branches, aliases, and computed property
names use actual values. Each result carries an exact member path. Named nested
helpers retain source-planned probes; returned parameterized bare helpers can be
selected with explicit arguments. Factories are never invoked by traversal.
Getters and limits remain visible as blocked results; ordinary CPU callbacks are
ignored, and aliases preserve identity.

The editor attaches concrete factory pipeline results to stage symbols using
recorded runtime descriptor identities. Static discovery keeps independent stage
probes until the concrete result is inspected; it no longer assumes a function's
return branch supplies a particular pipeline descriptor.
