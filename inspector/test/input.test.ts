import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  buildSymbolInspectionModule,
  normalizeInput,
  normalizeSymbolInput,
} from '../src/inspect.ts';
import {
  classifyImmediatelyUnsupportedPipeline,
  classifyImmediatelyUnsupportedResolvable,
  diagnoseInspectionFailure,
  diagnoseTargetFailure,
} from '../src/browser/diagnostics.ts';
import { inferTargetKind } from '../src/browser/typegpuIntrospection.ts';
import { symbolTargetSchema } from '../src/mcpSchemas.ts';

describe('normalizeInput', () => {
  it('resolves defaults and relative module paths', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = normalizeInput({
      cwd,
      source: { kind: 'modulePath', modulePath: 'test/fixtures/success-compute.ts' },
    });

    expect(result.modulePath).toBe(resolve(cwd, 'test/fixtures/success-compute.ts'));
    expect(result.exportName).toBe('inspect');
    expect(result.timeoutMs).toBe(15_000);
    expect(result.features).toEqual([]);
    expect(result.strictNames).toBe(true);
    expect(result.reuseBrowser).toBe(false);
    expect(result.diagnosticsOnly).toBe(false);
    expect(result.dependencyAliases).toEqual({});
    expect(result.fsAllow).toEqual([]);
    expect(result.staticAssetRoutes).toEqual([]);
    expect(result.sourceKind).toBe('modulePath');
  });

  it('normalizes dependency aliases, static routes, and extra fs allow paths', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = normalizeInput({
      cwd,
      source: { kind: 'modulePath', modulePath: 'test/fixtures/success-compute.ts' },
      dependencyAliases: {
        '#helpers': './test/fixtures/success-compute.ts',
      },
      fsAllow: ['./test/fixtures'],
      staticAssetRoutes: [{ urlPrefix: '/fixtures/', directory: './test/fixtures' }],
    });

    expect(result.dependencyAliases['#helpers']).toBe(
      resolve(cwd, 'test/fixtures/success-compute.ts'),
    );
    expect(result.fsAllow).toEqual([resolve(cwd, 'test/fixtures')]);
    expect(result.staticAssetRoutes).toEqual([
      { urlPrefix: '/fixtures', directory: resolve(cwd, 'test/fixtures') },
    ]);
  });

  it('normalizes package-root dependency resolution aliases', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = normalizeInput({
      cwd,
      source: { kind: 'modulePath', modulePath: 'test/fixtures/success-compute.ts' },
      dependencyResolution: {
        packageAliases: {
          typegpu: 'node_modules/typegpu',
        },
      },
    });

    expect(result.dependencyResolution.packageAliases?.typegpu).toBe(
      resolve(cwd, 'node_modules/typegpu'),
    );
  });

  it('accepts inline source without touching the filesystem during normalization', () => {
    const result = normalizeInput({
      source: {
        kind: 'inlineCode',
        inlineCode: 'export async function inspect() { return [] }',
      },
    });

    expect(result.sourceKind).toBe('inlineCode');
    expect(result.inlineCode).toContain('inspect');
    expect(result.modulePath).toBeUndefined();
  });

  it('wraps inspectBody as an inline inspection module', () => {
    const result = normalizeInput({
      source: { kind: 'inspectBody', inspectBody: 'return [];' },
    });

    expect(result.sourceKind).toBe('inlineCode');
    expect(result.inlineCode).toContain('export async function inspect');
    expect(result.inlineCode).toContain('return [];');
    expect(result.inlineCode).toContain('root, device, tgpu, d, std, common');
    expect(result.modulePath).toBeUndefined();
  });

  it('anchors inline source to an optional virtual source path', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = normalizeInput({
      cwd,
      source: {
        kind: 'inlineCode',
        inlineCode: 'export async function inspect() { return [] }',
        inlineSourcePath: 'test/fixtures/inline-source-main.ts',
      },
    });

    expect(result.sourceKind).toBe('inlineCode');
    expect(result.inlineSourcePath).toBe(resolve(cwd, 'test/fixtures/inline-source-main.ts'));
  });

  it('also anchors inspectBody to an optional virtual source path', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = normalizeInput({
      cwd,
      source: {
        kind: 'inspectBody',
        inspectBody: 'return [];',
        inlineSourcePath: 'test/fixtures/inline-source-main.ts',
      },
    });

    expect(result.sourceKind).toBe('inlineCode');
    expect(result.inlineCode).toContain('export async function inspect');
    expect(result.inlineSourcePath).toBe(resolve(cwd, 'test/fixtures/inline-source-main.ts'));
  });

  it('requires a source object', () => {
    expect(() => normalizeInput({} as never)).toThrow(
      "Pass source with kind 'modulePath', 'inlineCode', or 'inspectBody'",
    );
    expect(() =>
      normalizeInput({
        source: { kind: 'bogus' },
      } as never),
    ).toThrow("source.kind must be 'modulePath', 'inlineCode', or 'inspectBody'");
  });
});

