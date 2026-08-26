import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { discoverTypeGpuModule } from '../src/discovery.js';
import { tableRowWidth } from '../src/markdown.js';
import {
  createCodeActions,
  createDetailLevelActions,
  createDiagnostics,
  defaultSurfaceOptions,
  createDocumentLinks,
  createHover,
  createInlayHints,
  createInlayDetailLevelActions,
  defaultMaxColumnsForClient,
  failedTargetInspection,
  materializeInspection,
  mergeDocumentInspections,
} from '../src/surface.js';

describe('inspection surface', () => {
  it('drops materialization-only runtime evidence after preserving editor surfaces', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/pipeline.ts',
      `const pipeline = root.createRenderPipeline({ vertex, fragment });`,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/pipeline.ts',
      1,
      discovered,
      {
        ok: true,
        summary: { totalMs: 12, browserVersion: '123.0' },
        environment: {
          gpuType: 'software',
          browserVersion: '123.0',
          limits: { maxComputeInvocationsPerWorkgroup: 256 },
          verboseDeviceEvidence: { large: 'discard me' },
        },
        stats: { timings: { totalMs: 12 }, verboseTrace: ['discard me'] },
        console: [{ type: 'log', text: 'discard me' }],
        causes: [{
          id: 'module',
          tier: 'module',
          code: 'context',
          message: 'discard me',
        }],
        targets: [{
          label: 'pipeline',
          kind: 'render-pipeline',
          ok: true,
          callIds: [1],
          wgsl: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(); }',
        }],
        calls: [{
          id: 1,
          name: 'device.createRenderPipeline',
          descriptor: { primitive: { topology: 'triangle-list' } },
        }],
      },
    );

    expect(inspection.targets.get(discovered.targets[0]!.id)?.pipelineState)
      .toMatchObject({ kind: 'render', primitive: { topology: 'triangle-list' } });
    expect(inspection.output).toMatchObject({
      summary: { totalMs: 12 },
      stats: { timings: { totalMs: 12 } },
      environment: {
        gpuType: 'software',
        limits: { maxComputeInvocationsPerWorkgroup: 256 },
      },
    });
    expect(inspection.output.calls).toBeUndefined();
    expect(inspection.output.console).toBeUndefined();
    expect(inspection.output.causes).toBeUndefined();
    expect(inspection.output.environment?.verboseDeviceEvidence).toBeUndefined();
  });

  it('presents bounded synthesized specializations as distinct contexts', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/evolve.ts',
      `
        const evolveVec = <T extends d.v2f | d.v4f>(a: T, b: T): T => {
          'use gpu';
          if (a.kind === 'vec2f') return a;
          return b;
        };
      `,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/evolve.ts',
      1,
      discovered,
      {
        ok: true,
        targets: discovered.targets.map((target) => ({
          label: target.label,
          kind: 'resolvable',
          ok: true,
          wgsl: target.label.includes('vec2f')
            ? 'fn evolveVec(a: vec2f, b: vec2f) -> vec2f { return a; }'
            : 'fn evolveVec(a: vec4f, b: vec4f) -> vec4f { return a; }',
        })),
      },
    );

    const symbol = discovered.symbols[0]!;
    const hover = createHover(symbol, discovered, inspection, 1);
    const markdown = (hover.contents as { value: string }).value;
    // The specializations themselves are the fact; the preamble explaining
    // where they came from is provenance and belongs in deep.
    expect(markdown).not.toContain('Showing 2');
    expect(markdown).not.toContain('synthesized');
    expect(markdown).toContain('Context 1 of 2 · evolveVec(vec2f, vec2f)');
    expect(markdown).toContain('Context 2 of 2 · evolveVec(vec4f, vec4f)');

    const deepHover = createHover(
      symbol,
      discovered,
      inspection,
      1,
      new Set(),
      { ...defaultSurfaceOptions, hoverDetailLevel: 'deep' },
    );
    expect((deepHover.contents as { value: string }).value).toContain(
      'Showing 2 specializations inferred from finite parameter types.',
    );

    const hints = createInlayHints(
      discovered,
      inspection,
      1,
      { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
      new Set(),
      { ...defaultSurfaceOptions, inlayDetailLevel: 'detailed' },
    );
    expect(hints[0]?.label).toContain('2 specializations');

    const bounded = discoverTypeGpuModule(
      '/workspace/bounded.ts',
      `const bounded = (
        a: d.v2f | d.v4f,
        b: d.v2f | d.v4f,
        c: d.v2f | d.v4f,
        d: d.v2f | d.v4f,
      ) => { 'use gpu'; return 0; };`,
    );
    const boundedHover = createHover(
      bounded.symbols[0]!,
      bounded,
      undefined,
      1,
    );
    expect((boundedHover.contents as { value: string }).value).toContain(
      'Showing the first 8 specializations (limit 8); ' +
        'additional finite combinations were omitted.',
    );
  });

  it('merges partial same-version results without erasing completed targets', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/shaders.ts',
      `
        const first = tgpu.computeFn({ workgroupSize: [1] })(() => {});
        const second = tgpu.computeFn({ workgroupSize: [1] })(() => {});
      `,
    );
    const firstTarget = discovered.targets.find((target) => target.label === 'first')!;
    const secondTarget = discovered.targets.find((target) => target.label === 'second')!;
    const first = await materializeInspection(
      '/workspace',
      '/workspace/shaders.ts',
      3,
      discovered,
      {
        ok: true,
        targets: [{ label: 'first', kind: 'compute-pipeline', ok: true }],
      },
    );
    const second = await materializeInspection(
      '/workspace',
      '/workspace/shaders.ts',
      3,
      discovered,
      {
        ok: true,
        targets: [{ label: 'second', kind: 'compute-pipeline', ok: true }],
      },
    );

    const merged = mergeDocumentInspections(first, second, [secondTarget.id]);
    expect([...merged.targets.keys()]).toEqual([firstTarget.id, secondTarget.id]);
    expect(merged.output.summary).toMatchObject({
      targetCount: 2,
      passedTargetCount: 2,
      failedTargetCount: 0,
    });

    const failedRefresh = failedTargetInspection(
      3,
      [secondTarget.id],
      'Chromium timed out',
    );
    const failureMerged = mergeDocumentInspections(
      merged,
      failedRefresh,
      [secondTarget.id],
    );
    expect(failureMerged.targets.get(firstTarget.id)).toBeDefined();
    expect(failureMerged.targets.get(secondTarget.id)).toBeDefined();
    expect(failureMerged.targetFailures?.get(secondTarget.id)).toBe(
      'Chromium timed out',
    );

    const newer = { ...second, sourceVersion: 4 };
    const staleRejected = mergeDocumentInspections(first, newer, [secondTarget.id]);
    expect([...staleRejected.targets.keys()]).toEqual([secondTarget.id]);
  });

  it('surfaces inspection progress immediately in hover and inlay UI', () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/shader.ts',
      `const main = tgpu.computeFn({ workgroupSize: [1] })(() => {});`,
    );
    const symbol = discovered.symbols[0]!;
    const inspecting = new Set(symbol.targetIds);

    const hover = createHover(symbol, discovered, undefined, 1, inspecting);
    const markdown = typeof hover.contents === 'object' &&
        !Array.isArray(hover.contents) &&
        'value' in hover.contents
      ? hover.contents.value
      : '';
    expect(markdown).toContain('Inspecting this target');
    expect(markdown).toContain('runtime report will appear');
    expect(markdown).not.toContain('Save the file');

    const hints = createInlayHints(
      discovered,
      undefined,
      1,
      { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
      inspecting,
    );
    expect(hints[0]?.label).toBe('◌ inspecting…');
  });

  it('does not describe a derived-but-unmaterialized target as undetectable', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/helper.ts',
      `const fresnelSchlick = (cosTheta: number, ior1: number, ior2: number) => {
        'use gpu';
        return cosTheta + ior1 + ior2;
      };`,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/helper.ts',
      1,
      discovered,
      { ok: true, targets: [] },
    );

    const hover = createHover(discovered.symbols[0]!, discovered, inspection, 1);
    const markdown = typeof hover.contents === 'object' &&
        !Array.isArray(hover.contents) &&
        'value' in hover.contents
      ? hover.contents.value
      : '';
    expect(markdown).toContain('An inspection target was derived');
    expect(markdown).toContain('Save the file to retry');
    expect(markdown).not.toContain('No standalone runtime inspection target');

    const hints = createInlayHints(
      discovered,
      inspection,
      1,
      {
        start: { line: 0, character: 0 },
        end: { line: 10, character: 0 },
      },
    );
    expect(hints[0]?.label).toBe('◌ save');
  });

  it('presents materialized WGSL, bindings, layouts, and status', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/shader.ts',
      `export const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
        'use gpu';
      });`,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/shader.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: 'main',
          kind: 'compute-pipeline',
          ok: true,
          resolutionMs: 7.4,
          compilationMessages: [],
          callIds: [1, 2],
          wgsl: `@group(0) @binding(0) var<uniform> params: vec4f;

@compute @workgroup_size(8, 8)
fn main() {
  workgroupBarrier();
}`,
        }],
        stats: {
          shaderModuleCount: 1,
          pipelineCount: 1,
          explicitBindGroupLayoutCount: 1,
          inferredCatchallBindGroupLayoutCount: 0,
          bindingCounts: { total: 1 },
          timings: { totalMs: 987.4 },
        },
        environment: {
          gpuType: 'software',
          browserVersion: '149.0.7827.55',
          limits: {
            maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupSizeY: 256,
            maxComputeWorkgroupSizeZ: 64,
            maxComputeInvocationsPerWorkgroup: 64,
          },
        },
        warnings: ['Using a bundled TypeGPU fallback for this inspection.'],
        calls: [{
          id: 2,
          name: 'device.createBindGroupLayout',
          targetLabel: 'main',
          descriptor: {
            label: 'paramsLayout',
            entries: [{
              binding: 0,
              visibility: 4,
              buffer: { type: 'uniform', hasDynamicOffset: false },
            }],
          },
        }],
      },
    );
    const symbol = discovered.symbols[0];
    expect(symbol).toBeDefined();

    const hover = createHover(symbol!, discovered, inspection, 1);
    const markdown = typeof hover.contents === 'object' &&
        !Array.isArray(hover.contents) &&
        'value' in hover.contents
      ? hover.contents.value
      : '';
    expect(markdown).toContain('**Bindings**');
    expect(markdown).toContain('| **Entry** | compute `main` |');
    expect(markdown).toContain(
      '| **Workgroup** | 8 × 8 × 1 = 64 invocations · **at device maximum** · 64 max |',
    );
    expect(markdown).toContain('**Static occurrences:** 1 barrier');
    expect(markdown).not.toContain('**Shader facts**');
    expect(markdown).toContain('`params`');
    expect(markdown).toContain('compute');
    expect(markdown).not.toContain('buffer · uniform');
    expect(markdown).toContain('✓ WGSL validated');
    expect(markdown).not.toContain('987 ms');
    expect(markdown).not.toContain('Chromium 149');
    expect(markdown).not.toContain('149.0.7827.55');
    expect(markdown).toContain('**Runtime notes**');
    expect(markdown).toContain('bundled TypeGPU fallback');
    expect(markdown).toContain('| Binding | Type | Stages |');
    expect(markdown).toContain('Open full inspection report');

    const hints = createInlayHints(
      discovered,
      inspection,
      1,
      {
        start: { line: 0, character: 0 },
        end: { line: 10, character: 0 },
      },
    );
    expect(hints[0]?.label).toBe('✓');
    expect(hints[0]?.label).not.toContain('117 B');
    expect(String(hints[0]?.label).length).toBeLessThanOrEqual(36);
    expect(hints[0]?.label).not.toContain('TypeGPU');

    const staleHints = createInlayHints(
      discovered,
      inspection,
      2,
      {
        start: { line: 0, character: 0 },
        end: { line: 10, character: 0 },
      },
    );
    expect(staleHints[0]?.label).toContain('◌ stale');
    expect(String(staleHints[0]?.label).length).toBeLessThanOrEqual(36);

    const tableHeaders = markdown
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.includes('---'));
    expect(tableHeaders.every((line) =>
      (line.match(/\|/g)?.length ?? 0) <= 6
    )).toBe(true);

    const links = createDocumentLinks(discovered, inspection);
    expect(links).toHaveLength(1);
    expect(await readFile(fileURLToPath(links[0]!.target!), 'utf8')).toContain(
      '@compute',
    );
    const reportUri = inspection.targets.values().next().value?.generatedReportUri;
    expect(reportUri).toBeDefined();
    expect(await readFile(fileURLToPath(reportUri!), 'utf8')).toContain(
      '# TypeGPU inspection · main',
    );
  });

  it('correlates resolution-derived layouts when a pipeline has no target-owned GPU calls', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/blur.ts',
      `const computePipeline = root.createComputePipeline({ compute: computeFn });`,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/blur.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: 'computePipeline',
          kind: 'compute-pipeline',
          ok: true,
          callIds: [1],
          wgsl: `@group(0) @binding(0) var<uniform> sizeUniform: vec3u;
@group(0) @binding(1) var<storage, read_write> fish_data_0: array<f32>;
@compute @workgroup_size(1) fn main() {}`,
          bindGroupLayouts: [{
            group: 0,
            label: '<unnamed>',
            source: 'resolution',
            entries: [{
              binding: 0,
              name: 'sizeUniform',
              visibility: ['compute', 'vertex', 'fragment'],
              resource: { buffer: { type: 'uniform' } },
            }, {
              binding: 1,
              name: 'fish_data_0',
              visibility: ['compute', 'fragment'],
              resource: { buffer: { type: 'storage' } },
            }],
          }],
        }],
        calls: [{
          id: 1,
          name: 'device.createShaderModule',
          ok: true,
        }],
      },
    );

    const hover = createHover(discovered.symbols[0]!, discovered, inspection, 1);
    const markdown = (hover.contents as { value: string }).value;
    expect(markdown).toMatch(/sizeUniform` \| uniform vec3u \| all stages \|/);
    expect(markdown).toMatch(
      /fish_data_0` \| storage read\\_write array.* \| compute · fragment \|/,
    );
    expect(markdown).not.toContain('buffer · uniform');

    const deep = createHover(
      discovered.symbols[0]!,
      discovered,
      inspection,
      1,
      new Set(),
      { ...defaultSurfaceOptions, hoverDetailLevel: 'deep' },
    );
    expect((deep.contents as { value: string }).value).toContain(
      '| Binding | Type | Stages | WebGPU |',
    );
  });

  it('presents resource memory layouts, bindings, usages, and vertex attributes', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/resources.ts',
      `
        const Params = d.struct({
          direction: d.vec2f,
          radius: d.f32,
          camera: d.struct({
            position: d.vec3f,
            exposure: d.f32,
          }),
        });
        const layout = tgpu.bindGroupLayout({
          params: { uniform: Params },
          image: { texture: d.texture2d(d.f32) },
        });
        const resources = {
          buffers: { params: root.createUniform(Params, initial) },
          image: root.createTexture(textureProps).$usage('sampled', 'render'),
        };
      `,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/resources.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: 'Params',
          kind: 'resource',
          ok: true,
          compilationMessages: [],
          resource: {
            resourceType: 'schema',
            sizeBytes: 48,
            alignmentBytes: 16,
            schema: {
              type: 'struct',
              sizeBytes: 48,
              alignmentBytes: 16,
              fields: [
                {
                  name: 'direction',
                  offsetBytes: 0,
                  schema: { type: 'vec2f', sizeBytes: 8, alignmentBytes: 8 },
                },
                {
                  name: 'radius',
                  offsetBytes: 8,
                  schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
                },
                {
                  name: 'camera',
                  offsetBytes: 16,
                  schema: {
                    type: 'struct',
                    sizeBytes: 32,
                    alignmentBytes: 16,
                    fields: [
                      {
                        name: 'position',
                        offsetBytes: 0,
                        schema: {
                          type: 'vec3f',
                          sizeBytes: 12,
                          alignmentBytes: 16,
                        },
                      },
                      {
                        name: 'exposure',
                        offsetBytes: 16,
                        schema: {
                          type: 'f32',
                          sizeBytes: 4,
                          alignmentBytes: 4,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        }, {
          label: 'layout',
          kind: 'resource',
          ok: true,
          compilationMessages: [],
          resource: {
            resourceType: 'bind-group-layout',
            bindings: [
              {
                name: 'params',
                binding: 0,
                kind: 'uniform',
                visibility: ['compute', 'vertex', 'fragment'],
                schema: { type: 'struct' },
              },
              {
                name: 'image',
                binding: 1,
                kind: 'texture',
                visibility: ['compute', 'vertex', 'fragment'],
                schema: { type: 'texture_2d' },
              },
            ],
          },
        }, {
          label: 'resources',
          kind: 'resource',
          ok: true,
          compilationMessages: [],
          resource: {
            resourceType: 'collection',
            count: 2,
            itemNames: ['buffers', 'image'],
            items: [
              {
                resourceType: 'collection',
                count: 1,
                itemNames: ['params'],
                items: [{
                  resourceType: 'uniform',
                  sizeBytes: 48,
                  usages: ['uniform'],
                }],
              },
              {
                resourceType: 'texture',
                usages: ['sampled', 'render'],
              },
            ],
          },
        }],
      },
    );

    const schemaHover = createHover(discovered.symbols[0]!, discovered, inspection, 1);
    const schemaMarkdown = typeof schemaHover.contents === 'object' &&
        !Array.isArray(schemaHover.contents) &&
        'value' in schemaHover.contents
      ? schemaHover.contents.value
      : '';
    expect(schemaMarkdown).toContain('✓ Resource inspected');
    expect(schemaMarkdown).toContain(
      '| **Layout** | struct · 48 B size · 16-byte alignment |',
    );
    expect(schemaMarkdown).toContain('| **Host-shareable** | Yes |');
    expect(schemaMarkdown).not.toContain('**Resource**');
    expect(schemaMarkdown).not.toContain('**Schema**');
    expect(schemaMarkdown).not.toContain('| **Kind** |');
    expect(schemaMarkdown).toContain('`direction`');
    expect(schemaMarkdown).toContain('| `radius` | 8 | `f32` | 4 B · align 4 B |');
    expect(schemaMarkdown).toContain(
      '| `camera.\u200bposition` | 16 | `vec3f` | 12 B · align 16 B |',
    );
    expect(schemaMarkdown).toContain(
      '| `camera.\u200bexposure` | 32 | `f32` | 4 B · align 4 B |',
    );
    expect(schemaMarkdown).toContain(
      '| **Memory** | 48 B allocated · 28 B data · 20 B padding (42%) |',
    );
    expect(schemaMarkdown).toContain(
      '| **Padding map** | 4 B `before camera`',
    );
    expect(schemaMarkdown).toContain('12 B `camera tail`');
    expect(schemaMarkdown).not.toContain('**Padding character:**');
    expect(schemaMarkdown).not.toContain('reordering this structure');
    expect(schemaMarkdown).toContain('| Field | Offset | Type | Layout |');
    expect(schemaMarkdown).not.toContain('⚠');

    const compactSchemaHover = createHover(
      discovered.symbols[0]!,
      discovered,
      inspection,
      1,
      new Set(),
      { ...defaultSurfaceOptions, hoverDetailLevel: 'compact' },
    );
    const compactSchema = (compactSchemaHover.contents as { value: string }).value;
    expect(compactSchema).toContain('`camera.\u200bposition`');
    expect(compactSchema).toContain('`camera.\u200bexposure`');
    expect(compactSchema).not.toContain('⚠');

    const layoutHover = createHover(discovered.symbols[1]!, discovered, inspection, 1);
    const layoutMarkdown = typeof layoutHover.contents === 'object' &&
        !Array.isArray(layoutHover.contents) &&
        'value' in layoutHover.contents
      ? layoutHover.contents.value
      : '';
    expect(layoutMarkdown).toContain('**Bindings**');
    expect(layoutMarkdown).toContain('`params`');
    expect(layoutMarkdown).toContain('`image`');
    expect(layoutMarkdown).toContain('texture · texture\\_2d');
    expect(layoutMarkdown).toContain('| Binding | Type | Stages |');
    expect(layoutMarkdown).toContain('all stages');

    const collectionHover = createHover(
      discovered.symbols.find((symbol) => symbol.name === 'resources')!,
      discovered,
      inspection,
      1,
    );
    const collectionMarkdown = typeof collectionHover.contents === 'object' &&
        !Array.isArray(collectionHover.contents) &&
        'value' in collectionHover.contents
      ? collectionHover.contents.value
      : '';
    expect(collectionMarkdown).toContain(
      '| **Bundle** | 2 fields · 2 resource leaves |',
    );
    expect(collectionMarkdown).toContain('| `buffers` | uniform ×1 · 48 B · uniform |');
    expect(collectionMarkdown).toContain('| `image` | texture · sampled +\u200b render |');
    expect(collectionMarkdown).not.toContain('| `buffers.\u200bparams` |');

    const hints = createInlayHints(
      discovered,
      inspection,
      1,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      },
    );
    expect(hints[0]?.label).toBe('✓');
    expect(hints[1]?.label).toBe('✓');

    const summaryHints = createInlayHints(
      discovered,
      inspection,
      1,
      { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
      new Set(),
      { ...defaultSurfaceOptions, inlayDetailLevel: 'summary' },
    );
    expect(summaryHints[0]?.label).toContain('✓ 48 B');
    expect(summaryHints[1]?.label).toContain('2 bindings');
  });

  it('presents proven layout improvements and exact padding-map omissions', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/layout-health.ts',
      `
        const Packed = d.struct({ age: d.f32, position: d.vec4f, mass: d.f32 });
        const Wide = d.struct({
          a: d.f32, b: d.f32, c: d.f32, d: d.f32,
          e: d.f32, f: d.f32, g: d.f32, h: d.f32,
        });
      `,
    );
    const wideFields = Array.from({ length: 8 }, (_, index) => ({
      name: String.fromCharCode(97 + index),
      offsetBytes: index * 8,
      schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
    }));
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/layout-health.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: 'Packed',
          kind: 'resource',
          ok: true,
          resource: {
            resourceType: 'schema',
            schema: {
              type: 'struct',
              sizeBytes: 48,
              alignmentBytes: 16,
              fields: [{
                name: 'age',
                offsetBytes: 0,
                schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
              }, {
                name: 'position',
                offsetBytes: 16,
                schema: { type: 'vec4f', sizeBytes: 16, alignmentBytes: 16 },
              }, {
                name: 'mass',
                offsetBytes: 32,
                schema: { type: 'f32', sizeBytes: 4, alignmentBytes: 4 },
              }],
            },
          },
        }, {
          label: 'Wide',
          kind: 'resource',
          ok: true,
          resource: {
            resourceType: 'schema',
            schema: {
              type: 'struct',
              sizeBytes: 64,
              alignmentBytes: 4,
              fields: wideFields,
            },
          },
        }],
      },
    );

    const packed = createHover(discovered.symbols[0]!, discovered, inspection, 1);
    const packedMarkdown = (packed.contents as { value: string }).value;
    expect(packedMarkdown).toContain('| **Tighter order** |');
    expect(packedMarkdown).toContain('48 B → 32 B · save 16 B');
    expect(packedMarkdown).not.toContain('buffer ABI');

    const packingDisabled = createHover(
      discovered.symbols[0]!,
      discovered,
      inspection,
      1,
      new Set(),
      { ...defaultSurfaceOptions, schemaPackingSuggestions: false },
    );
    const packingDisabledMarkdown = (packingDisabled.contents as { value: string }).value;
    expect(packingDisabledMarkdown).toContain('| **Memory** |');
    expect(packingDisabledMarkdown).not.toContain('**Tighter order**');

    const wide = createHover(discovered.symbols[1]!, discovered, inspection, 1);
    const wideMarkdown = (wide.contents as { value: string }).value;
    expect(wideMarkdown).toContain('…2 more regions');
  });

  it('presents factory resource results as one detailed bundle', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/resources.ts',
      `
        function createResources() {
          const textures = [0, 1].map(() => root.createTexture(textureProps));
          const maskTexture = root.createTexture(maskProps);
          const pingPongBindGroups = [0, 1].map((index) =>
            root.createBindGroup(pingPongLayout, {
              readView: textures[index],
              writeView: textures[1 - index],
            })
          );
          const maskBindGroup = root.createBindGroup(maskLayout, {
            maskTexture,
          });
          return { textures, maskTexture, pingPongBindGroups, maskBindGroup };
        }
        let resources = createResources();
      `,
    );
    const target = discovered.targets[0]!;
    const texture = {
      resourceType: 'texture',
      usages: ['storage'],
      properties: {
        size: [32, 32],
        format: 'rgba16float',
        dimension: '2d',
      },
    };
    const pingPongBindings = [
      {
        name: 'writeView',
        binding: 0,
        kind: 'storageTexture',
        visibility: ['compute', 'fragment'],
        schema: {
          type: 'texture_storage_2d',
          properties: { format: 'rgba16float', access: 'write-only' },
        },
      },
      {
        name: 'readView',
        binding: 1,
        kind: 'storageTexture',
        visibility: ['compute', 'fragment'],
        schema: {
          type: 'texture_storage_2d',
          properties: { format: 'rgba16float', access: 'read-only' },
        },
      },
    ];
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/resources.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: target.label,
          kind: 'resource',
          ok: true,
          resource: {
            resourceType: 'collection',
            count: 4,
            itemNames: [
              'textures',
              'maskTexture',
              'pingPongBindGroups',
              'maskBindGroup',
            ],
            items: [
              { resourceType: 'collection', count: 2, items: [texture, texture] },
              {
                resourceType: 'texture',
                usages: ['storage'],
                properties: { size: [32, 32], format: 'r32uint' },
              },
              {
                resourceType: 'collection',
                count: 2,
                items: [
                  { resourceType: 'bind-group', bindings: pingPongBindings },
                  { resourceType: 'bind-group', bindings: pingPongBindings },
                ],
              },
              {
                resourceType: 'bind-group',
                bindings: [{
                  name: 'maskTexture',
                  binding: 0,
                  kind: 'storageTexture',
                  visibility: ['compute', 'fragment'],
                  schema: {
                    type: 'texture_storage_2d',
                    properties: { format: 'r32uint', access: 'write-only' },
                  },
                }],
              },
            ],
          },
        }],
      },
    );

    const symbol = discovered.symbols.find((candidate) => candidate.name === 'resources')!;
    const hover = createHover(symbol, discovered, inspection, 1);
    const markdown = (hover.contents as { value: string }).value;
    const plainMarkdown = markdown.replaceAll('\u200b', '');
    expect(symbol.targetIds).toEqual([target.id]);
    expect(markdown).not.toContain('Context 1 of');
    expect(markdown).toContain('Using concrete factory result');
    expect(markdown).toContain('4 fields · 6 resource leaves');
    expect(markdown).toContain(
      '| `textures` | texture ×2 · 32×32 · rgba16float · storage |',
    );
    expect(markdown).toContain(
      '| `pingPongBindGroups` | bind-group ×2 · 2 bindings |',
    );
    expect(plainMarkdown).toContain('`pingPongBindGroups[*]`');
    expect(plainMarkdown).toContain('@0 writeView: storageTexture');
    expect(plainMarkdown).toContain('rgba16float');
    expect(plainMarkdown).toContain('write-only');

    const hints = createInlayHints(
      discovered,
      inspection,
      1,
      { start: { line: 0, character: 0 }, end: { line: 30, character: 0 } },
      new Set(),
      { ...defaultSurfaceOptions, inlayDetailLevel: 'detailed' },
    );
    expect(hints.find((hint) => hint.position.line === symbol.range.end.line)?.label)
      .toBe('✓ 4 fields · 6 resources');
  });

  it('keeps failure hints compact and avoids repeating the primary fix', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/failure.ts',
      `
        const shade = tgpu.fn([], d.f32)(impl);
        function rebuildResources() {
          return root.createTexture(textureProps);
        }
      `,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/failure.ts',
      1,
      discovered,
      {
        ok: false,
        targets: [{
          label: 'shade',
          kind: 'resolvable',
          ok: false,
          compilationMessages: [],
          diagnostics: [{
            code: 'missing-slot-binding',
            message: 'No value was bound for sceneData.',
            hint: 'Inspect the authored pipeline that binds this accessor.',
          }, {
            code: 'secondary-context',
            message: 'The standalone helper had no pipeline context.',
          }],
        }],
      },
    );

    const hints = createInlayHints(
      discovered,
      inspection,
      1,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      },
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]?.label).toBe('✗ inspect');
    expect(String(hints[0]?.label).length).toBeLessThanOrEqual(36);

    const hover = createHover(
      discovered.symbols.find((symbol) => symbol.name === 'shade')!,
      discovered,
      inspection,
      1,
    );
    const markdown = typeof hover.contents === 'object' &&
        !Array.isArray(hover.contents) &&
        'value' in hover.contents
      ? hover.contents.value
      : '';
    expect(markdown.split('No value was bound for sceneData.')).toHaveLength(2);
    expect(markdown.split('Inspect the authored pipeline')).toHaveLength(2);
    expect(markdown).toContain('`missing-slot-binding`');
    expect(markdown).toContain('The standalone helper had no pipeline context.');
  });

  it('renders structural not-standalone conditions as hints, never red errors', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/slots.ts',
      `
        const aspectCorrected = tgpu.fn([], d.f32)(impl);
      `,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/slots.ts',
      1,
      discovered,
      {
        ok: false,
        targets: [{
          label: 'aspectCorrected',
          kind: 'resolvable',
          ok: false,
          compilationMessages: [],
          diagnostics: [{
            code: 'slot-binding-required',
            message:
              "The selected target depends on 'resolutionAccess', but no value was bound for that slot.",
            hint: 'Bind the slot through a symbol target `with` entry.',
          }],
        }],
      },
    );

    const diagnostics = createDiagnostics(
      'file:///workspace/slots.ts',
      discovered,
      inspection,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe(DiagnosticSeverity.Hint);
    expect(diagnostics[0]?.code).toBe('target-not-standalone');
    expect(diagnostics[0]?.message).toContain('not inspectable standalone');

    const hints = createInlayHints(
      discovered,
      inspection,
      1,
      {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      },
    );
    expect(hints[0]?.label).toBe('◌ needs slot binding');
    expect(hints[0]?.tooltip).toContain('Not inspectable standalone');

    const hover = createHover(
      discovered.symbols.find((symbol) => symbol.name === 'aspectCorrected')!,
      discovered,
      inspection,
      1,
    );
    const markdown = typeof hover.contents === 'object' &&
        !Array.isArray(hover.contents) &&
        'value' in hover.contents
      ? hover.contents.value
      : '';
    expect(markdown).toContain('◌ Not inspectable standalone');
    expect(markdown).not.toContain('✗ Inspection failed');
  });

  it('maps statement-level resolution errors via the quoted snippet', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/boids.ts',
      `
        const runCompute = tgpu.computeFn({ workgroupSize: [1] })(() => {
          'use gpu';
          const oldBoid = MutableBoid.$;
          const newPos = someFn(oldBoid);
          MutableBoid.$.pos = newPos;
        });
      `,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/boids.ts',
      1,
      discovered,
      {
        ok: false,
        targets: [{
          label: 'runCompute',
          kind: 'compute-pipeline',
          ok: false,
          compilationMessages: [],
          error: {
            message:
              "Resolution of the following tree failed:\n- <root>\n- computePipeline:<unnamed>\n- computePipelineCore\n- computeFn:runCompute: 'MutableBoid.$.pos = newPos' is invalid, because references cannot be assigned.",
          },
        }],
      },
    );
    const diagnostics = createDiagnostics(
      'file:///workspace/boids.ts',
      discovered,
      inspection,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.range.start.line).toBe(5);
    expect(diagnostics[0]?.range.end.line).toBe(5);
  });

  it('offers verbosity switch actions for the other levels only', () => {
    const actions = createDetailLevelActions('standard');
    expect(actions.map((action) => action.command?.arguments?.[0])).toEqual([
      'wgsl',
      'compact',
      'deep',
    ]);
    for (const action of actions) {
      expect(action.command?.command).toBe('typegpuInspector.setHoverDetailLevel');
      expect(action.kind).toBe('source.typegpuInspector');
      expect(action.title).toContain('TypeGPU hover detail');
    }
  });

  it('offers an independent inlay-density switcher', () => {
    const actions = createInlayDetailLevelActions('compact');
    expect(actions.map((action) => action.command?.arguments?.[0])).toEqual([
      'summary',
      'detailed',
    ]);
    expect(actions.every((action) =>
      action.command?.command === 'typegpuInspector.setInlayDetailLevel'
    )).toBe(true);
  });

  it('presents exact runtime render pipeline state', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/render.ts',
      `
        const pipeline = root.createRenderPipeline({
          vertex,
          fragment,
          targets: { format: 'rgba16float' },
        }).with(sceneDataAccess, sceneDataUniform);
      `,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/render.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: 'pipeline',
          kind: 'render-pipeline',
          ok: true,
          compilationMessages: [],
          callIds: [1],
        }],
        calls: [{
          id: 1,
          name: 'device.createRenderPipeline',
          targetLabel: 'pipeline',
          descriptor: {
            primitive: {
              topology: 'triangle-strip',
              frontFace: 'cw',
              cullMode: 'back',
            },
            vertex: {
              buffers: [{
                arrayStride: 16,
                stepMode: 'vertex',
                attributes: [{
                  shaderLocation: 0,
                  format: 'float32x3',
                  offset: 0,
                }],
              }],
            },
            fragment: {
              targets: [{
                format: 'rgba16float',
                blend: {
                  color: {
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                  },
                },
              }],
            },
            depthStencil: {
              format: 'depth24plus',
              depthWriteEnabled: true,
              depthCompare: 'less',
            },
            multisample: { count: 4 },
          },
        }],
      },
    );

    const hover = createHover(discovered.symbols[0]!, discovered, inspection, 1);
    const markdown = typeof hover.contents === 'object' &&
        !Array.isArray(hover.contents) &&
        'value' in hover.contents
      ? hover.contents.value
      : '';
    expect(markdown).toContain(
      '| **Stages** | vertex `vertex` → fragment `fragment` |',
    );
    expect(markdown).toContain('| **Slot** | `sceneDataAccess` ← `sceneDataUniform` |');
    expect(markdown).toContain(
      '| **Primitive** | triangle-strip · cw · cull back · 4 samples |',
    );
    expect(markdown).toContain('| **Target 0** | rgba16float · write all · blend on |');
    expect(markdown).toContain(
      '| \u00a0\u00a0**color blend** | src src-alpha · dst one-minus-src-alpha · add |',
    );
    expect(markdown).toContain(
      '| **Depth** | depth24plus · write enabled · compare less |',
    );
    expect(markdown).toContain('| **Vertex slot 0** | stride 16 B · per-vertex |');
    expect(markdown).toContain(
      '| \u00a0\u00a0**@location(0)** | float32x3 · offset 0 B |',
    );
    expect(markdown).not.toContain('`triangle-strip`');
    expect(markdown).not.toContain('`rgba16float`');
    expect(markdown).not.toContain('`float32x3`');
    expect(markdown).not.toContain('**Render pipeline state**');
    expect(markdown).not.toContain('**Pipeline context**');
    expect(markdown.split('\n').some((line) => /^\s+- /.test(line))).toBe(false);
  });

  it('publishes one precisely mapped diagnostic with generated-WGSL navigation', async () => {
    const source =
      'export const badWgsl = tgpu.fn([], d.f32)`() { return definitely_missing_symbol; }`;';
    const discovered = discoverTypeGpuModule('/workspace/bad.ts', source);
    const targetId = discovered.targets[0]!.id;
    discovered.symbols.push({
      ...discovered.symbols[0]!,
      name: 'alsoAssociated',
      targetIds: [targetId],
    });
    const wgsl = 'fn badWgsl() -> f32 { return definitely_missing_symbol; }';
    const generatedOffset = wgsl.indexOf('definitely_missing_symbol');
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/bad.ts',
      1,
      discovered,
      {
        ok: false,
        targets: [{
          label: 'badWgsl',
          kind: 'resolvable',
          ok: false,
          compilationMessages: [{
            type: 'error',
            message: "unresolved value 'definitely_missing_symbol'",
            offset: generatedOffset,
            length: 'definitely_missing_symbol'.length,
            lineNum: 1,
            linePos: generatedOffset + 1,
          }],
          callIds: [1],
          wgsl,
        }],
      },
    );

    const diagnostics = createDiagnostics(
      'file:///workspace/bad.ts',
      discovered,
      inspection,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.range).toEqual({
      start: { line: 0, character: source.indexOf('definitely_missing_symbol') },
      end: {
        line: 0,
        character: source.indexOf('definitely_missing_symbol') +
          'definitely_missing_symbol'.length,
      },
    });
    expect(diagnostics[0]!.relatedInformation?.[0]?.message).toContain(
      'fn badWgsl',
    );
    expect(diagnostics[0]!.data).toMatchObject({
      mapping: {
        confidence: 'high',
        strategy: 'generated-token',
        sourceSymbol: 'badWgsl',
      },
    });

    const actions = createCodeActions({ diagnostics });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      title: 'Open generated WGSL at compiler message',
      command: { command: 'typegpuInspector.openGeneratedWgsl' },
    });
  });

  it('surfaces the runtime resolution error over informational setup notes', async () => {
    const source = [
      'const rotateXY = (angle: number) => {',
      "  'use gpu';",
      '  const v = std.asin(d.vec2i());',
      '  return d.vec2f(std.cos(angle), std.sin(angle));',
      '};',
    ].join('\n');
    const discovered = discoverTypeGpuModule('/workspace/rotate.ts', source);
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/rotate.ts',
      1,
      discovered,
      {
        ok: false,
        targets: [{
          label: 'rotateXY',
          kind: 'resolvable',
          ok: false,
          diagnostics: [{
            code: 'inspection-defaults-applied',
            message: 'The editor inspector synthesized missing runtime inputs.',
            hint:
              'Called the selected helper from a zero-argument tgpu.fn with zero values for: d.f32.',
          }],
          error: {
            name: 'Error',
            message: [
              'Resolution of the following tree failed:',
              '- <root>',
              '- fn:<unnamed>',
              '- fn*:rotateXY(f32)',
              '- fn:asin: Unsupported data types: vec2i. Supported types are: f32, f16.',
            ].join('\n'),
          },
        }],
      },
    );

    const diagnostics = createDiagnostics(
      'file:///workspace/rotate.ts',
      discovered,
      inspection,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe(
      'rotateXY: asin: Unsupported data types: vec2i. Supported types are: f32, f16. (while resolving rotateXY(f32) → asin)',
    );
    const asinLine = 2;
    const asinCharacter = source.split('\n')[asinLine]!.indexOf('asin');
    expect(diagnostics[0]!.range).toEqual({
      start: { line: asinLine, character: asinCharacter },
      end: { line: asinLine, character: asinCharacter + 'asin'.length },
    });

    const unreachable = await materializeInspection(
      '/workspace',
      '/workspace/rotate.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: 'rotateXY',
          kind: 'resolvable',
          ok: true,
          wgsl: 'fn rotateXY(v: vec2f) -> vec2f {\n  return v;\n  let x = 1;\n}\n',
          compilationMessages: [
            { type: 'warning', message: 'code is unreachable', lineNum: 3, linePos: 3 },
          ],
        }],
      },
    );
    const warning = createDiagnostics('file:///workspace/rotate.ts', discovered, unreachable)[0]!;
    expect(warning.message).toBe('rotateXY: code is unreachable (generated WGSL line 3)');
    expect(warning.range).toEqual(discovered.symbols[0]!.range);

    const probed = await materializeInspection(
      '/workspace',
      '/workspace/rotate.ts',
      1,
      discovered,
      {
        ok: false,
        targets: [{
          label: 'rotateXY',
          kind: 'resolvable',
          ok: false,
          error: {
            name: 'Error',
            message: [
              'Resolution of the following tree failed:',
              '- <root>',
              '- fn:__typegpuMcpProbe14',
              '- fn:rotateXY: Unsupported data types: vec2i.',
            ].join('\n'),
          },
        }],
      },
    );
    expect(
      createDiagnostics('file:///workspace/rotate.ts', discovered, probed)[0]!.message,
    ).toBe('rotateXY: rotateXY: Unsupported data types: vec2i.');

    const unmapped = createDiagnostics(
      'file:///workspace/rotate.ts',
      discovered,
      inspection,
      { sourceMapping: false, schemaLayoutHealth: true, schemaPackingSuggestions: true, saveAffordance: true, presentation: 'zed', hoverDetailLevel: 'standard' },
    );
    expect(unmapped[0]!.message).toContain('Unsupported data types: vec2i');
    expect(unmapped[0]!.range).toEqual(discovered.symbols[0]!.range);
  });

  it('renders VS Code hovers with mono grids and separators', async () => {
    const source =
      'export const main = tgpu.computeFn({ workgroupSize: [1] })(() => {});';
    const discovered = discoverTypeGpuModule('/workspace/main.ts', source);
    const wgsl = [
      '@group(0) @binding(0) var<uniform> params: Params;',
      '@compute @workgroup_size(1) fn main() {}',
    ].join('\n');
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/main.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{ label: 'main', kind: 'compute-pipeline', ok: true, wgsl }],
      },
    );
    const symbol = discovered.symbols[0]!;

    const zedHover = createHover(symbol, discovered, inspection, 1);
    const zedText = (zedHover.contents as { value: string }).value;
    expect(zedText).toContain('| Binding | Type | Stages |');
    expect(zedText).not.toContain('```text');
    expect(zedText).not.toContain('\n---\n');

    const vscodeHover = createHover(
      symbol,
      discovered,
      inspection,
      1,
      new Set(),
      { ...defaultSurfaceOptions, presentation: 'vscode' },
    );
    const value = (vscodeHover.contents as { value: string }).value;
    expect(value).not.toContain('| --- |');
    expect(value).toContain('```text');
    const grid = value.slice(value.indexOf('```text'));
    expect(grid).toMatch(/Binding\s{2,}Type\s{2,}Stages/);
    expect(grid).toContain('@0:0');
    expect(value).toContain('---');
    expect(value).not.toMatch(/```text\n\s*\n/);
    expect(value.indexOf('```text')).toBeGreaterThan(value.indexOf('```wgsl'));
  });

  it('centers the bounded standard WGSL preview on the relevant entrypoint', async () => {
    const source = 'const main = tgpu.computeFn({ workgroupSize: [1] })(() => {});';
    const discovered = discoverTypeGpuModule('/workspace/preview.ts', source);
    const wgsl = [
      'struct Unrelated0 { value: f32 }',
      'struct Unrelated1 { value: f32 }',
      'struct Unrelated2 { value: f32 }',
      'struct Unrelated3 { value: f32 }',
      'struct Unrelated4 { value: f32 }',
      'struct Unrelated5 { value: f32 }',
      'struct Unrelated6 { value: f32 }',
      'struct Unrelated7 { value: f32 }',
      '@compute @workgroup_size(1)',
      'fn main() {',
      '  let useful = 1u;',
      '}',
    ].join('\n');
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/preview.ts',
      1,
      discovered,
      { ok: true, targets: [{ label: 'main', kind: 'compute-pipeline', ok: true, wgsl }] },
    );
    const hover = createHover(discovered.symbols[0]!, discovered, inspection, 1);
    const value = (hover.contents as { value: string }).value;
    const preview = value.slice(value.indexOf('```wgsl'), value.indexOf('```', value.indexOf('```wgsl') + 7));
    expect(preview).toContain('@compute @workgroup_size(1)');
    expect(preview).toContain('fn main()');
    expect(preview).not.toContain('Unrelated0');
    expect(value).toContain('WGSL lines omitted');
  });

  it('keeps informational notes as the failure message when no error detail exists', async () => {
    const source =
      "const rotateXY = (angle: number) => { 'use gpu'; return angle; };";
    const discovered = discoverTypeGpuModule('/workspace/rotate.ts', source);
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/rotate.ts',
      1,
      discovered,
      {
        ok: false,
        targets: [{
          label: 'rotateXY',
          kind: 'resolvable',
          ok: false,
          diagnostics: [{
            code: 'inspection-defaults-applied',
            message: 'The editor inspector synthesized missing runtime inputs.',
            hint: 'Called the selected helper with zero values for: d.f32.',
          }],
        }],
      },
    );

    const diagnostics = createDiagnostics(
      'file:///workspace/rotate.ts',
      discovered,
      inspection,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain('synthesized missing runtime inputs');
  });

  it('publishes a whole-call compiler selection on the authored callee token', async () => {
    const source =
      'export const fragment = tgpu.fn([], d.vec4f)`() { return textureSample(tex, samp, uv); }`;';
    const discovered = discoverTypeGpuModule('/workspace/fragment.ts', source);
    const targetId = discovered.targets[0]!.id;
    const wgsl =
      'fn fragment() -> vec4f { return textureSample(tex, samp, uv); }';
    const selected = 'textureSample(tex, samp, uv)';
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/fragment.ts',
      1,
      discovered,
      {
        ok: false,
        targets: [{
          label: 'fragment',
          kind: 'resolvable',
          ok: false,
          compilationMessages: [{
            type: 'error',
            message: "'textureSample' must only be called from uniform control flow",
            offset: wgsl.indexOf(selected),
            length: selected.length,
          }],
          callIds: [1],
          wgsl,
        }],
      },
    );

    const diagnostics = createDiagnostics(
      'file:///workspace/fragment.ts',
      discovered,
      inspection,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      range: {
        start: { line: 0, character: source.indexOf('textureSample') },
        end: {
          line: 0,
          character: source.indexOf('textureSample') + 'textureSample'.length,
        },
      },
      data: {
        sourceUri: 'file:///workspace/fragment.ts',
        targetId,
        mapping: {
          confidence: 'high',
          strategy: 'generated-token',
          generatedToken: 'textureSample',
        },
      },
    });
  });
});

