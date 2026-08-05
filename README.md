# TypeGPU Inspector

This is an editor inspector for TypeGPU. It runs the saved module in a local
Chromium WebGPU environment, asks TypeGPU for the real WGSL and runtime
descriptors, then puts the useful parts back into the TypeScript editor.

It is not another static linter. It executes top level module code, so use it
on projects you trust.

## Configure it

The defaults are meant to be usable without configuration. Inspection runs on
save, hovers use the standard preset, and inlays only show status.

This is a good starting point for Zed:

```jsonc
{
  "lsp": {
    "typegpu-inspector": {
      "initialization_options": {
        "inspectOn": "save",
        "hoverDetailLevel": "standard",
        "inlayDetailLevel": "compact",
        "schemaPackingSuggestions": true
      }
    }
  }
}
```

The same setup in VS Code is:

```jsonc
{
  "typegpuInspector.inspectOn": "save",
  "typegpuInspector.hoverDetailLevel": "standard",
  "typegpuInspector.inlayDetailLevel": "compact",
  "typegpuInspector.schemaPackingSuggestions": true
}
```

Zed settings live under `lsp.typegpu-inspector.initialization_options`. VS Code
uses the same names with the `typegpuInspector.` prefix. VS Code also exposes
them in its normal settings UI.

### Hover detail

`compact` shows the complete core shape and little secondary evidence.

`standard` is the default. It adds the facts that matter for the kind of thing
being inspected and a small WGSL excerpt.

`deep` adds diagnostics, assumptions, runtime metadata, declarations, and more
raw evidence.

Schemas, bindings, render targets, vertex attributes, and short resource
descriptors are not shortened just because the hover preset is lower. The
presets mostly control material that can grow without a natural bound.

### Inlay detail

`compact` shows status only.

`summary` adds one useful fact.

`detailed` adds up to two useful facts.

Hover and inlay presets are independent. A deep hover with compact inlays is a
perfectly normal setup.

The old `detailLevel` setting is still accepted. `minimal`, `default`, and
`verbose` map to the new presets, but new configurations should use the two
separate settings.

### When inspection runs

`inspectOn` accepts `save`, `hover`, `save-and-hover`, or `off`.

`save` is the default and usually feels best. `hover` delays work until it is
needed. `save-and-hover` does both. `off` keeps the editor surfaces available
but stops automatic runtime inspection.

`warmUpOnOpen` defaults to `true`. It prepares Chromium and the module session
when a TypeGPU file opens, which makes the first real inspection less annoying.

### Schema layout

`schemaLayoutHealth` controls size, data, padding, and padding map notes. It
defaults to `true`.

`schemaPackingSuggestions` controls the search for a smaller valid field
order. It also defaults to `true`. A suggestion is only shown when a concrete
ordering is proven to use fewer bytes. If it is `false`, the search is skipped
but the normal layout information stays visible.

Host shareability is reported for buffer data schemas. Schema fields are kept
complete through the limits WGSL requires implementations to support: 1,023
members in a structure and composite nesting depth 15. If an out of spec
schema has to be cut off, the hover says so.

### Surface switches

These all default to `true`:

```jsonc
{
  "hover": true,
  "inlayHints": true,
  "diagnostics": true,
  "documentLinks": true,
  "sourceMapping": true,
  "schemaLayoutHealth": true,
  "schemaPackingSuggestions": true
}
```

`sourceMapping` is still heuristic. It tries to attach a WGSL compiler problem
to the relevant TypeScript token. The diagnostic always keeps a link to the
generated WGSL location as the reliable fallback.

### Hover control

The normal presets should be enough for most people. If they are not,
`hoverPresentation` can hide, force, or reorder sections and set budgets for
the parts that can become long.

```jsonc
{
  "hoverPresentation": {
    "sections": {
      "runtime": "hide",
      "bindings": "show"
    },
    "sectionOrder": [
      "resource",
      "schema",
      "bindings",
      "wgslPreview"
    ],
    "wgslPreviewLines": 6,
    "collectionItems": 12,
    "declarations": 24,
    "compilerMessages": 10,
    "inspectionNotes": 6,
    "assumptions": 8
  }
}
```