describe('normalizeSymbolInput', () => {
  it('resolves defaults and relative module paths for symbol inspection', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = normalizeSymbolInput({
      cwd,
      modulePath: 'test/fixtures/symbol-targets.ts',
      targets: [{ selector: 'exportedHelper' }],
    });

    expect(result.modulePath).toBe(resolve(cwd, 'test/fixtures/symbol-targets.ts'));
    expect(result.timeoutMs).toBe(15_000);
    expect(result.features).toEqual([]);
    expect(result.strictNames).toBe(true);
    expect(result.reuseBrowser).toBe(false);
    expect(result.staticAssetRoutes).toEqual([]);
    expect(result.targets).toEqual([{ selector: 'exportedHelper' }]);
  });

  it('normalizes package-root dependency resolution aliases for symbol inspection', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = normalizeSymbolInput({
      cwd,
      modulePath: 'test/fixtures/symbol-targets.ts',
      targets: [{ selector: 'exportedHelper' }],
      dependencyResolution: {
        packageAliases: {
          typegpu: 'node_modules/typegpu',
        },
      },
    });

    expect(result.dependencyResolution.packageAliases?.typegpu).toBe(
      resolve(cwd, 'node_modules/typegpu'),
    );
  });

  it('requires at least one symbol target', () => {
    expect(() =>
      normalizeSymbolInput({
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [],
      }),
    ).toThrow('Pass at least one symbol target');
  });

  it('generates a wrapper for exported symbol targets', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [
          { selector: 'exportedHelper' },
          { kind: 'compute-pipeline', compute: 'exportedCompute' },
          {
            kind: 'render-pipeline',
            vertex: 'exportedVertex',
            fragment: 'exportedFragment',
            descriptor: { targets: { format: 'bgra8unorm' } },
          },
        ],
      }),
    );

    expect(result.inlineSourcePath).toContain('symbol-targets.ts.typegpu-mcp-inspect.ts');
    expect(result.inlineCode).toContain(
      'import * as __typegpuEditorInspectedModule from "/@fs/',
    );
    expect(result.inlineCode).toContain('/src/browser/symbolRuntime.ts');
    expect(result.inlineCode).toContain('exportedHelper');
    expect(result.inlineCode).toContain('createComputePipeline');
    expect(result.inlineCode).toContain('createRenderPipeline');
    expect(result.inlineCode).toContain('try {');
    expect(result.inlineCode).toContain('targets.push({ label:');
    expect(result.inlineCode).toContain('error });');
    expect(result.inlineCode).toContain('const setupRoots = setup && typeof setup ===');
    expect(result.inlineCode).toContain(
      'async function __typegpuEditorInspect({ root, device, tgpu, d, std, common })',
    );
    expect(result.inlineCode).toContain('export { __typegpuEditorInspect as inspect };');
    expect(result.inlineCode).not.toContain('export async function inspect(');
    expect(result.inlineCode).toContain('const ctx = { root, device, tgpu, d, std, common };');
    expect(result.inlineCode).toContain('return Object.assign(targets, { __typegpuMcpBindingSources: [');
    expect(result.inlineCode).toContain("{ origin: 'module-scope', value: setupRoots }");
    expect(result.inlineCode).toContain(
      "{ origin: 'module-scope', value: __typegpuEditorInspectedModule }",
    );
    expect(result.inlineCode).not.toContain("origin: 'import-scope'");
  });

  it('re-imports sibling modules as import-scope binding sources', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/imported-accessor-consumer.ts',
        targets: [{ selector: 'importedAccessorFragment', kind: 'resolvable', unwrap: false }],
      }),
    );

    expect(result.inlineCode).toContain('try { __typegpuMcpDep0 = await import("./symbol-targets.ts"); } catch {}');
    expect(result.inlineCode).toContain(
      "{ origin: 'import-scope', label: \"./symbol-targets.ts\", value: __typegpuMcpDep0 }",
    );
    expect(result.inlineCode).not.toContain('await import("typegpu")');
  });

  it('exposes all runtime locals as a module-scope source under includePrivate', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/imported-accessor-consumer.ts',
        includePrivate: true,
        targets: [{ selector: 'importedAccessorFragment', kind: 'resolvable', unwrap: false }],
      }),
    );

    expect(result.inlineCode).toContain('const __typegpuMcpScope = {');
    expect(result.inlineCode).toContain(
      '"paramsAccess": (typeof paramsAccess === \'undefined\' ? undefined : paramsAccess)',
    );
    expect(result.inlineCode).toContain("{ origin: 'module-scope', value: __typegpuMcpScope }");
  });

  it('generates editor probes and render defaults', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [
          {
            selector: 'parameterizedHelper',
            kind: 'resolvable',
            unwrap: false,
            probeArguments: ['ctx.d.vec4f'],
          },
          {
            kind: 'render-pipeline',
            vertex: 'exportedAttributedVertex',
            fragment: 'exportedFragment',
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain("'use gpu';");
    expect(result.inlineCode).toContain('tgpu.fn([])');
    expect(result.inlineCode).toContain('ctx.d.vec4f');
    expect(result.inlineCode).toContain('.ledger');
    expect(result.inlineCode).toContain('true);');
  });

  it('generates mixed zero-value and concrete-value helper arguments', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/resource-targets.ts',
        includePrivate: true,
        targets: [
          {
            selector: 'samplerHelper',
            kind: 'resolvable',
            unwrap: false,
            probeArgumentPlan: [
              { schema: 'ctx.d.vec2f' },
              { value: 'linearSampler.$' },
            ],
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain(
      '"linearSampler": linearSampler',
    );
    expect(result.inlineCode).toContain(
      'const __typegpuMcpProbeValue0_1 = __typegpuMcpReadSelector(inspectedModule, "linearSampler", "targets[0].probeArgumentPlan[1].value", roots);',
    );
    expect(result.inlineCode).toContain(
      '__typegpuMcpSelected0(__typegpuMcpProbeSchema0_0(), __typegpuMcpProbeValue0_1["$"]);',
    );
    expect(result.inlineCode).not.toContain('inspectedModule["linearSampler"]');
    expect(result.inlineCode).toContain(
      'existing values for: linearSampler.$',
    );
  });

  it('can inline a source module and expose selected private declarations', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        includePrivate: true,
        targets: [
          {
            selector: 'privateHelper',
            kind: 'resolvable',
            unwrap: false,
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain('const privateHelper = tgpu.fn');
    expect(result.inlineCode).toContain(
      'const __typegpuEditorInspectedModule = { "privateHelper": privateHelper }',
    );
    expect(result.inlineCode).not.toContain(
      'import * as __typegpuEditorInspectedModule',
    );
  });

  it('exposes imported struct schemas used to synthesize private helper arguments', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        includePrivate: true,
        targets: [
          {
            selector: 'privateHelper',
            kind: 'resolvable',
            probeArguments: ['ctx.d.vec3f', 'module.AccessorParams'],
            probeBindings: [{
              slot: 'paramsAccess',
              schema: 'module.AccessorParams',
            }],
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain(
      'const __typegpuEditorInspectedModule = { "privateHelper": privateHelper, "AccessorParams": AccessorParams, "paramsAccess": paramsAccess }',
    );
    expect(result.inlineCode).toContain(
      '__typegpuMcpProbe0 = __typegpuMcpProbe0.with(__typegpuMcpProbeSlot0_0, __typegpuMcpCreateZeroValue(__typegpuMcpProbeBindingSchema0_0, "targets[0].probeBindings[0].schema"));',
    );
  });

  it('recovers runtime schema values hidden behind type-only imports', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/type-only-helper.ts',
        includePrivate: true,
        targets: [
          {
            selector: 'boundsHelper',
            kind: 'resolvable',
            probeArguments: ['module.Bounds'],
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain(
      '"Bounds": (await import("./type-only-schema.ts"))["Bounds"]',
    );
    expect(result.inlineCode).not.toContain('"Bounds": Bounds');
  });

  it('allows setupBody return values to satisfy top-level helper selectors', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        setupBody: 'return { common: await import("typegpu/common") };',
        targets: [
          {
            kind: 'render-pipeline',
            vertex: 'common.fullScreenTriangle',
            fragment: 'exportedFragment',
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain('readSelector as __typegpuMcpReadSelector');
    expect(result.inlineCode).toContain('common.fullScreenTriangle');
  });

  it('preserves literal setupBody source newlines', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        setupBody: `
const value = 1;
return { value };
`,
        targets: [{ selector: 'setup.value', kind: 'resolvable' }],
      }),
    );

    expect(result.inlineCode).toContain('\n    const value = 1;\n    return { value };\n');
    expect(result.inlineCode).not.toContain('\\nconst value');
  });

  it('generates helpers for explicit binding selectors', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [
          {
            kind: 'render-pipeline',
            vertex: 'exportedVertex',
            descriptor: { targets: { format: 'bgra8unorm' } },
            with: [{ slot: 'paramsAccess', value: 'setup.params' }],
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain('__typegpuMcpCreateRenderPipeline');
    expect(result.inlineCode).toContain(
      '__typegpuMcpCreateRenderPipeline(root, tgpu, d, inspectedModule',
    );
    expect(result.inlineCode).toContain('"slot":"paramsAccess"');
    expect(result.inlineCode).toContain('"value":"setup.params"');
  });

  it('requires explicit binding value selectors', () => {
    const cwd = resolve(import.meta.dirname, '..');

    expect(() =>
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [
          {
            kind: 'render-pipeline',
            vertex: 'exportedVertex',
            with: [{ slot: 'paramsAccess' } as never],
          },
        ],
      }),
    ).toThrow('Expected targets[0].with[0].value to be a non-empty selector.');
  });

  it('generates render attrib selector maps', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [
          {
            kind: 'render-pipeline',
            vertex: 'exportedAttributedVertex',
            fragment: 'exportedFragment',
            attribs: { color: 'exportedAttributedVertexLayout.attrib' },
            descriptor: { targets: { format: 'bgra8unorm' } },
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain('targets[0].attribs.color');
    expect(result.inlineCode).toContain('"color": __typegpuMcpAttribs0_0');
  });

  it('guards unresolvable private roots instead of emitting bare identifiers', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        includePrivate: true,
        targets: [
          { selector: 'privateHelper', kind: 'resolvable' },
          { selector: 'neverDeclared.field', kind: 'resolvable' },
        ],
      }),
    );

    expect(result.inlineCode).toContain(
      `"neverDeclared": (typeof neverDeclared === 'undefined' ? undefined : neverDeclared)`,
    );
    expect(result.inlineCode).toContain('"privateHelper": privateHelper');
    expect(result.inlineCode).not.toContain('{ "neverDeclared": neverDeclared');
  });

  it('exposes module properties referenced only from setupBody', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        includePrivate: true,
        setupBody:
          'const helper = module.privateHelper;\nconst layout = inspectedModule.attributedVertexLayout;\nreturn { helper, layout };',
        targets: [{ selector: 'setup.helper', kind: 'resolvable' }],
      }),
    );

    expect(result.inlineCode).toContain('"privateHelper": privateHelper');
    expect(result.inlineCode).toContain('"attributedVertexLayout": attributedVertexLayout');
  });

  it('keeps the inspect export when the inlined module declares its own inspect', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/inspect-local-collision.ts',
        includePrivate: true,
        targets: [{ selector: 'privateHelper', kind: 'resolvable' }],
      }),
    );

    expect(result.inlineCode).toContain('"privateHelper": privateHelper');
    expect(result.inlineCode).not.toContain('import * as __typegpuEditorInspectedModule');
    expect(result.inlineCode).toContain('async function __typegpuEditorInspect(');
    expect(result.inlineCode).toContain('export { __typegpuEditorInspect as inspect };');
    expect(result.inlineCode).not.toContain('export async function inspect(');
  });

  it('falls back to module import when the inlined module already exports inspect', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/inspect-export-collision.ts',
        includePrivate: true,
        targets: [{ selector: 'privateHelper', kind: 'resolvable' }],
      }),
    );

    expect(result.inlineCode).toContain('import * as __typegpuEditorInspectedModule from "/@fs/');
    expect(result.inlineCode).not.toContain('const __typegpuEditorInspectedModule = {');
    expect(result.inlineCode).toContain('export { __typegpuEditorInspect as inspect };');
  });

  it('falls back to module import when the inlined module declares a generated binding', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/generated-binding-collision.ts',
        includePrivate: true,
        targets: [{ selector: 'privateHelper', kind: 'resolvable' }],
      }),
    );

    expect(result.inlineCode).toContain('import * as __typegpuEditorInspectedModule from "/@fs/');
    expect(result.inlineCode).not.toContain('const __typegpuEditorInspectedModule = { spoofed');
  });

  it('resolves probe value selector roots through readSelector', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        setupBody: 'return { extras: await import("typegpu/common") };',
        targets: [
          {
            selector: 'parameterizedHelper',
            kind: 'resolvable',
            probeArgumentPlan: [{ value: 'extras.fullScreenTriangle.shell' }],
          },
        ],
      }),
    );

    // The root goes through readSelector so setup-returned roots win; only the
    // trailing property path stays a deferred member access.
    expect(result.inlineCode).toContain(
      'const __typegpuMcpProbeValue0_0 = __typegpuMcpReadSelector(inspectedModule, "extras", "targets[0].probeArgumentPlan[0].value", roots);',
    );
    expect(result.inlineCode).toContain(
      '__typegpuMcpProbeValue0_0["fullScreenTriangle"]["shell"]',
    );
    expect(result.inlineCode).not.toContain('inspectedModule["extras"]');
  });

  it('unwraps decorated schemas before synthesizing probe zero values', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [
          {
            selector: 'parameterizedHelper',
            kind: 'resolvable',
            probeArguments: ['ctx.d.vec4f'],
            probeBindings: [{ slot: 'paramsAccess', schema: 'AccessorParams' }],
          },
        ],
      }),
    );

    expect(result.inlineCode).toContain(
      'const __typegpuMcpProbeSchema0_0 = __typegpuMcpUnwrapZeroValueSchema(__typegpuMcpReadSelector(',
    );
    expect(result.inlineCode).toContain(
      '__typegpuMcpCreateZeroValue(__typegpuMcpProbeBindingSchema0_0, "targets[0].probeBindings[0].schema")',
    );
    expect(result.inlineCode).not.toContain('__typegpuMcpProbeBindingSchema0_0()');
  });

  it('keeps the error path kind aligned with the success path', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const inferred = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [{ selector: 'exportedCompute' }],
      }),
    );
    const explicit = buildSymbolInspectionModule(
      normalizeSymbolInput({
        cwd,
        modulePath: 'test/fixtures/symbol-targets.ts',
        targets: [{ selector: 'exportedCompute', kind: 'compute-pipeline' }],
      }),
    );

    expect(inferred.inlineCode).toContain('targets.push({ label: "exportedCompute", error: error });');
    expect(inferred.inlineCode).not.toContain('kind: "resolvable"');
    expect(explicit.inlineCode).toContain(
      'targets.push({ label: "exportedCompute", kind: "compute-pipeline", error: error });',
    );
  });
});