describe('surface options and unreported tracking', () => {
  const source = `
    const first = tgpu.computeFn({ workgroupSize: [1] })(() => {});
    const second = tgpu.computeFn({ workgroupSize: [1] })(() => {});
  `;

  it('records requested targets that came back without a report', async () => {
    const discovered = discoverTypeGpuModule('/workspace/shaders.ts', source);
    const firstTarget = discovered.targets.find((target) => target.label === 'first')!;
    const secondTarget = discovered.targets.find((target) => target.label === 'second')!;
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/shaders.ts',
      1,
      discovered,
      { ok: true, targets: [{ label: 'first', kind: 'compute-pipeline', ok: true }] },
      [firstTarget.id, secondTarget.id],
    );
    expect(inspection.unreported?.has(secondTarget.id)).toBe(true);
    expect(inspection.unreported?.has(firstTarget.id)).toBeFalsy();

    const followUp = await materializeInspection(
      '/workspace',
      '/workspace/shaders.ts',
      1,
      discovered,
      { ok: true, targets: [{ label: 'second', kind: 'compute-pipeline', ok: true }] },
      [secondTarget.id],
    );
    const merged = mergeDocumentInspections(inspection, followUp, [secondTarget.id]);
    expect(merged.unreported?.has(secondTarget.id) ?? false).toBe(false);
  });

  it('suppresses the save inlay affordance when disabled', async () => {
    const discovered = discoverTypeGpuModule('/workspace/shaders.ts', source);
    const fullRange = {
      start: { line: 0, character: 0 },
      end: { line: 10, character: 0 },
    };
    const withAffordance = createInlayHints(discovered, undefined, 1, fullRange);
    expect(withAffordance.some((hint) => hint.label === '◌ save')).toBe(true);
    const withoutAffordance = createInlayHints(
      discovered,
      undefined,
      1,
      fullRange,
      new Set(),
      { sourceMapping: true, schemaLayoutHealth: true, schemaPackingSuggestions: true, saveAffordance: false, presentation: 'zed', hoverDetailLevel: 'standard' },
    );
    expect(withoutAffordance).toHaveLength(0);
  });

  it('falls back to the declaration range when source mapping is disabled', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/shaders.ts',
      `const main = tgpu.computeFn({ workgroupSize: [1] })(() => {});`,
    );
    const target = discovered.targets[0]!;
    const wgsl = '@compute fn main() {\n  let x = missing;\n}\n';
    const output = {
      ok: false,
      targets: [{
        label: target.label,
        kind: 'compute-pipeline',
        ok: false,
        wgsl,
        compilationMessages: [{
          type: 'error',
          message: 'unresolved identifier',
          lineNum: 2,
          linePos: 11,
          offset: 31,
          length: 7,
        }],
      }],
    };
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/shaders.ts',
      1,
      discovered,
      output,
    );
    const mapped = createDiagnostics('file:///workspace/shaders.ts', discovered, inspection);
    const unmapped = createDiagnostics(
      'file:///workspace/shaders.ts',
      discovered,
      inspection,
      { sourceMapping: false, schemaLayoutHealth: true, schemaPackingSuggestions: true, saveAffordance: true, presentation: 'zed', hoverDetailLevel: 'standard' },
    );
    expect(mapped.length).toBeGreaterThan(0);
    expect(unmapped.length).toBe(mapped.length);
    const symbol = discovered.symbols[0]!;
    for (const diagnostic of unmapped) {
      expect(diagnostic.range).toEqual(symbol.range);
    }
  });
});