The section names are `wgslPreview`, `shaderFacts`, `bindings`, `resource`,
`schema`, `pipelineState`, `pipelineContext`, `declarations`,
`compilerMessages`, `inspectionNotes`, `assumptions`, and `runtime`.

A section value can be `auto`, `show`, or `hide`. You only need to put the
sections you care about in `sectionOrder`. Everything else keeps its normal
role specific position.

### Runtime limits and unusual projects

The remaining runtime settings and their defaults are:

```jsonc
{
  "timeoutMs": 45000,
  "maxWgslBytes": 2000000,
  "strictNames": true,
  "features": [],
  "projectRoot": "",
  "inspectorPackage": "bundled"
}
```

`timeoutMs` is clamped between 1,000 and 600,000. Cold session setup has its
own allowance and does not consume this timeout.

`maxWgslBytes` is clamped between 16,384 and 64,000,000.

`projectRoot` overrides workspace detection when the repository layout is
unusual. Leave it empty unless resolution tells you otherwise.

`inspectorPackage` should stay `bundled`. It can point at a plain npm package
name, optionally with a version, when comparing inspector builds.

Invalid settings are ignored and written to the language server log. Setting
changes apply without restarting the server.

## Install it for development

Node.js 20 or newer and pnpm are required. Clone the repository, then run:

```sh
pnpm setup
pnpm build
```

The inspector uses Playwright Chromium. The package install normally handles
that. This command checks Node, Chromium, and WebGPU when something looks off:

```sh
node inspector/bin/typegpu-runtime-inspector-mcp.mjs doctor
```

### Zed

Open the command palette, run `zed: install dev extension`, and select the
repository root.

The dev extension looks for `server/dist/server.cjs` in this checkout. During
language server work I still prefer setting the path explicitly, so there is
no doubt about which build Zed launched:

```jsonc
{
  "lsp": {
    "typegpu-inspector": {
      "binary": {
        "path": "node",
        "arguments": [
          "/absolute/path/to/ZedPlugin/server/dist/server.cjs",
          "--stdio"
        ]
      }
    }
  }
}
```

Run `pnpm build` after changing the server, then restart its language server or
reload Zed.

### VS Code

Build a local VSIX:

```sh
pnpm --dir editors/vscode package
```

The command prints the generated file path. Install that file with:

```sh
code --install-extension editors/vscode/typegpu-inspector-*.vsix --force
```

Reload VS Code after replacing the VSIX. The package contains the current
language server build, so rebuilding the server alone does not update the
already installed VS Code extension.

## Use it

Open a TypeScript or JavaScript file that uses TypeGPU and save it. The first
run can be slow because Chromium, Vite, and dependency optimization need to
start. Later inspections reuse the warm session.

Hover a top level TypeGPU declaration. The inspector understands shader
functions, compute and render pipelines, schemas, buffers, textures, texture
views, samplers, query sets, bind group layouts, bind groups, vertex layouts,
slots, accessors, GPU variables, and nested collections of those resources.

What appears depends on the value. A schema gets field offsets, alignment,
padding, and host shareability. A texture gets its dimensions, format, usage,
mip count, and sample count. A pipeline gets generated WGSL, entry points,
bindings, layouts, render state, and WebGPU validation. A helper gets the
specializations the inspector could safely synthesize.

Compiler and runtime failures are published as editor diagnostics. Generated
WGSL and the complete inspection report are linked from the hover. The source
buffer only gets small inlay hints, and their density is configured separately
from hover detail.

The inspector can derive useful targets from declarations that are not
exported. It can also follow common top level factories and resource
collections without calling a factory a second time. If a factory needs
arguments that cannot be inferred safely, it is identified but not invoked.

During inspection the module runs on a fresh browser page. The Vite server,
Chromium process, and browser context are reused for speed, but JavaScript
globals and TypeGPU resources do not carry over between inspections. The
inspector creates and validates resources and pipelines. It does not submit
arbitrary application draw or dispatch work.

## A few concrete examples

These were generated by the current standard hover formatter. Local temporary
file URLs are omitted, but the content and ordering are unchanged.

For a compute entry point:

