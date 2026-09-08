# Editor remaster: specialization workflow

The first slice makes a particular shader specialization an explicit editor
selection. Shader inspection remains shared with the CLI. Mutable accessor probes now
synthesize lazy storage bindings from finite schemas; the ledger marks these
inputs as assumptions. Complete application contexts and explicit bindings
retain precedence. Runtime-sized storage still requires an explicit binding.

## Implemented

- VS Code's **Select Specialization** command lists shader targets with their
  outcome and context. The generated WGSL view also exposes this action.
  A declaration with multiple targets requires a choice; cursor following
  remembers that choice for the declaration within the current editor session.
- Pins and cursor-following selections survive declaration offset changes.
  Removing a selected specialization requires another choice. It never falls
  back silently to a surviving instance.
- Generated WGSL stays visible during refresh, with its source version and
  previous-save status. Late responses cannot replace a newer selection or
  refresh. Completion notifications follow the committed inspection state.
- Zed retains generated-file compiler diagnostics and the direct jump from a
  compiler diagnostic to its WGSL location. Specialization browsing and
  hover/inlay detail selectors are absent from its code-action menu; detail
  levels remain configurable through settings. A persistent Zed browsing
  interface now shows generated function bodies directly in the hover, with
  separate specialization blocks, one shared status, and direct WGSL links.
  The Markdown module index and its background write lifecycle were removed.
  Generated files use context identity in their path and atomic replacement;
  source-version guards prevent superseded results from overwriting them.
  Unchanged shader text does not touch the file's modification time.
- A shared compiler-input pass removes unused supported extension directives
  from TypeGPU's generated header. Reports, recorded calls and statement maps
  use the same final source. Unknown/unavailable directives remain for compiler
  diagnostics; extension uses are checked outside nested WGSL comments.
- Editor responses preserve outcomes, context and diagnostic details as data.
  Missing context, unsupported inspection and environmental failures retain
  their distinctions. Resource targets remain available through existing
  reports and hovers, outside the shader picker.

## Internal boundaries

`server/src/editorProtocol.ts` is the dependency-free editor wire contract and
its display helpers. `editorSelection.ts` holds pure selection logic;
`editorRequests.ts` maps runtime results into this contract and generated-file diagnostics.
Both editor adapters use these definitions instead of interpreting report text.

Runtime declaration offsets remain execution selectors. The editor selection
key uses the target label and context identity (instance, usage, result path,
and explicit context label). Matching requires a unique key. Previous observed
instances are retained only in the presentation snapshot while the source is
dirty; their old declaration offsets are never reused to execute the new source.

Instance and usage numbers still mean observed execution order. Reordering
factory calls can change which value an ordinal represents. This slice does
not claim semantic identity for arbitrary captured JavaScript values; context
labels and visible instance numbers describe what was selected.

## Validation

- Unit tests cover offset changes, reordered target lists, removed instances,
  ambiguous keys, changed contexts, stale WGSL and generated diagnostics.
- `node scripts/release-smoke.mjs <server> <project> <output>` runs real runtime
  CLI/LSP acceptance. It verifies an empty action menu on clean declarations,
  compiler-error navigation, a selected second closure,
  an offset-changing edit under hover-triggered inspection, WGSL compiler
  errors and recovery, explicit fixtures and dependency-failure recovery.
- `pnpm test:editor` launches an installed VS Code in an isolated profile and
  workspace. It tests the production preview adapter with deterministic server
  responses: native QuickPick selection, pin refresh, late responses, stale
  code, compiler diagnostics, recovery and target removal. This complements
  the real-runtime LSP suite; it is not a full extension-installation test.
- The extension-host runner retains evidence under `.local/editor-remaster`.
  Set `VSCODE_EXECUTABLE` to use a different installed VS Code executable.

Zed's native file reload was checked with two WGSL tabs: atomic replacement
updated the visible code while preserving the cursor at 70:4 and the scroll
position. Before/after screenshots are under `.local/editor-remaster/zed-native`.
The two-specialization hover was visually checked in native Zed: separate
syntax-highlighted function bodies, one shared status and direct WGSL links.
Evidence: `.local/editor-remaster/zed-native/hover-review.png`. Native link-click
verification was stopped at the user's request; desktop interaction requires
asking the user for screenshots instead. Direct link destinations, diagnostic
navigation and recovery pass real LSP acceptance. No TypeGPU or Argent MCP tools are used by these checks.

The cloth example's `forces`, `integrate` and `normals` all pass browser WGSL
compilation using synthetic accessor inputs. Regression checks cover multiple
mutable bindings, explicit binding precedence, disabling synthesis, unbounded
schemas, and invalid WGSL. Evidence: `.local/editor-remaster/cloth-probe.json`.

## Concrete inspection context

Zed hovers and VS Code shader previews use one bounded context summary from
structured runtime metadata. Schema probes show their zero constructors;
synthetic storage bindings are counted separately from accessor value
placeholders. Missing inputs identify the argument or slot and an action.
The full ledger remains available in the report.

Nested instances expose up to eight primitive enclosing parameter values,
without traversing objects or evaluating factories. These are values visible
in the captured scope at inspection time; they are not a complete dependency
list or a durable specialization identity. Displayed summaries are bounded to
160 characters. Observed and candidate binding contexts remain distinct.

Headless validation: 297 server tests, 252 runtime unit tests, 79 browser tests,
three cloth shaders, and real CLI/LSP acceptance. The latter checks captured
radius values in both the target response and hover, then source edits,
compiler errors and recovery. No desktop interaction was used for this slice.
Evidence: `.local/editor-remaster/context-*.log`.

## Factory-returned helper arguments

Known, directly returned GPU callables now feed the existing helper planner.
The source-only type checker identifies the callable declaration; a single
unconditional return check prevents unresolved branch types from choosing the
wrong signature. Only module-accessible schemas are inferred. A root member
selection keeps the inferred plan attached to that callable, with explicit
argument overrides still available.

WeatherVis's cubic and bilinear helpers now compile standalone with inferred
vec2f/f32 arguments. Eleven selected function bodies match low/high pipeline
contexts after generated-name normalization. Two repeated passes over 29
selected targets show only these two blocked-to-passing changes; all previously
generated WGSL hashes remain identical. Evidence: `.local/factory-return-check`.

## Caller-derived numeric probes

Plain numeric parameters now use complete type tuples from known shader calls.
`callerSchemas.ts` follows typed TypeGPU constructors, entrypoint input schemas
and shader-local const aliases using lexical binding identity. CPU values,
shadowed namespaces, mutable locals, arbitrary arithmetic and ambiguous input
objects provide no type evidence. Unknown calls retain the independent schema
probe; multiple known types reuse the existing bounded specialization mechanism.

Cloth's `isPinned` now probes u32 and matches its compute pipeline function
exactly. Two passes over 29 selected app targets show no other WGSL or outcome
changes. WeatherVis's eleven function comparisons still match. A browser
regression verifies that an integer schema probe can pass while the real f32
caller fails WGSL validation, and that caller-derived inspection catches it.
Validation: 316 server tests, 81 browser tests, typechecks and local builds.
Evidence: `.local/caller-type-check`.

## Following slices

1. A native VS Code target tree and compact context controls around the WGSL
   document; simplify the default hover hierarchy in both editors.
2. Actions to create or open explicit fixtures from missing-input diagnostics.
3. Explicit WGSL snapshots and diffs between saves or specializations.

These build on the same contract; they do not require another runtime rewrite.