describe('hover datasheet discipline', () => {
  const bufferSource = `const counters = root.createBuffer(Counters).$usage('uniform');`;
  const textureSource = `const albedo = root.createTexture(props).$usage('sampled', 'render');`;

  async function inspectResource(
    fileName: string,
    source: string,
    resource: Record<string, unknown>,
  ) {
    const discovered = discoverTypeGpuModule(`/workspace/${fileName}`, source);
    const inspection = await materializeInspection(
      '/workspace',
      `/workspace/${fileName}`,
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: discovered.targets[0]!.label,
          kind: 'resource',
          ok: true,
          resource: resource as never,
        }],
      },
    );
    return { discovered, inspection };
  }

  function hoverAt(
    discovered: Parameters<typeof createHover>[0] extends never ? never : any,
    inspection: any,
    level: 'wgsl' | 'compact' | 'standard' | 'deep',
    presentation?: Record<string, unknown>,
  ): string {
    const hover = createHover(
      discovered.symbols[0]!,
      discovered,
      inspection,
      1,
      new Set(),
      {
        ...defaultSurfaceOptions,
        hoverDetailLevel: level,
        ...(presentation ? { hoverPresentation: presentation as never } : {}),
      },
    );
    return (hover.contents as { value: string }).value;
  }

  it('wgsl level shows only the generated WGSL for a shader target', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/render.ts',
      'const pipeline = root.createRenderPipeline({ vertex, fragment });',
    );
    const wgsl = [
      '@vertex fn vertex() -> @builtin(position) vec4f { return vec4f(); }',
      '@fragment fn fragment() -> @location(0) vec4f { return vec4f(1); }',
    ].join('\n');
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/render.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: 'pipeline',
          kind: 'render-pipeline',
          ok: true,
          compilationMessages: [],
          callIds: [1],
          wgsl,
        }],
        calls: [{
          id: 1,
          name: 'device.createRenderPipeline',
          targetLabel: 'pipeline',
          descriptor: {
            primitive: { topology: 'triangle-list' },
            fragment: { targets: [{ format: 'bgra8unorm' }] },
          },
        }],
      },
    );

    const only = hoverAt(discovered, inspection, 'wgsl');
    expect(only).toContain('```wgsl');
    expect(only).toContain('@fragment fn fragment()');
    expect(only).not.toContain('| --- |');
    expect(only).not.toContain('**Bindings**');
    expect(only).not.toContain('**Stages**');

    const standard = hoverAt(discovered, inspection, 'standard');
    expect(standard.indexOf('```wgsl')).toBeLessThan(standard.indexOf('| **Stages** |'));
  });

  it('decodes buffer usage bits into the resource line and hides the raw mask', async () => {
    const { discovered, inspection } = await inspectResource(
      'buffers.ts',
      bufferSource,
      {
        resourceType: 'buffer',
        sizeBytes: 48,
        usages: ['uniform'],
        properties: { flags: 76, destroyed: false, initialized: false },
      },
    );

    const standard = hoverAt(discovered, inspection, 'standard');
    expect(standard).toContain('| **Kind** | buffer |');
    expect(standard).toContain('| **Usage** | uniform · copy-src · copy-dst |');
    expect(standard).toContain('| **Size** | 48 B |');
    expect(standard).not.toContain('`uniform`');
    expect(standard).not.toContain('flags');
    expect(standard).not.toContain('76');
    // A bare negative boolean is not a fact a shader author reads.
    expect(standard).not.toContain('destroyed');
    expect(standard).not.toContain('initialized');
    expect(standard).not.toContain('**Properties**');

    expect(hoverAt(discovered, inspection, 'compact')).not.toContain('flags');

    const deep = hoverAt(discovered, inspection, 'deep');
    expect(deep).toContain(
      '| **Usage flags** | 0x4c · uniform · copy-src · copy-dst |',
    );
    expect(deep).not.toContain('destroyed');

    const wgslOnly = hoverAt(discovered, inspection, 'wgsl');
    expect(wgslOnly).toContain('| **Kind** | buffer |');
    expect(wgslOnly).not.toContain('```wgsl');
  });

  it('decodes texture usage bits without repeating the TypeGPU usage names', async () => {
    const { discovered, inspection } = await inspectResource(
      'textures.ts',
      textureSource,
      {
        resourceType: 'texture',
        usages: ['sampled', 'render'],
        properties: {
          size: [512, 512],
          format: 'rgba8unorm',
          dimension: '2d',
          mipLevelCount: 1,
          sampleCount: 1,
          viewFormats: [],
          destroyed: false,
          flags: 22,
        },
      },
    );

    const standard = hoverAt(discovered, inspection, 'standard');
    // 22 = TEXTURE_BINDING | RENDER_ATTACHMENT | COPY_DST.
    expect(standard).toContain('| **Kind** | texture |');
    expect(standard).toContain('| **Usage** | sampled · render · copy-dst |');
    expect(standard).not.toContain('texture-binding');
    expect(standard).not.toContain('render-attachment');
    expect(standard).toContain('| **Size** | 512 × 512 |');
    expect(standard).toContain('| **Format** | rgba8unorm |');
    expect(standard).toContain('| **Mips** | 1 |');
    expect(standard).toContain('| **Samples** | 1 |');
    // Empty and negative values state nothing.
    expect(standard).not.toContain('viewFormats');
    expect(standard).not.toContain('destroyed');

    expect(hoverAt(discovered, inspection, 'deep')).toContain(
      '| **Usage flags** | 0x16 · texture-binding · render-attachment · copy-dst |',
    );
  });

  it('condenses the assumption ledger to one line at standard and keeps it full at deep', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/pipeline.ts',
      `const pipeline = root.createRenderPipeline({ vertex, fragment });`,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/pipeline.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: discovered.targets[0]!.label,
          kind: 'render-pipeline',
          ok: true,
          wgsl: '@vertex fn main() -> @builtin(position) vec4f { return vec4f(); }',
          diagnostics: [{
            code: 'inspection-defaults-applied',
            severity: 'note',
            message: 'The editor inspector synthesized missing runtime inputs.',
            hint: 'Synthesized vertex attributes. Synthesized fragment targets.',
          }],
          ledger: [
            {
              tier: 'target',
              kind: 'vertex-attribs',
              key: 'vertex-attribs:pipeline',
              status: 'satisfied',
              provider: 'synthesis',
              provenance: 'Synthesized vertex attributes from the vertex layout.',
            },
            {
              tier: 'target',
              kind: 'fragment-targets',
              key: 'fragment-targets:pipeline',
              status: 'satisfied',
              provider: 'synthesis',
              provenance: 'Synthesized one bgra8unorm color target.',
            },
            {
              tier: 'environment',
              kind: 'device-session',
              key: 'device-session:quiescent-run',
              status: 'satisfied',
              provider: 'synthesis',
              provenance: 'Quiescent run: no application frame was executed.',
            },
          ],
        }],
      },
    );

    const compact = hoverAt(discovered, inspection, 'compact');
    expect(compact).toContain('**✓ WGSL validated**');
    expect(compact).not.toContain('Inspection assumptions');
    expect(compact).not.toContain('Inspection notes');
    expect(compact).not.toContain('Inspected with');

    const standard = hoverAt(discovered, inspection, 'standard');
    expect(standard).toContain(
      '_Inspected with 2 synthesized inputs (vertex attribs, targets)' +
        ' — see deep hover or the full report._',
    );
    expect(standard).not.toContain('Inspection assumptions');
    expect(standard).not.toContain('Inspection notes');
    // The editor's own quiescent default is never one of the user's assumptions.
    expect(standard).not.toContain('Quiescent');
    expect(standard).not.toContain('device-session');

    const deep = hoverAt(discovered, inspection, 'deep');
    expect(deep).toContain('**Inspection assumptions**');
    expect(deep).toContain('`vertex-attribs`');
    expect(deep).toContain('`fragment-targets`');
    expect(deep).toContain('**Inspection notes**');
    expect(deep).not.toContain('Inspected with 2 synthesized inputs');
    // Disclosed once, as a runtime fact about how the pass ran.
    expect(deep).toContain(
      'Quiescent run:\u200b no application frame was executed.',
    );
    expect(deep).not.toContain('`device-session`');

    const forced = hoverAt(discovered, inspection, 'standard', {
      sections: { assumptions: 'show' },
      sectionOrder: [],
    });
    expect(forced).toContain('**Inspection assumptions**');
    expect(forced).toContain('`vertex-attribs`');
    expect(forced).toContain('`fragment-targets`');
    expect(forced).not.toContain('Inspected with 2 synthesized inputs');

    // Assumptions never leak into inlays at any density.
    for (const inlayDetailLevel of ['compact', 'summary', 'detailed'] as const) {
      const hints = createInlayHints(
        discovered,
        inspection,
        1,
        { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
        new Set(),
        { ...defaultSurfaceOptions, inlayDetailLevel },
      );
      expect(hints[0]?.label).not.toContain('assumption');
      expect(hints[0]?.label).not.toContain('synthesi');
      expect(hints[0]?.tooltip).not.toContain('assumption');
      if (inlayDetailLevel === 'compact') expect(hints[0]?.label).toBe('✓');
    }
  });

  it('reports unmet ledger requirements in the same single standard line', async () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/slots.ts',
      `const shaded = tgpu.fn([])(() => { 'use gpu'; });`,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/slots.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: discovered.targets[0]!.label,
          kind: 'resolvable',
          ok: true,
          wgsl: 'fn shaded() {}',
          ledger: [
            {
              tier: 'resource',
              kind: 'slot-value',
              key: 'slot-value:tint',
              status: 'satisfied',
              provider: 'module-scope',
              provenance: 'Bound from module scope.',
            },
            {
              tier: 'resource',
              kind: 'argument-values',
              key: 'argument-values:shaded',
              status: 'unsatisfied',
            },
          ],
        }],
      },
    );

    expect(hoverAt(discovered, inspection, 'standard')).toContain(
      '_Inspected with 1 synthesized input (slot values) and 1 unmet requirement' +
        ' (arguments) — see deep hover or the full report._',
    );
  });
});