describe('target kind and schema helpers', () => {
  it('infers pipeline target kinds directly from TypeGPU resourceType', () => {
    expect(inferTargetKind({ resourceType: 'compute-pipeline' })).toBe('compute-pipeline');
    expect(inferTargetKind({ resourceType: 'render-pipeline' })).toBe('render-pipeline');
    expect(inferTargetKind({ resourceType: 'function' })).toBe('resolvable');
    expect(inferTargetKind({})).toBe('resolvable');
  });

  it('strips unknown schema fields from symbol targets', () => {
    const parsed = symbolTargetSchema.parse({
      selector: 'exportedHelper',
      kind: 'resolvable',
      unknown: true,
    });

    expect(parsed).toEqual({ selector: 'exportedHelper', kind: 'resolvable' });
  });

  it('accepts render attrib selector maps in the MCP schema', () => {
    const parsed = symbolTargetSchema.parse({
      kind: 'render-pipeline',
      vertex: 'vertex',
      fragment: 'fragment',
      attribs: { color: 'layout.attrib' },
    });

    expect(parsed).toEqual({
      kind: 'render-pipeline',
      vertex: 'vertex',
      fragment: 'fragment',
      attribs: { color: 'layout.attrib' },
      synthesizeMissing: true,
    });
  });

  it('does not keep unwrap on pipeline factory symbol targets', () => {
    const parsed = symbolTargetSchema.parse({
      kind: 'compute-pipeline',
      compute: 'exportedCompute',
      unwrap: false,
    });

    expect(parsed).toEqual({
      kind: 'compute-pipeline',
      compute: 'exportedCompute',
    });
  });
});