```text
TypeGPU · compute entrypoint updateParticles
✓ WGSL validated

Open generated WGSL · 6 lines · 284 B · Open full inspection report

Generated WGSL
struct Params { delta: f32, };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<vec4f>;
@compute @workgroup_size(64) fn updateParticles(@builtin(global_invocation_id) id: vec3u) {
  particles[id.x].x += params.delta;
}

Shader facts
Entrypoints: compute updateParticles
Workgroup updateParticles: 64 × 1 × 1 = 64 invocations

Bindings
Binding  Name       Visibility  WGSL                         WebGPU
@0:0     params     compute     uniform · Params             buffer · uniform
@0:1     particles  compute     storage, read_write · array<vec4f>  buffer · storage
```

For a schema:

```text
TypeGPU · schema Particle
✓ Resource inspected

Open full inspection report

Schema
struct · 48 B size · 16-byte alignment
Host-shareable: Yes

Memory layout: 48 B allocated · 24 B data · 24 B padding (50%)
Padding map: 12 B before position · 12 B tail
Possible tighter order: position → age → mass · 48 B → 32 B · save 16 B

Field     Offset  Type   Layout
age       0       f32    4 B · align 4 B
position  16      vec4f  16 B · align 16 B
mass      32      f32    4 B · align 4 B
```

For a texture:

```text
TypeGPU · texture resource image
✓ Resource inspected

Open full inspection report

Resource
texture · usage: sampled + render

Properties
size: [1024, 1024]
format: rgba8unorm
dimension: 2d
mipLevelCount: 1
sampleCount: 1
```

For a compiler failure:

```text
TypeGPU · compute entrypoint broken
✗ Inspection failed

unknown identifier 'lightDirection'
wgsl-compilation

Open generated WGSL · 3 lines · 73 B · Open full inspection report

Generated WGSL
@compute @workgroup_size(1) fn broken() {
  let light = lightDirection;
}

Shader facts
Entrypoints: compute broken
Workgroup broken: 1 × 1 × 1 = 1 invocation

WGSL compiler messages
error line 2:15: unknown identifier 'lightDirection'
```

## Honest limitations

There are a few places where silence means "I do not know", not "everything
is perfect".

The browser is real, but the application around it is a generated harness. It
handles common DOM lookups, assets, TypeGPU setup, and resource creation. It
will not reproduce a complicated application shell, login flow, remote API,
or every bit of startup code. Modules with unusual top level side effects can
still fail before the interesting value is reached.

The inspector creates and validates shaders, resources, layouts, and
pipelines. It does not run arbitrary draw or dispatch work and it does not
claim that a rendered frame looks correct. The default software WebGPU adapter
is useful for semantics, not GPU performance or vendor specific driver
behavior.

Some shader helpers need concrete arguments before TypeGPU can resolve them.
The inspector synthesizes values when the type gives it a safe answer and says
when it did so. If an argument or factory input cannot be inferred safely, it
does not guess. Synthesized render targets and vertex inputs are inspection
defaults, not proof that they match the application.

WGSL to TypeScript diagnostic mapping is heuristic. The generated WGSL
location is kept as the reliable source when generated code has moved too far
from the original token.

Packing suggestions are exact for structures with up to 14 top level fields.
Larger structures try one sensible order based on alignment and size. A shown
suggestion is a real smaller layout, but no suggestion on a large structure
does not prove that the current order is optimal. Custom layouts are left
alone when the inspector cannot reproduce their offsets safely.

## Agent access

The same runtime is available as an MCP server. The Zed extension registers it
as `typegpu-inspector` automatically. Other clients can use the published
`typegpu-runtime-inspector-mcp` package. Setup details and tool documentation
live in `inspector/README.md`.

## Work on the repository

The usual checks are:

```sh
pnpm check
pnpm test
pnpm test:browser
pnpm test:e2e
cargo check
```

`pnpm validate` runs all of them.

The repository is small enough to navigate without much ceremony. `src`
contains the Rust Zed extension. `server` contains discovery, the language
server, and editor presentation. `inspector` contains the Chromium WebGPU
runtime and MCP server. `editors/vscode` contains the VS Code client. `scripts`
contains corpus and coverage tools.

The root lockfile is authoritative. Run repository scripts from the root.