describe('hover width budget and code spans', () => {
  const wgsl = [
    '@group(0) @binding(0) var<storage, read_write> instanceTransforms: array<mat4x4f>;',
    '',
    '@vertex fn mainVertex() -> @builtin(position) vec4f { return vec4f(); }',
    '@fragment fn mainFragment() -> @location(0) vec4f { return vec4f(); }',
  ].join('\n');

  async function renderPipeline() {
    const discovered = discoverTypeGpuModule(
      '/workspace/render.ts',
      `const pipeline = root.createRenderPipeline({ vertex, fragment });`,
    );
    const inspection = await materializeInspection(
      '/workspace',
      '/workspace/render.ts',
      1,
      discovered,
      {
        ok: true,
        targets: [{
          label: 'pipeline',
          kind: 'render-pipeline',
          ok: true,
          callIds: [1],
          wgsl,
          bindGroupLayouts: [{
            group: 0,
            label: 'sceneLayout',
            entries: [{
              binding: 0,
              name: 'instanceTransforms',
              visibility: ['vertex', 'fragment'],
              resource: { buffer: { type: 'storage', minBindingSize: 256 } },
            }],
          }],
        }],
        calls: [{
          id: 1,
          name: 'device.createRenderPipeline',
          targetLabel: 'pipeline',
          descriptor: {
            primitive: { topology: 'triangle-list' },
            vertex: {
              buffers: [{
                arrayStride: 24,
                attributes: [
                  { shaderLocation: 0, format: 'float32x4', offset: 0 },
                  { shaderLocation: 1, format: 'float32x2', offset: 16 },
                ],
              }],
            },
            fragment: { targets: [{ format: 'bgra8unorm' }] },
          },
        }],
      },
    );
    return { discovered, inspection };
  }

  function hoverAt(
    discovered: Awaited<ReturnType<typeof renderPipeline>>['discovered'],
    inspection: Awaited<ReturnType<typeof renderPipeline>>['inspection'],
    maxColumns: number,
  ): string {
    const hover = createHover(
      discovered.symbols[0]!,
      discovered,
      inspection,
      1,
      new Set(),
      {
        ...defaultSurfaceOptions,
        hoverPresentation: { sections: {}, sectionOrder: [], maxColumns },
      },
    );
    return (hover.contents as { value: string }).value;
  }

  it('defaults to a narrower budget for Zed than for other clients', () => {
    expect(defaultMaxColumnsForClient('Zed')).toBe(72);
    expect(defaultMaxColumnsForClient('zed-industries')).toBe(72);
    expect(defaultMaxColumnsForClient('Visual Studio Code')).toBe(96);
    expect(defaultMaxColumnsForClient(undefined)).toBe(96);
  });

  it('falls back from tables to key/value lines below the width budget', async () => {
    const { discovered, inspection } = await renderPipeline();

    const wide = hoverAt(discovered, inspection, 96);
    expect(wide).toContain('| Binding | Type | Stages |');
    expect(wide).toContain('| **Primitive** |');

    const narrow = hoverAt(discovered, inspection, 40);
    expect(narrow).not.toContain('| Binding | Type | Stages |');
    expect(narrow).not.toContain('| **Primitive** |');
    expect(narrow).toContain('**Primitive:** triangle-list · ccw · cull none · 1 sample');
    expect(narrow).toContain('`instanceTransforms`:** storage read\\_write');
    expect(narrow).toContain('@location(0)');
    expect(narrow).toContain('@location(1)');
    expect(narrow).toContain('bgra8unorm');

    for (const line of wide.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.replace(/^\|\s*/, '').replace(/\s*\|$/, '')
        .split(/(?<!\\)\|/);
      expect(tableRowWidth(cells)).toBeLessThanOrEqual(96);
    }
  });

  it('code-spans identifiers and prints vocabulary values plainly', async () => {
    const { discovered, inspection } = await renderPipeline();
    const markdown = hoverAt(discovered, inspection, 96);

    expect(markdown).toContain('`mainVertex`');
    expect(markdown).toContain('`instanceTransforms`');
    for (const vocabulary of [
      'triangle-list', 'ccw', 'none', 'bgra8unorm', 'float32x4', '@location(0)',
    ]) {
      expect(markdown).toContain(vocabulary);
      expect(markdown).not.toContain(`\`${vocabulary}\``);
    }
  });

  it('states the stages once and puts the declaration count on the WGSL link', async () => {
    const { discovered, inspection } = await renderPipeline();
    const markdown = hoverAt(discovered, inspection, 96);

    expect(markdown).toContain(
      '| **Stages** | vertex `mainVertex` → fragment `mainFragment` |',
    );
    expect(markdown.match(/vertex `mainVertex`/g)).toHaveLength(1);
    expect(markdown).not.toContain('**Entrypoints:**');
    expect(markdown).toMatch(/Open generated WGSL\]\([^)]+\) · 4 lines · \d+ B · 3 declarations/);
    expect(markdown).not.toContain('**Declarations (3)**');

    const deep = createHover(
      discovered.symbols[0]!,
      discovered,
      inspection,
      1,
      new Set(),
      { ...defaultSurfaceOptions, hoverDetailLevel: 'deep' },
    );
    const deepMarkdown = (deep.contents as { value: string }).value;
    expect(deepMarkdown).toContain('**Declarations (3)**');
    expect(deepMarkdown).not.toContain('· 3 declarations');
  });

  it('keeps settings written against the old section ids working', async () => {
    const { discovered, inspection } = await renderPipeline();
    const hidden = createHover(
      discovered.symbols[0]!,
      discovered,
      inspection,
      1,
      new Set(),
      {
        ...defaultSurfaceOptions,
        hoverPresentation: {
          sections: { pipelineState: 'hide' },
          sectionOrder: ['bindings', 'schema'],
        },
      },
    );
    const markdown = (hidden.contents as { value: string }).value;
    expect(markdown).not.toContain('| **Primitive** |');
    expect(markdown).toContain('**Bindings**');
    expect(markdown.indexOf('**Bindings**'))
      .toBeLessThan(markdown.indexOf('**Generated WGSL**'));
  });
});