describe('diagnostic classifiers', () => {
  it('classifies wrapper-required failures', () => {
    const diagnostics = diagnoseTargetFailure(
      undefined,
      'resolvable',
      new Error('Cannot resolve function because it expects arguments.'),
    );

    expect(diagnostics[0]?.code).toBe('wrapper-required');
  });

  it('classifies slot-binding-required failures', () => {
    const diagnostics = diagnoseTargetFailure(
      undefined,
      'resolvable',
      new Error("Missing value for 'slot:params'."),
    );

    expect(diagnostics[0]?.code).toBe('slot-binding-required');
    expect(diagnostics[0]?.message).toContain('params');
  });

  it('classifies module import failures at target and inspection scope', () => {
    const targetDiagnostics = diagnoseTargetFailure(
      undefined,
      'resolvable',
      new Error('Failed to fetch dynamically imported module'),
    );
    const inspectionDiagnostics = diagnoseInspectionFailure(
      new Error('Failed to fetch dynamically imported module'),
    );

    expect(targetDiagnostics[0]?.code).toBe('module-import-failed');
    expect(inspectionDiagnostics[0]?.code).toBe('module-import-failed');
  });

  it('classifies result serialization failures', () => {
    const diagnostics = diagnoseTargetFailure(
      undefined,
      'resolvable',
      new Error('Cannot serialize result: object reference chain is too long'),
    );

    expect(diagnostics[0]?.code).toBe('result-serialization-failed');
  });

  it('classifies inspection-scope result serialization failures', () => {
    const diagnostics = diagnoseInspectionFailure(
      new Error('page.evaluate: Cannot serialize result: object reference chain is too long.'),
    );

    expect(diagnostics[0]?.code).toBe('result-serialization-failed');
  });

  it('classifies random helper resolution failures', () => {
    const diagnostics = diagnoseTargetFailure(
      undefined,
      'resolvable',
      new Error('Could not resolve fn:randSeed42'),
    );

    expect(diagnostics[0]?.code).toBe('typegpu-random-resolution-failed');
  });

  it('classifies internal resource failures', () => {
    const diagnostics = diagnoseTargetFailure(
      { resourceType: 'slot' },
      'resolvable',
      new Error('Unknown resource type: slot'),
    );

    expect(diagnostics[0]?.code).toBe('unsupported-internal-resource');
  });

  it('classifies non-shader TypeGPU resources before resolution', () => {
    const diagnostic = classifyImmediatelyUnsupportedResolvable({
      resourceType: 'compute-pipeline',
    });

    expect(diagnostic?.code).toBe('not-shader-resolvable');
    expect(diagnostic?.hint).toContain("kind: 'compute-pipeline'");
  });

  it('classifies raw WebGPU pipelines before TypeGPU unwrap', () => {
    class GPUComputePipeline {}

    const diagnostic = classifyImmediatelyUnsupportedPipeline(
      new GPUComputePipeline(),
      'compute-pipeline',
    );

    expect(diagnostic?.code).toBe('raw-webgpu-pipeline-unsupported');
    expect(diagnostic?.message).toContain('raw WebGPU compute pipeline');
    expect(diagnostic?.hint).toContain('TypeGPU compute entrypoint');
  });
});
