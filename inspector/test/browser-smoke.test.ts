import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { inspectTypegpuTool } from '../src/agentTools.ts';
import { inspectTypegpuModule, inspectTypegpuSymbols } from '../src/inspect.ts';
import { closeSharedBrowser } from '../src/inspect/browser.ts';
import {
  closeAllInspectorSessions,
  getInspectorSessionCount,
} from '../src/inspect/session.ts';
import { discoverTypeGpuModule } from '../../server/src/discovery.ts';

const maybeIt = process.env.TYPEGPU_MCP_RUN_BROWSER_TESTS === '1' ? it : it.skip;
const cwd = resolve(import.meta.dirname, '..');
const basicSslModuleUrl = pathToFileURL(
  createRequire(import.meta.url).resolve('@vitejs/plugin-basic-ssl'),
).href;

afterAll(async () => {
  await closeAllInspectorSessions();
  await closeSharedBrowser();
});

describe('browser harness', () => {
  maybeIt.each([false, true])(
    'accepts a self-signed HTTPS Vite harness (reuseBrowser=%s)',
    async (reuseBrowser) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-https-harness-'));
      const modulePath = join(tempDir, 'https-probe.ts');
      const viteConfigPath = join(tempDir, 'vite.config.mjs');

      try {
        await writeFile(
          modulePath,
          `
            export async function inspect({ tgpu, d }) {
              const helper = tgpu.fn([], d.f32)(() => {
                'use gpu';
                return d.f32(6);
              });
              return { label: 'https-probe', kind: 'resolvable', value: helper };
            }
          `,
          'utf8',
        );
        await writeFile(
          viteConfigPath,
          `
            import basicSsl from ${JSON.stringify(basicSslModuleUrl)};
            export default { plugins: [basicSsl()] };
          `,
          'utf8',
        );

        const report = await inspectTypegpuModule({
          cwd,
          source: { kind: 'modulePath', modulePath },
          viteConfigPath,
          reuseBrowser,
          timeoutMs: 30_000,
        });

        expect(report.ok, JSON.stringify(report.causes, null, 2)).toBe(true);
        expect(report.targets[0]?.label).toBe('https-probe');
        expect(report.targets[0]?.wgsl).toContain('6');
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
  );

  maybeIt('resolves finite generic helper specializations into branch-pruned WGSL', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-polymorphic-helper-'));
    const modulePath = join(tempDir, 'evolve.ts');
    const source = `
      import { d } from 'typegpu';

      const evolveVec = <T extends d.v2f | d.v4f>(a: T, b: T): T => {
        'use gpu';
        if (a.kind === 'vec2f') {
          return ((a as d.v2f) + (b as d.v2f)) as T;
        }
        return ((a as d.v4f) + (b as d.v4f)) as T;
      };
    `;

    try {
      await writeFile(modulePath, source, 'utf8');
      const discovered = discoverTypeGpuModule(modulePath, source);
      const report = await inspectTypegpuSymbols({
        cwd,
        modulePath,
        targets: discovered.targets.map((target) => target.selector),
        includePrivate: true,
        timeoutMs: 30_000,
      });

      expect(report.targets).toHaveLength(2);
      expect(report.targets.every((target) => target.ok)).toBe(true);
      expect(report.targets[0]?.wgsl).toContain(
        'fn evolveVec(a: vec2f, b: vec2f) -> vec2f',
      );
      expect(report.targets[0]?.wgsl).not.toContain('vec4f');
      expect(report.targets[1]?.wgsl).toContain(
        'fn evolveVec(a: vec4f, b: vec4f) -> vec4f',
      );
      expect(report.targets[1]?.wgsl).not.toContain('vec2f');
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  maybeIt('bin entrypoint inherits the MCP client cwd for relative module paths', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-mcp-bin-cwd-'));
    const client = new Client({ name: 'typegpu-mcp-test', version: '1.0.0' });
    try {
      await writeFile(
        join(tempDir, 'probe.ts'),
        `
          export async function inspect({ root, tgpu }) {
            const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
              'use gpu';
            });

            return {
              label: 'relative cwd probe',
              kind: 'compute-pipeline',
              value: main,
            };
          }
        `,
        'utf8',
      );

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [resolve(cwd, 'bin/typegpu-runtime-inspector-mcp.mjs')],
        cwd: tempDir,
        stderr: 'pipe',
      });
      await client.connect(transport);
      const result = await client.callTool({
        name: 'inspect_typegpu',
        arguments: {
          target: { kind: 'module', path: 'probe.ts' },
          output: { diagnosticsOnly: true, timeoutMs: 30_000 },
        },
      });

      if (!('structuredContent' in result)) {
        throw new Error('Expected structuredContent in MCP tool result.');
      }
      const structuredContent = result.structuredContent as { ok?: unknown } | undefined;
      const content = result.content as Array<{ type: string; text?: string }> | undefined;
      const text = content?.[0]?.type === 'text' ? content[0].text : '{}';
      expect(structuredContent?.ok, JSON.stringify(structuredContent, null, 2)).toBe(true);
      expect(text).toContain('ok: true');
      expect(() => JSON.parse(text ?? '{}')).toThrow();
    } finally {
      await client.close().catch(() => undefined);
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  maybeIt('validates a simple compute pipeline in a real browser WebGPU runtime', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: { kind: 'modulePath', modulePath: 'test/fixtures/success-compute.ts' },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.wgsl).toContain('@compute');
    expect(report.targets[0]?.compilationSummary.errorCount).toBe(0);
    expect(report.stats.shaderModuleCount).toBeGreaterThan(0);
    expect(report.stats.timings?.totalMs).toBeGreaterThan(0);
    expect(report.stats.timings?.browserInspectionMs).toBeGreaterThan(0);
  });

  maybeIt('reuses one runtime session without reusing a stale inline module', async () => {
    const inlineSourcePath = resolve(cwd, 'test/fixtures/reused-session-probe.ts');
    const inspectRevision = (revision: 'one' | 'two') =>
      inspectTypegpuModule({
        cwd,
        source: {
          kind: 'inlineCode',
          inlineSourcePath,
          inlineCode: `
            export async function inspect({ tgpu, d }) {
              const helper = tgpu.fn([], d.f32)(() => {
                'use gpu';
                return d.f32(${revision === 'one' ? 1 : 2});
              });
              return {
                label: 'revision-${revision}',
                kind: 'resolvable',
                value: helper,
              };
            }
          `,
        },
        reuseBrowser: true,
        timeoutMs: 30_000,
      });

    const first = await inspectRevision('one');
    const second = await inspectRevision('two');

    expect(first.ok).toBe(true);
    expect(first.targets[0]?.label).toBe('revision-one');
    expect(first.stats.timings?.sessionReused).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.targets[0]?.label).toBe('revision-two');
    expect(second.targets[0]?.wgsl).not.toBe(first.targets[0]?.wgsl);
    expect(second.stats.timings?.sessionReused).toBe(true);
    expect(second.stats.timings?.startViteMs).toBe(0);
    expect(second.stats.timings?.acquireBrowserMs).toBe(0);
  });

  maybeIt('refreshes changed dependencies inside a reused runtime session', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-session-dependency-'));
    const helperPath = join(tempDir, 'helper.ts');
    const probePath = join(tempDir, 'probe.ts');
    const helperSource = (value: number) => `
      import { tgpu, d } from 'typegpu';
      export const helper = tgpu.fn([], d.f32)(() => {
        'use gpu';
        return d.f32(${value});
      });
    `;
    const probe = `
      import { helper } from './helper.ts';
      export async function inspect() {
        return { label: 'dependency-helper', kind: 'resolvable', value: helper };
      }
    `;

    try {
      await writeFile(helperPath, helperSource(1), 'utf8');
      const inspect = () =>
        inspectTypegpuModule({
          cwd: tempDir,
          source: {
            kind: 'inlineCode',
            inlineSourcePath: probePath,
            inlineCode: probe,
          },
          reuseBrowser: true,
          timeoutMs: 30_000,
        });

      const first = await inspect();
      await writeFile(helperPath, helperSource(2), 'utf8');
      const second = await inspect();

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.stats.timings?.sessionReused).toBe(true);
      expect(second.targets[0]?.wgsl).not.toBe(first.targets[0]?.wgsl);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  maybeIt('serializes concurrent probes without mixing their mutable modules', async () => {
    const inspect = (name: string, value: number) =>
      inspectTypegpuModule({
        cwd,
        source: {
          kind: 'inlineCode',
          inlineSourcePath: resolve(cwd, `test/fixtures/session-${name}.ts`),
          inlineCode: `
            export async function inspect({ tgpu, d }) {
              const helper = tgpu.fn([], d.f32)(() => {
                'use gpu';
                return d.f32(${value});
              });
              return { label: '${name}', kind: 'resolvable', value: helper };
            }
          `,
        },
        reuseBrowser: true,
        timeoutMs: 30_000,
      });

    const [first, second] = await Promise.all([
      inspect('concurrent-one', 11),
      inspect('concurrent-two', 22),
    ]);

    expect(first.ok).toBe(true);
    expect(first.targets[0]?.label).toBe('concurrent-one');
    expect(first.targets[0]?.wgsl).toContain('11');
    expect(second.ok).toBe(true);
    expect(second.targets[0]?.label).toBe('concurrent-two');
    expect(second.targets[0]?.wgsl).toContain('22');
  });

  maybeIt('recreates a reusable session after its shared browser disconnects', async () => {
    const input = {
      cwd,
      source: {
        kind: 'inlineCode' as const,
        inlineSourcePath: resolve(cwd, 'test/fixtures/session-recovery.ts'),
        inlineCode: `
          export async function inspect({ tgpu, d }) {
            const helper = tgpu.fn([], d.f32)(() => {
              'use gpu';
              return d.f32(7);
            });
            return { label: 'session-recovery', kind: 'resolvable', value: helper };
          }
        `,
      },
      reuseBrowser: true,
      timeoutMs: 30_000,
    };

    const first = await inspectTypegpuModule(input);
    await closeSharedBrowser();
    const recovered = await inspectTypegpuModule(input);

    expect(first.ok).toBe(true);
    expect(recovered.ok).toBe(true);
    expect(recovered.targets[0]?.label).toBe('session-recovery');
    expect(recovered.stats.timings?.sessionReused).toBe(false);
  });

  maybeIt('bounds reusable runtime sessions with an LRU', async () => {
    const roots: string[] = [];
    try {
      for (let index = 0; index < 4; index++) {
        const extraRoot = await mkdtemp(join(tmpdir(), `typegpu-session-${index}-`));
        roots.push(extraRoot);
        const report = await inspectTypegpuModule({
          cwd,
          source: {
            kind: 'inlineCode',
            inlineSourcePath: resolve(
              cwd,
              `test/fixtures/session-lru-${index}.ts`,
            ),
            inlineCode: `
              export async function inspect({ tgpu, d }) {
                const helper = tgpu.fn([], d.f32)(() => {
                  'use gpu';
                  return d.f32(${index});
                });
                return { label: 'lru-${index}', kind: 'resolvable', value: helper };
              }
            `,
          },
          fsAllow: [extraRoot],
          reuseBrowser: true,
          timeoutMs: 30_000,
        });
        expect(report.ok).toBe(true);
      }

      expect(getInspectorSessionCount()).toBeLessThanOrEqual(3);
    } finally {
      await Promise.all(roots.map((root) =>
        rm(root, { force: true, recursive: true })));
    }
  });

  maybeIt('validates inline code and exposes std in the inspection context', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inlineCode',
        inlineCode: `
          export async function inspect({ tgpu, d, std }) {
            const helper = tgpu.fn([], d.f32)(() => {
              'use gpu';
              return std.sin(1);
            });

            return {
              label: 'inline std fn',
              kind: 'resolvable',
              value: helper,
            };
          }
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('inline std fn');
    expect(report.calls.some((call) => call.targetLabel === 'inline std fn')).toBe(true);
  });

  maybeIt('wraps inspectBody for low-friction inline probes', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
            'use gpu';
          });

          return {
            label: 'body compute',
            kind: 'compute-pipeline',
            value: root.createComputePipeline({ compute: main }),
          };
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('body compute');
    expect(report.stats.computePipelineCount).toBe(1);
  });

  maybeIt('records statement maps for resolved shaders, root pipelines, and failed resolutions', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const helper = tgpu.fn([d.f32], d.f32)((x) => {
            'use gpu';
            let y = x * 2;
            if (y > 1) {
              y = y - 1;
            }
            return y;
          }).$name('helper');
          const broken = tgpu.fn([d.f32], d.f32)((x) => {
            'use gpu';
            const flag = x > 1;
            return flag + 1;
          }).$name('broken');
          const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
            'use gpu';
            const value = helper(1);
          }).$name('main');

          return [
            { label: 'helper', kind: 'resolvable', value: helper },
            { label: 'broken', kind: 'resolvable', value: broken },
            {
              label: 'pipeline',
              kind: 'compute-pipeline',
              value: root.createComputePipeline({ compute: main }),
            },
          ];
        `,
      },
      timeoutMs: 30_000,
    });

    const byLabel = new Map(report.targets.map((target) => [target.label, target]));
    const helper = byLabel.get('helper')!;
    expect(helper.ok, JSON.stringify(helper.error)).toBe(true);
    expect(helper.statementMap?.functions.map((fn) => fn.name)).toEqual(['helper']);
    const helperLines = helper.wgsl!.split('\n');
    const thenEntry = helper.statementMap!.functions[0]!.statements.find((statement) =>
      statement.path.join('.') === '1.then.0'
    )!;
    expect(helperLines[thenEntry.line]!.trim()).toBe('y = (y - 1f);');
    expect(helperLines[helper.statementMap!.functions[0]!.line]).toMatch(/^fn helper\(/);

    const broken = byLabel.get('broken')!;
    expect(broken.ok).toBe(false);
    expect(broken.statementMap?.failure).toEqual({ fn: 'broken', path: [1] });

    const pipeline = byLabel.get('pipeline')!;
    expect(pipeline.ok, JSON.stringify(pipeline.error)).toBe(true);
    expect(pipeline.statementMap?.functions.map((fn) => fn.name)).toEqual(['helper', 'main']);
    const pipelineLines = pipeline.wgsl!.split('\n');
    const mainEntry = pipeline.statementMap!.functions[1]!.statements[0]!;
    expect(pipelineLines[mainEntry.line]!.trim()).toBe('let value = helper(1f);');
  });

  maybeIt('validates an agent-first probe with inferred context', async () => {
    const result = await inspectTypegpuTool({
      target: {
        kind: 'probe',
        body: `
          const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
            'use gpu';
          });

          return {
            label: 'agent probe compute',
            kind: 'compute-pipeline',
            value: main,
          };
        `,
      },
      project: { root: cwd },
      output: { timeoutMs: 30_000 },
    });

    expect(result.isError, JSON.stringify(result.structuredContent, null, 2)).toBe(false);
    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.summary).toMatchObject({
      targetCount: 1,
      passedTargetCount: 1,
    });
    expect(result.structuredContent.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'agent probe compute', ok: true }),
      ]),
    );
    expect(JSON.stringify(result.structuredContent)).not.toContain(cwd);
    expect(JSON.stringify(result.structuredContent)).toContain('agent probe compute');
  });

  maybeIt('exposes common in inspectBody fullscreen render probes', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const fragment = tgpu.fragmentFn({
            in: { uv: d.vec2f },
            out: d.vec4f,
          })(({ uv }) => {
            'use gpu';
            return d.vec4f(uv, 0, 1);
          });

          return {
            label: 'common fullscreen render',
            kind: 'render-pipeline',
            create: () =>
              root.createRenderPipeline({
                vertex: common.fullScreenTriangle,
                fragment,
                targets: { format: 'bgra8unorm' },
              }),
          };
        `,
      },
      includeWgsl: true,
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.pipelineCreation?.callIds.length).toBeGreaterThan(0);
    expect(report.targets[0]?.diagnostics?.map((entry) => entry.code) ?? []).not.toContain(
      'pipeline-validated-without-recorded-creation',
    );
    expect(report.targets[0]?.wgsl).toContain('@vertex');
    expect(report.targets[0]?.wgsl).toContain('@fragment');
    expect(report.stats.renderPipelineCount).toBe(1);
  });

  maybeIt('infers the target kind from a created TypeGPU pipeline', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
            'use gpu';
          });

          return {
            label: 'kind inferred compute',
            create: () => root.createComputePipeline({ compute: main }),
          };
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.kind).toBe('compute-pipeline');
    expect(report.targets[0]?.pipelineCreation?.attempted).toBe(true);
  });

  maybeIt('accepts a compute entrypoint as a compute-pipeline module target', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
            'use gpu';
          });

          return {
            label: 'entrypoint compute',
            kind: 'compute-pipeline',
            value: main,
          };
        `,
      },
      includeWgsl: true,
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('entrypoint compute');
    expect(report.targets[0]?.pipelineCreation?.callIds.length).toBeGreaterThan(0);
    expect(report.targets[0]?.wgsl).toContain('@compute');
    expect(report.stats.computePipelineCount).toBe(1);
  });

  maybeIt('warns when a pre-unwrapped TypeGPU pipeline validates without target-owned calls', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const params = root.createUniform(d.f32);
          const main = tgpu.computeFn({ workgroupSize: [1] })(() => {
            'use gpu';
            if (params.$ > 0) return;
          });

          const pipeline = root.createComputePipeline({ compute: main });
          root.unwrap(pipeline);

          return {
            label: 'prebuilt compute',
            kind: 'compute-pipeline',
            value: pipeline,
          };
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.pipelineCreation?.callIds).toEqual([]);
    expect(report.targets[0]?.diagnostics?.[0]?.code).toBe(
      'pipeline-validated-without-recorded-creation',
    );
    expect(report.targets[0]?.diagnostics?.[0]?.message).toContain('Validated without a recorded createPipeline call');
    expect(report.targets[0]?.bindGroupLayouts).toEqual([
      expect.objectContaining({
        group: 0,
        source: 'resolution',
        entries: [expect.objectContaining({
          binding: 0,
          visibility: ['compute', 'vertex', 'fragment'],
          resource: { buffer: { type: 'uniform' } },
        })],
      }),
    ]);
  });

  maybeIt('returns a clear diagnostic for raw WebGPU compute pipelines', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const module = device.createShaderModule({
            code: '@compute @workgroup_size(1) fn main() {}',
          });
          const pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module },
          });

          return {
            label: 'raw compute',
            kind: 'compute-pipeline',
            value: pipeline,
          };
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(false);
    expect(report.targets[0]?.diagnostics?.[0]?.code).toBe(
      'raw-webgpu-pipeline-unsupported',
    );
    expect(report.targets[0]?.diagnostics?.[0]?.hint).toContain('.rawPipeline');
  });

  maybeIt('resolves relative imports for inline source with a virtual source path', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inlineCode',
        inlineSourcePath: 'test/fixtures/inline-source-main.ts',
        inlineCode: `
          import { relativeHelper } from './inline-relative-helper';

          export async function inspect() {
            return {
              label: 'inline relative helper',
              kind: 'resolvable',
              value: relativeHelper,
            };
          }
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('inline relative helper');
    expect(report.targets[0]?.wgsl).toContain('relativeHelper');
  });

  maybeIt('resolves TypeGPU core imports through a package-root alias', async () => {
    const cwd = resolve(import.meta.dirname, '..');
    const report = await inspectTypegpuModule({
      cwd,
      source: {
        kind: 'inlineCode',
        inlineSourcePath: 'test/fixtures/package-root-alias-probe.ts',
        inlineCode: `
          import { tgpu } from 'typegpu';
          import { vec4f } from 'typegpu/data';
          import { cos } from 'typegpu/std';
          import { fullScreenTriangle } from 'typegpu/common';

          const fragment = tgpu.fragmentFn({ out: vec4f })(() => {
            'use gpu';
            return vec4f(cos(0), 0, 0, 1);
          });

          export async function inspect({ root }) {
            return {
              label: 'package-root TypeGPU alias render',
              kind: 'render-pipeline',
              create: () => root.createRenderPipeline({
                vertex: fullScreenTriangle,
                fragment,
                targets: { format: 'bgra8unorm' },
              }),
            };
          }
        `,
      },
      dependencyResolution: {
        packageAliases: {
          typegpu: 'node_modules/typegpu',
        },
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('package-root TypeGPU alias render');
    expect(report.stats.renderPipelineCount).toBe(1);
  });

  maybeIt('summarizes and groups repeated browser console warnings', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inlineCode',
        inlineCode: `
          export async function inspect({ tgpu, d }) {
            for (let i = 0; i < 3; i++) {
              console.warn('implicit conversion from u32 to f32');
            }
            return {
              label: 'warning summary fn',
              kind: 'resolvable',
              value: tgpu.fn([], d.f32)(() => {
                'use gpu';
                return 1;
              }),
            };
          }
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.stats.consoleWarningCount).toBe(3);
    expect(report.console).toEqual([
      {
        type: 'warning',
        text: 'implicit conversion from u32 to f32',
        count: 3,
      },
    ]);
  });

  maybeIt('validates exported TypeGPU symbols without an inspection module', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      targets: [
        { label: 'helper', selector: 'exportedHelper', kind: 'resolvable' },
        { label: 'compute', kind: 'compute-pipeline', compute: 'exportedCompute' },
        {
          label: 'render',
          kind: 'render-pipeline',
          vertex: 'exportedVertex',
          fragment: 'exportedFragment',
          descriptor: { targets: { format: 'bgra8unorm' } },
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets.map((target) => target.label)).toEqual(['helper', 'compute', 'render']);
    expect(report.stats.computePipelineCount).toBe(1);
    expect(report.stats.renderPipelineCount).toBe(1);
  });

  maybeIt('synthesizes parameterized helper arguments and attributed render defaults', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      targets: [
        {
          label: 'parameterized helper',
          selector: 'parameterizedHelper',
          kind: 'resolvable',
          unwrap: false,
          probeArguments: ['ctx.d.vec4f'],
        },
        {
          label: 'attributed render',
          kind: 'render-pipeline',
          vertex: 'exportedAttributedVertex',
          fragment: 'exportedFragment',
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.wgsl).toContain('parameterizedHelper');
    expect(report.targets[0]?.diagnostics?.[0]?.code).toBe(
      'inspection-defaults-applied',
    );
    expect(report.targets[1]?.diagnostics?.[0]?.hint).toContain(
      'Vertex attributes were synthesized',
    );
    expect(report.targets[1]?.diagnostics?.[0]?.hint).toContain(
      'Fragment targets were synthesized',
    );
    expect(report.stats.renderPipelineCount).toBe(1);
  });

  maybeIt('uses an existing sampler in a synthesized helper probe', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/resource-targets.ts',
      targets: [
        {
          label: 'sampler helper',
          selector: 'samplerHelper',
          kind: 'resolvable',
          unwrap: false,
          probeArgumentPlan: [
            { schema: 'ctx.d.vec2f' },
            { value: 'linearSampler.$' },
          ],
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]?.wgsl).toContain('samplerHelper');
    expect(report.targets[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'inspection-defaults-applied',
          hint: expect.stringContaining('linearSampler.$'),
        }),
      ]),
    );
  });

  maybeIt('inspects a pipeline selected from an existing factory result', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/resource-targets.ts',
      targets: [
        {
          label: 'factory compute result',
          kind: 'compute-pipeline',
          selector: 'factoryPipelines.gpu-simple',
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]).toMatchObject({
      label: 'factory compute result',
      kind: 'compute-pipeline',
      ok: true,
      pipelineCreation: {
        attempted: true,
        ok: true,
      },
    });
    expect(report.targets[0]?.wgsl).toContain('factoryCompute');
    expect(report.stats.shaderModuleCount).toBe(1);
  });

  maybeIt('quiesces browser application work while preserving created pipelines', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/quiescent-import.ts',
      targets: [
        {
          label: 'quiescent application pipeline',
          kind: 'compute-pipeline',
          selector: 'applicationPipeline',
        },
      ],
      documentHtml: '<main></main>',
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.pageErrors).toEqual([]);
    expect(report.targets[0]?.wgsl).toContain('applicationCompute');
    expect(report.ledger?.map((entry) => entry.key)).toContain(
      'device-session:quiescent-run',
    );
  });

  maybeIt('lets an explicit browserSetup run after the quiescent prologue', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/quiescent-import.ts',
      targets: [
        {
          label: 'quiescent application pipeline',
          kind: 'compute-pipeline',
          selector: 'applicationPipeline',
        },
      ],
      documentHtml: '<main></main>',
      browserSetup: 'window.__TYPEGPU_MCP_QUIESCENT_PROBE = typeof requestAnimationFrame;',
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.pageErrors).toEqual([]);
  });

  maybeIt('inspects TypeGPU 0.12 root, guarded pipeline, encoder, and pass resources', async () => {
    const names = [
      'inspectedRoot',
      'guardedPipeline',
      'commandEncoder',
      'computePass',
      'renderPass',
      'renderBundleEncoder',
    ];
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/resource-targets.ts',
      targets: names.map((selector) => ({
        label: selector,
        selector,
        kind: 'resource' as const,
      })),
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    const byLabel = Object.fromEntries(
      report.targets.map((target) => [target.label, target.resource]),
    );

    expect(byLabel.inspectedRoot).toMatchObject({ resourceType: 'root' });
    expect(byLabel.inspectedRoot?.properties?.nameRegistry).toBe('strict');

    expect(byLabel.guardedPipeline).toMatchObject({
      resourceType: 'guarded-compute-pipeline',
      itemNames: ['pipeline', 'sizeUniform'],
    });
    expect(byLabel.guardedPipeline?.properties?.pipelineResourceType)
      .toBe('compute-pipeline');
    expect(byLabel.guardedPipeline?.items?.[1]?.schema?.type).toBe('vec3u');

    expect(byLabel.commandEncoder).toMatchObject({
      resourceType: 'command-encoder',
      properties: { label: 'resource encoder', adopted: false },
    });

    expect(byLabel.computePass).toMatchObject({
      resourceType: 'compute-pass',
      properties: { label: 'resource compute pass', hasOwningEncoder: true },
    });
    expect(byLabel.computePass?.properties).not.toHaveProperty('vertexBufferCount');

    expect(byLabel.renderPass).toMatchObject({
      resourceType: 'render-pass',
      properties: { label: 'resource render pass', vertexBufferCount: 0 },
    });

    expect(byLabel.renderBundleEncoder).toMatchObject({
      resourceType: 'render-bundle-encoder',
      properties: { label: 'resource bundle encoder' },
    });
  });

  maybeIt('inspects schemas, buffers, textures, views, samplers, layouts, variables, and bind groups', async () => {
    const names = [
      'ResourceSettings',
      'settingsUniform',
      'imageTexture',
      'sampledView',
      'linearSampler',
      'ioLayout',
      'flipBuffer',
      'ioBindGroups',
      'tileData',
      'vertexLayout',
      'resourceSlot',
      'resourceAccessor',
      'resourceBundle',
    ];
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/resource-targets.ts',
      targets: names.map((selector) => ({
        label: selector,
        selector,
        kind: 'resource' as const,
      })),
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets).toHaveLength(names.length);

    expect(report.targets[0]?.resource).toMatchObject({
      resourceType: 'schema',
      sizeBytes: 8,
      alignmentBytes: 4,
      schema: {
        type: 'struct',
        fields: [
          { name: 'filterDim', offsetBytes: 0 },
          { name: 'blockDim', offsetBytes: 4 },
        ],
      },
    });
    expect(report.targets[1]?.resource).toMatchObject({
      resourceType: 'uniform',
      sizeBytes: 8,
      usages: ['uniform'],
    });
    expect(report.targets[2]?.resource).toMatchObject({
      resourceType: 'texture',
      usages: ['sampled', 'render'],
      properties: {
        size: [64, 32],
        format: 'rgba8unorm',
        dimension: '2d',
      },
    });
    expect(report.targets[3]?.resource).toMatchObject({
      resourceType: 'texture-view',
      schema: { type: 'texture_2d' },
    });
    expect(report.targets[4]?.resource).toMatchObject({
      resourceType: 'sampler',
      properties: {
        comparison: false,
      },
    });
    expect(report.targets[5]?.resource?.bindings).toHaveLength(4);
    expect(report.targets[6]?.resource).toMatchObject({
      resourceType: 'buffer',
      sizeBytes: 4,
      usages: ['uniform'],
    });
    expect(report.targets[7]?.resource).toMatchObject({
      resourceType: 'collection',
      count: 1,
      items: [{ resourceType: 'bind-group' }],
    });
    expect(report.targets[8]?.resource?.resourceType).toBe('var');
    expect(report.targets[8]?.wgsl).toContain('var<workgroup>');
    expect(report.targets[9]?.resource).toMatchObject({
      resourceType: 'vertex-layout',
      properties: { strideBytes: 16, stepMode: 'vertex' },
      attributes: [{ format: 'float32x4', offsetBytes: 0 }],
    });
    expect(report.targets[10]?.resource).toMatchObject({
      resourceType: 'slot',
      properties: { hasDefault: true, defaultValue: 7 },
    });
    expect(report.targets[11]?.resource).toMatchObject({
      resourceType: 'accessor',
      sizeBytes: 8,
      properties: { hasDefault: true },
    });
    expect(report.targets[12]?.resource).toMatchObject({
      resourceType: 'collection',
      count: 3,
      itemNames: ['buffers', 'textures', 'sampler'],
      items: [
        {
          resourceType: 'collection',
          count: 1,
          itemNames: ['settings'],
          items: [{ resourceType: 'uniform' }],
        },
        {
          resourceType: 'collection',
          count: 2,
          itemNames: ['sampled', 'view'],
          items: [
            { resourceType: 'texture' },
            { resourceType: 'texture-view' },
          ],
        },
        { resourceType: 'sampler' },
      ],
    });
  });

  maybeIt('reconstructs a selected render pipeline with its exact runtime descriptor', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/runtime-render-pipeline.ts',
      targets: [{
        label: 'runtime render',
        selector: 'runtimeRenderPipeline',
        kind: 'render-pipeline',
      }],
      includeWgsl: true,
      includeCalls: true,
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]?.wgsl).toContain('@vertex');
    expect(report.targets[0]?.wgsl).toContain('@fragment');

    const pipelineCall = report.calls.find((call) =>
      call.targetLabel === 'runtime render' &&
      call.name === 'device.createRenderPipeline'
    );
    expect(pipelineCall?.descriptor).toMatchObject({
      primitive: {
        topology: 'triangle-strip',
        frontFace: 'cw',
        cullMode: 'back',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      multisample: { count: 4 },
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
      vertex: {
        buffers: [{
          arrayStride: 16,
          stepMode: 'vertex',
          attributes: [{
            format: 'float32x3',
            offset: 0,
            shaderLocation: 0,
          }],
        }],
      },
    });
  });

  maybeIt('inspects a non-exported top-level TypeGPU declaration', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      includePrivate: true,
      targets: [
        {
          label: 'private helper',
          selector: 'privateHelper',
          kind: 'resolvable',
          unwrap: false,
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.wgsl).toContain('privateHelper');
  });

  maybeIt('synthesizes a zero-valued imported or private struct argument', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      includePrivate: true,
      targets: [
        {
          label: 'private struct helper',
          selector: 'privateStructHelper',
          kind: 'resolvable',
          probeArguments: ['module.AccessorParams'],
          probeBindings: [{
            slot: 'paramsAccess',
            schema: 'module.AccessorParams',
          }],
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]?.wgsl).toContain('struct AccessorParams');
    expect(report.targets[0]?.wgsl).toContain('privateStructHelper(AccessorParams())');
    expect(report.targets[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'inspection-defaults-applied',
          hint: expect.stringContaining('paramsAccess'),
        }),
      ]),
    );
  });

  maybeIt('isolates and recovers a schema imported with import type', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/type-only-helper.ts',
      includePrivate: true,
      targets: [
        {
          label: 'scalar helper',
          selector: 'scalarHelper',
          kind: 'resolvable',
          probeArguments: ['ctx.d.f32'],
        },
        {
          label: 'bounds helper',
          selector: 'boundsHelper',
          kind: 'resolvable',
          probeArguments: ['module.Bounds'],
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets).toHaveLength(2);
    expect(report.targets[0]?.wgsl).toContain('scalarHelper');
    expect(report.targets[1]?.wgsl).toContain('struct Bounds');
    expect(report.targets[1]?.wgsl).toContain('boundsHelper(Bounds())');
  });

  maybeIt('runs pre-import browser setup and serves configured static assets', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: { kind: 'modulePath', modulePath: 'test/fixtures/dom-and-asset-inspection.ts' },
      documentHtml: '<canvas width="7" height="5"></canvas>',
      browserSetup: 'window.__TYPEGPU_MCP_FIXTURE_VALUE = "ready";',
      staticAssetRoutes: [{ urlPrefix: '/fixtures', directory: 'test/fixtures/static' }],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('dom 7 asset loaded');
  });

  maybeIt('imports modulePath sources without inspect exports in diagnostics-only mode', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: { kind: 'modulePath', modulePath: 'test/fixtures/symbol-targets.ts' },
      diagnosticsOnly: true,
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets).toEqual([]);
    expect(report.moduleImport).toEqual({
      sourceKind: 'modulePath',
      moduleImported: true,
      inspectExportFound: false,
      importOnly: true,
      exportName: 'inspect',
    });
  });

  maybeIt('lazily provides canvas hosts and honors explicit documentHtml', async () => {
    const synthesizedCanvas = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: { kind: 'modulePath', modulePath: 'test/fixtures/side-effect-canvas-module.ts' },
      diagnosticsOnly: true,
      timeoutMs: 30_000,
    });

    expect(synthesizedCanvas.ok).toBe(true);
    expect(synthesizedCanvas.targets).toEqual([]);
    expect(synthesizedCanvas.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tier: 'environment',
        kind: 'dom-setup',
        status: 'satisfied',
        provider: 'synthesis',
      }),
    ]));

    const withCanvas = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: { kind: 'modulePath', modulePath: 'test/fixtures/side-effect-canvas-module.ts' },
      documentHtml: '<canvas width="9" height="5"></canvas>',
      diagnosticsOnly: true,
      timeoutMs: 30_000,
    });

    expect(withCanvas.ok).toBe(true);
    expect(withCanvas.targets).toEqual([]);
    expect(withCanvas.moduleImport?.moduleImported).toBe(true);
    expect(withCanvas.moduleImport?.inspectExportFound).toBe(false);
    expect(withCanvas.moduleImport?.importOnly).toBe(true);
  });

  maybeIt('keeps later symbol targets inspectable when an earlier selector fails', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      targets: [
        { label: 'missing symbol', selector: 'missingSymbol', kind: 'resolvable' },
        { label: 'helper still runs', selector: 'exportedHelper', kind: 'resolvable' },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(false);
    expect(report.targets).toHaveLength(2);
    expect(report.targets[0]?.ok).toBe(false);
    expect(report.targets[0]?.error?.message).toContain('Could not resolve selector');
    expect(report.targets[1]?.ok).toBe(true);
    expect(report.targets[1]?.label).toBe('helper still runs');
  });

  maybeIt('returns concise diagnostics for plain non-TypeGPU values', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          return {
            label: 'plain object',
            kind: 'resolvable',
            value: { mode: 'cpu', nested: { value: 1 } },
          };
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(false);
    expect(report.targets[0]?.error?.name).toBe('TargetDiagnosticError');
    expect(report.targets[0]?.diagnostics?.[0]?.code).toBe('plain-object-not-inspectable');
  });

  maybeIt('resolves TypeGPU fragment functions selected directly', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const fragment = tgpu.fragmentFn({ out: d.vec4f })(() => {
            'use gpu';
            return d.vec4f(1);
          });

          return {
            label: 'direct fragment',
            kind: 'resolvable',
            value: fragment,
          };
        `,
      },
      includeWgsl: true,
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.diagnostics?.[0]?.code).not.toBe('plain-object-not-inspectable');
    expect(report.targets[0]?.wgsl).toContain('@fragment');
  });

  maybeIt('unwraps guarded pipeline wrapper objects through their inner pipeline', async () => {
    const report = await inspectTypegpuModule({
      cwd: resolve(import.meta.dirname, '..'),
      source: {
        kind: 'inspectBody',
        inspectBody: `
          const guarded = root.createGuardedComputePipeline((x) => {
            'use gpu';
            const _value = x;
          });

          return {
            label: 'guarded compute',
            kind: 'compute-pipeline',
            value: guarded,
          };
        `,
      },
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.diagnostics?.[0]?.code).toBe('pipeline-wrapper-unwrapped');
    expect(report.stats.computePipelineCount).toBe(1);
  });

  maybeIt('uses setupBody return values as top-level selector roots for imported helpers', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      setupBody: 'return { common: await import("typegpu/common") };',
      targets: [
        {
          label: 'common fullscreen render',
          kind: 'render-pipeline',
          vertex: 'common.fullScreenTriangle',
          fragment: 'exportedFragment',
          descriptor: { targets: { format: 'bgra8unorm' } },
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('common fullscreen render');
    expect(report.stats.renderPipelineCount).toBe(1);
  });

  maybeIt('creates render pipelines from attrib selector maps', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      targets: [
        {
          label: 'attributed render',
          kind: 'render-pipeline',
          vertex: 'exportedAttributedVertex',
          fragment: 'exportedFragment',
          attribs: { color: 'exportedAttributedVertexLayout.attrib' },
          descriptor: { targets: { format: 'bgra8unorm' } },
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('attributed render');
    expect(report.stats.renderPipelineCount).toBe(1);
  });

  maybeIt('binds accessors with explicit setup resources', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      setupBody: `
        const common = await import("typegpu/common");
        const params = root.createUniform(module.AccessorParams, { tint: d.vec4f(1, 1, 1, 1) });
        return { common, params };
      `,
      targets: [
        {
          label: 'accessor render',
          kind: 'render-pipeline',
          vertex: 'common.fullScreenTriangle',
          fragment: 'accessorFragment',
          descriptor: { targets: { format: 'bgra8unorm' } },
          with: [{ slot: 'paramsAccess', value: 'setup.params' }],
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(true);
    expect(report.targets[0]?.label).toBe('accessor render');
    expect(report.stats.renderPipelineCount).toBe(1);
    expect(report.stats.bindGroupLayoutCount).toBeGreaterThan(0);
  });

  maybeIt('auto-binds a default-less accessor without explicit bindings', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      targets: [
        {
          label: 'auto-bound accessor render',
          kind: 'render-pipeline',
          vertex: 'exportedVertex',
          fragment: 'accessorFragment',
          descriptor: { targets: { format: 'bgra8unorm' } },
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]?.wgsl).toContain('struct AccessorParams');
    expect(report.targets[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'slot-bindings-auto-applied',
          severity: 'note',
          hint: expect.stringContaining('paramsAccess'),
        }),
      ]),
    );
    expect(report.stats.renderPipelineCount).toBe(1);
  });

  maybeIt('recursively avoids degenerate synthesized bindings in composite schemas', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      targets: [
        {
          label: 'non-degenerate composite accessor render',
          kind: 'render-pipeline',
          vertex: 'nondegenerateVertex',
          fragment: 'exportedFragment',
          descriptor: { targets: { format: 'bgra8unorm' } },
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok, JSON.stringify(report.targets, null, 2)).toBe(true);
    expect(report.targets[0]?.outcome).toBe('passed-with-assumptions');
    expect(report.targets[0]?.wgsl).not.toContain('0.0 / 0.0');
    expect(report.targets[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'slot-bindings-auto-applied',
          severity: 'note',
          hint: expect.stringContaining('non-degenerate placeholder value'),
        }),
      ]),
    );
    expect(report.targets[0]?.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'slot-value',
          status: 'satisfied',
          provider: 'synthesis',
          provenance: expect.stringContaining('recursively derived'),
          detail: expect.objectContaining({ slotName: 'nondegenerateParamsAccess' }),
        }),
      ]),
    );
  });

  maybeIt('auto-binds an accessor imported from a sibling module', async () => {
    for (const includePrivate of [false, true]) {
      const report = await inspectTypegpuSymbols({
        cwd: resolve(import.meta.dirname, '..'),
        modulePath: 'test/fixtures/imported-accessor-consumer.ts',
        includePrivate,
        targets: [
          {
            label: 'imported accessor render',
            kind: 'render-pipeline',
            vertex: 'common.fullScreenTriangle',
            fragment: 'importedAccessorFragment',
            descriptor: { targets: { format: 'bgra8unorm' } },
          },
        ],
        setupBody: `
          const common = await import("typegpu/common");
          return { common };
        `,
        timeoutMs: 30_000,
      });

      expect(report.ok, `includePrivate=${includePrivate}: ${JSON.stringify(report.targets, null, 2)}`)
        .toBe(true);
      expect(report.targets[0]?.wgsl).toContain('struct AccessorParams');
      expect(report.targets[0]?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'slot-bindings-auto-applied',
            severity: 'note',
          }),
        ]),
      );
      expect(report.targets[0]?.ledger).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'slot-value',
            status: 'satisfied',
            detail: expect.objectContaining({ slotName: 'paramsAccess' }),
          }),
        ]),
      );
    }
  });

  maybeIt('surfaces missing slot bindings when autoBind is disabled', async () => {
    const report = await inspectTypegpuSymbols({
      cwd: resolve(import.meta.dirname, '..'),
      modulePath: 'test/fixtures/symbol-targets.ts',
      autoBind: false,
      targets: [
        {
          label: 'unbound accessor render',
          kind: 'render-pipeline',
          vertex: 'exportedVertex',
          fragment: 'accessorFragment',
          descriptor: { targets: { format: 'bgra8unorm' } },
        },
      ],
      timeoutMs: 30_000,
    });

    expect(report.ok).toBe(false);
    expect(report.targets[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'slot-binding-required',
          message: expect.stringContaining('paramsAccess'),
        }),
      ]),
    );
    expect(report.targets[0]?.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'slot-bindings-auto-applied' }),
      ]),
    );
  });

  maybeIt('keeps workspace TypeGPU ecosystem packages out of unsafe dependency prebundling', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'typegpu-mcp-workspace-noise-'));
    try {
      await mkdir(join(tempDir, 'node_modules/@typegpu/noise/src'), { recursive: true });
      await writeFile(
        join(tempDir, 'node_modules/@typegpu/noise/package.json'),
        JSON.stringify({
          name: '@typegpu/noise',
          version: '0.0.0-test',
          type: 'module',
          exports: { '.': './src/index.ts' },
        }),
        'utf8',
      );
      await writeFile(
        join(tempDir, 'node_modules/@typegpu/noise/src/index.ts'),
        `
          import { tgpu, d } from 'typegpu';
          import { cos, dot, fract } from 'typegpu/std';

          const sampleShell = tgpu.fn([], d.f32);
          const defaultGenerator = (() => {
            const seed = tgpu.privateVar(d.vec2f);
            return {
              seed3: tgpu.fn([d.vec3f])((value) => {
                'use gpu';
                seed.$ = value.xy + d.vec2f(value.z);
              }),
              sample: sampleShell(() => {
                'use gpu';
                seed.$.x = fract(cos(dot(seed.$, d.vec2f(23.1, 232.6))) * 136.8);
                seed.$.y = fract(cos(dot(seed.$, d.vec2f(54.4, 345.8))) * 534.7);
                return seed.$.y;
              }),
            };
          })();
          const generatorSlot = tgpu.slot(defaultGenerator);
          const warnIfMissing = tgpu.comptime((name: 'seed3') => {
            if (!generatorSlot.$[name]) {
              console.warn('missing generator');
            }
          });

          const seed3 = tgpu.fn([d.vec3f])((seed) => {
            warnIfMissing('seed3');
            generatorSlot.$.seed3 ? generatorSlot.$.seed3(seed) : undefined;
          });
          const sample = tgpu.fn([], d.f32)(() => generatorSlot.$.sample());

          export const randf = { seed3, sample };
        `,
        'utf8',
      );
      await writeFile(
        join(tempDir, 'target.ts'),
        `
          import { tgpu, d } from 'typegpu';
          import { randf } from '@typegpu/noise';

          const layout = tgpu.bindGroupLayout({
            data: { storage: d.arrayOf(d.u32), access: 'mutable' },
          });

          export const initKernel = tgpu.computeFn({
            workgroupSize: [1],
            in: { gid: d.builtin.globalInvocationId },
          })((input) => {
            randf.seed3(d.vec3f(d.f32(input.gid.x), 1, 2));
            layout.$.data[input.gid.x] = d.u32(randf.sample() * 255);
          });
        `,
        'utf8',
      );

      const report = await inspectTypegpuSymbols({
        cwd: tempDir,
        modulePath: 'target.ts',
        targets: [{ label: 'workspace noise compute', kind: 'compute-pipeline', compute: 'initKernel' }],
        timeoutMs: 30_000,
      });

      expect(report.ok).toBe(true);
      expect(report.targets[0]?.wgsl).toContain('fn seed3');
      expect(report.targets[0]?.wgsl).not.toContain('&&');
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
