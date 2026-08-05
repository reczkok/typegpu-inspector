import { describe, expect, it } from 'vitest';
import {
  discoverTypeGpuModule,
  MAX_SYNTHESIZED_SPECIALIZATIONS,
} from '../src/discovery.js';

describe('discoverTypeGpuModule', () => {
  it('discovers compute, render, helper, schema, and layout exports', () => {
    const source = `
      import tgpu from 'typegpu';
      import * as d from 'typegpu/data';

      export const computeMain = tgpu.computeFn({ workgroupSize: [8] })(() => {
        'use gpu';
      });
      export const vertexMain = tgpu.vertexFn({ in: {}, out: {} })(() => {
        'use gpu';
      });
      export const fragmentMain = tgpu.fragmentFn({ in: {}, out: d.vec4f })(() => {
        'use gpu';
      });
      export const helper = tgpu.fn([], d.f32)(() => {
        'use gpu';
        return 1;
      });
      export const Params = d.struct({ value: d.f32 });
      export const layout = tgpu.bindGroupLayout({ params: { uniform: Params } });
    `;

    const result = discoverTypeGpuModule('/project/shaders.ts', source);

    expect(result.symbols.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'computeMain', role: 'compute-entrypoint' },
      { name: 'vertexMain', role: 'vertex-entrypoint' },
      { name: 'fragmentMain', role: 'fragment-entrypoint' },
      { name: 'helper', role: 'shader-helper' },
      { name: 'Params', role: 'schema' },
      { name: 'layout', role: 'bind-group-layout' },
    ]);
    expect(result.targets.map((target) => target.id)).toEqual([
      'compute:computeMain',
      'resolvable:helper',
      'resource:Params',
      'resource:layout',
      'render:vertexMain+fragmentMain',
    ]);
    expect(
      result.symbols.find((symbol) => symbol.name === 'vertexMain')?.targetIds,
    ).toEqual(['render:vertexMain+fragmentMain']);
  });

  it('derives structural targets for TypeGPU resources used by image processing modules', () => {
    const result = discoverTypeGpuModule(
      '/project/blur.ts',
      `
        const Settings = d.struct({ filterDim: d.i32, blockDim: d.u32 });
        const settingsUniform = root.createUniform(Settings);
        const imageTexture = root.createTexture({
          size: [640, 480],
          format: 'rgba8unorm',
        }).$usage('sampled', 'render');
        const textures = [0, 1].map(() =>
          root.createTexture({ size: [640, 480], format: 'rgba8unorm' })
            .$usage('sampled', 'storage')
        );
        const renderView = textures[1].createView(d.texture2d(d.f32));
        const sampler = root.createSampler({ magFilter: 'linear' });
        const ioLayout = tgpu.bindGroupLayout({
          flip: { uniform: d.u32 },
          input: { texture: d.texture2d(d.f32) },
          output: { storageTexture: d.textureStorage2d('rgba8unorm') },
        });
        const tileData = tgpu.workgroupVar(d.arrayOf(d.vec3f, 128));
        const zeroBuffer = root.createBuffer(d.u32, 0).$usage('uniform');
        const ioBindGroups = [0, 1].map((index) =>
          root.createBindGroup(ioLayout, { flip: zeroBuffer })
        );
      `,
    );

    expect(result.symbols.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'Settings', role: 'schema' },
      { name: 'settingsUniform', role: 'buffer-resource' },
      { name: 'imageTexture', role: 'texture-resource' },
      { name: 'textures', role: 'resource-collection' },
      { name: 'renderView', role: 'texture-view' },
      { name: 'sampler', role: 'sampler-resource' },
      { name: 'ioLayout', role: 'bind-group-layout' },
      { name: 'tileData', role: 'gpu-variable' },
      { name: 'zeroBuffer', role: 'buffer-resource' },
      { name: 'ioBindGroups', role: 'resource-collection' },
    ]);
    expect(result.targets).toHaveLength(10);
    expect(result.targets.every((target) =>
      target.selector.kind === 'resource'
    )).toBe(true);
  });

  it('falls back to resolvable WGSL for an unpaired stage', () => {
    const result = discoverTypeGpuModule(
      '/project/vertex.ts',
      `export const vertexMain = tgpu.vertexFn({ in: {}, out: {} })(() => {
        'use gpu';
      });`,
    );

    expect(result.targets).toMatchObject([
      {
        id: 'resolvable:vertexMain',
        selector: {
          kind: 'resolvable',
          selector: 'vertexMain',
          unwrap: false,
        },
      },
    ]);
  });

  it('exposes top-level local symbols through the specialized inline inspector', () => {
    const result = discoverTypeGpuModule(
      '/project/private.ts',
      `const privateMain = tgpu.computeFn({ workgroupSize: [1] })(() => {
        'use gpu';
      });`,
    );

    expect(result.symbols).toMatchObject([
      { name: 'privateMain', role: 'compute-entrypoint' },
    ]);
    expect(result.targets).toMatchObject([
      {
        id: 'compute:privateMain',
        selector: { kind: 'compute-pipeline', compute: 'privateMain' },
      },
    ]);
  });

  it('propagates integer defaults through texture-array helper calls', () => {
    const result = discoverTypeGpuModule(
      '/project/suika.ts',
      `
        const spriteView = texture.createView(d.texture2dArray());
        const sampler = root.createSampler({});
        const sampleSprite = (uv: d.v2f, level: number) => {
          'use gpu';
          return std.textureSampleLevel(spriteView.$, sampler.$, uv, level, 0);
        };
        const blendSprite = (uv: d.v2f, level: number) => {
          'use gpu';
          return sampleSprite(uv, level);
        };
        const renderPreview = (uv: d.v2f, nextLevel: number) => {
          'use gpu';
          return blendSprite(uv, nextLevel);
        };
      `,
    );

    for (const name of ['sampleSprite', 'blendSprite', 'renderPreview']) {
      expect(
        result.symbols.find((symbol) => symbol.name === name)?.probeArguments,
      ).toEqual(['ctx.d.vec2f', 'ctx.d.i32']);
    }
  });

  it('does not classify callback resources as the constructed host object', () => {
    const result = discoverTypeGpuModule(
      '/project/observer.ts',
      `
        const resizeObserver = new ResizeObserver(() => {
          const view = texture.createView(d.texture2d());
        });
      `,
    );

    expect(result.symbols).toEqual([]);
    expect(result.targets).toEqual([]);
  });

  it('keeps a 2d texture LOD scalar when the fifth argument is a vector offset', () => {
    const result = discoverTypeGpuModule(
      '/project/sample-offset.ts',
      `
        const sampleOffset = (uv: d.v2f, lod: number) => {
          'use gpu';
          return std.textureSampleLevel(view.$, sampler.$, uv, lod, d.vec2i());
        };
      `,
    );

    expect(
      result.symbols.find((symbol) => symbol.name === 'sampleOffset')
        ?.probeArguments,
    ).toEqual(['ctx.d.vec2f', 'ctx.d.f32']);
  });

  it('synthesizes concrete probe schemas for parameterized GPU helpers', () => {
    const result = discoverTypeGpuModule(
      '/project/helpers.ts',
      `
        export const sigmoidOp = (value: d.v4f, scale: number) => {
          'use gpu';
          return value / (1 + std.exp(-value * scale));
        };
      `,
    );

    expect(result.symbols[0]).toMatchObject({
      name: 'sigmoidOp',
      role: 'shader-helper',
      probeArguments: ['ctx.d.vec4f', 'ctx.d.f32'],
    });
    expect(result.targets[0]?.selector).toMatchObject({
      kind: 'resolvable',
      selector: 'sigmoidOp',
      probeArguments: ['ctx.d.vec4f', 'ctx.d.f32'],
    });
  });

  it('synthesizes one correlated probe target per finite generic specialization', () => {
    const result = discoverTypeGpuModule(
      '/project/evolve.ts',
      `
        const evolveVec = <T extends d.v2f | d.v4f>(a: T, b: T): T => {
          'use gpu';
          if (a.kind === 'vec2f') return a;
          return b;
        };
      `,
    );

    expect(result.symbols[0]).toMatchObject({
      name: 'evolveVec',
      probeSpecializations: [
        {
          probeArguments: ['ctx.d.vec2f', 'ctx.d.vec2f'],
          signature: 'vec2f, vec2f',
        },
        {
          probeArguments: ['ctx.d.vec4f', 'ctx.d.vec4f'],
          signature: 'vec4f, vec4f',
        },
      ],
      specializationSynthesis: {
        emitted: 2,
        limit: MAX_SYNTHESIZED_SPECIALIZATIONS,
        truncated: false,
      },
      targetIds: [
        'resolvable:evolveVec:specialization:0',
        'resolvable:evolveVec:specialization:1',
      ],
    });
    expect(result.targets).toMatchObject([
      {
        label: 'evolveVec(vec2f, vec2f)',
        selector: {
          label: 'evolveVec(vec2f, vec2f)',
          probeArguments: ['ctx.d.vec2f', 'ctx.d.vec2f'],
        },
      },
      {
        label: 'evolveVec(vec4f, vec4f)',
        selector: {
          label: 'evolveVec(vec4f, vec4f)',
          probeArguments: ['ctx.d.vec4f', 'ctx.d.vec4f'],
        },
      },
    ]);
  });

  it('bounds synthesized specialization targets', () => {
    const result = discoverTypeGpuModule(
      '/project/bounded.ts',
      `
        const bounded = (
          a: d.v2f | d.v4f,
          b: d.v2f | d.v4f,
          c: d.v2f | d.v4f,
          d: d.v2f | d.v4f,
        ) => {
          'use gpu';
          return 0;
        };
      `,
    );

    expect(result.targets).toHaveLength(MAX_SYNTHESIZED_SPECIALIZATIONS);
    expect(result.symbols[0]).toMatchObject({
      specializationSynthesis: {
        emitted: MAX_SYNTHESIZED_SPECIALIZATIONS,
        limit: MAX_SYNTHESIZED_SPECIALIZATIONS,
        truncated: true,
      },
    });
    expect(new Set(result.targets.map((target) => target.label))).toHaveLength(
      MAX_SYNTHESIZED_SPECIALIZATIONS,
    );
  });

  it('does not mistake an unconstrained erased type parameter for a module schema', () => {
    const result = discoverTypeGpuModule(
      '/project/unbounded.ts',
      `
        const unbounded = <T>(value: T): T => {
          'use gpu';
          return value;
        };
      `,
    );

    expect(result.symbols[0]?.probeArguments).toBeUndefined();
    expect(result.targets[0]?.selector).not.toHaveProperty('probeArguments');
  });

  it('recognizes InferGPU struct inputs as zero-value schemas', () => {
    const result = discoverTypeGpuModule(
      '/project/network.ts',
      `
        const Genome = d.struct({ bias: d.f32 });
        const evalNetwork = (
          genome: d.InferGPU<typeof Genome>,
          input: d.v4f,
        ) => {
          'use gpu';
          return input + genome.bias;
        };
      `,
    );

    expect(
      result.symbols.find((symbol) => symbol.name === 'evalNetwork'),
    ).toMatchObject({
      probeArguments: ['module.Genome', 'ctx.d.vec4f'],
    });
  });

  it('uses concrete call-site resources in mixed helper argument plans', () => {
    const result = discoverTypeGpuModule(
      '/project/sampling.ts',
      `
        const nearestSampler = root.createSampler({ magFilter: 'nearest' });
        const sampleTrack = (uv: d.v2f, sampler: d.sampler) => {
          'use gpu';
          return std.textureSampleLevel(trackView.$, sampler, uv, 0);
        };
        const forwarded = (uv: d.v2f, sampler: d.sampler) => {
          'use gpu';
          return sampleTrack(uv, sampler);
        };
        const caller = (uv: d.v2f) => {
          'use gpu';
          return forwarded(uv, nearestSampler.$);
        };
        const directCaller = (uv: d.v2f) => {
          'use gpu';
          return sampleTrack(uv, nearestSampler.$);
        };
      `,
    );

    expect(
      result.symbols.find((symbol) => symbol.name === 'sampleTrack'),
    ).toMatchObject({
      probeArgumentPlan: [
        { schema: 'ctx.d.vec2f' },
        { value: 'nearestSampler.$' },
      ],
    });
    expect(
      result.targets.find((target) => target.label === 'sampleTrack')?.selector,
    ).toMatchObject({
      probeArgumentPlan: [
        { schema: 'ctx.d.vec2f' },
        { value: 'nearestSampler.$' },
      ],
    });
  });

  it('discovers aliases and pipeline values', () => {
    const result = discoverTypeGpuModule(
      '/project/pipelines.ts',
      `
        const helper = tgpu.fn([d.f32], d.f32)((value) => value);
        const render = root.createRenderPipeline({ vertex, fragment });
        export { helper as exportedHelper, render as exportedRender };
      `,
    );

    expect(result.symbols.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'exportedHelper', role: 'shader-helper' },
      { name: 'exportedRender', role: 'render-pipeline' },
      { name: 'helper', role: 'shader-helper' },
      { name: 'render', role: 'render-pipeline' },
    ]);
    expect(result.targets.map((target) => target.selector)).toMatchObject([
      {
        kind: 'resolvable',
        selector: 'helper',
        probeArguments: ['ctx.d.f32'],
      },
      {
        kind: 'render-pipeline',
        selector: 'render',
      },
      {
        kind: 'resolvable',
        selector: 'helper',
        probeArguments: ['ctx.d.f32'],
      },
      {
        kind: 'render-pipeline',
        selector: 'render',
      },
    ]);
  });

  it('attaches factories to values produced by existing top-level calls', () => {
    const result = discoverTypeGpuModule(
      '/project/factories.ts',
      `
        const makeTexture = () =>
          root.createTexture({ size: [8, 8], format: 'rgba8unorm' })
            .$usage('sampled');
        const textures = [makeTexture(), makeTexture()];

        function makePipelines() {
          const optimized = root.createComputePipeline({ compute });
          const render = root.createRenderPipeline({ vertex, fragment });
          return {
            'gpu-optimized': hasTiming
              ? optimized.withPerformanceCallback(onTiming)
              : optimized,
            render,
          };
        }
        const pipelineSet = makePipelines();

        function makeBundle() {
          const layout = tgpu.bindGroupLayout({ data: { uniform: d.f32 } });
          const pipeline = root.createRenderPipeline({ vertex, fragment });
          return { layout, pipeline };
        }
        const { layout, pipeline } = makeBundle();

        function uncalledDispatchFactory() {
          const pipeline = root.createComputePipeline({ compute });
          pipeline.dispatchWorkgroups(1);
          return pipeline;
        }
      `,
    );

    expect(
      result.symbols.find((symbol) => symbol.name === 'makeTexture')?.targetIds,
    ).toEqual([
      'factory-result:makeTexture:textures.0',
      'factory-result:makeTexture:textures.1',
    ]);
    expect(
      result.symbols.find((symbol) => symbol.name === 'textures'),
    ).toMatchObject({
      role: 'resource-result',
      targetIds: [
        'factory-result:makeTexture:textures.0',
        'factory-result:makeTexture:textures.1',
      ],
    });

    expect(
      result.targets
        .filter((target) => target.symbolNames.includes('makePipelines'))
        .map((target) => target.selector),
    ).toEqual([
      {
        kind: 'compute-pipeline',
        selector: 'pipelineSet.gpu-optimized',
        label: 'makePipelines → pipelineSet.gpu-optimized',
      },
      {
        kind: 'render-pipeline',
        selector: 'pipelineSet.render',
        label: 'makePipelines → pipelineSet.render',
      },
    ]);

    expect(
      result.symbols.find((symbol) => symbol.name === 'makeBundle')?.targetIds,
    ).toEqual(['resource:layout', 'pipeline:pipeline']);
    expect(
      result.symbols.find((symbol) => symbol.name === 'layout'),
    ).toMatchObject({ role: 'bind-group-layout', targetIds: ['resource:layout'] });
    expect(
      result.symbols.find((symbol) => symbol.name === 'pipeline'),
    ).toMatchObject({ role: 'render-pipeline', targetIds: ['pipeline:pipeline'] });
    expect(
      result.symbols.find((symbol) => symbol.name === 'uncalledDispatchFactory')
        ?.targetIds,
    ).toEqual([]);
  });

  it('inspects a resource-factory bundle through one concrete result target', () => {
    const result = discoverTypeGpuModule(
      '/project/resources.ts',
      `
        function createResources() {
          const textures = [0, 1].map(() =>
            root.createTexture({ size: [32, 32], format: 'rgba16float' })
              .$usage('storage')
          );
          const maskTexture = root
            .createTexture({ size: [32, 32], format: 'r32uint' })
            .$usage('storage');
          const bindGroups = textures.map((texture) =>
            root.createBindGroup(layout, { texture })
          );
          return { textures, maskTexture, bindGroups };
        }
        let resources = createResources();
      `,
    );

    const targetId = 'factory-result:createResources:resources';
    expect(
      result.symbols.find((symbol) => symbol.name === 'createResources'),
    ).toMatchObject({ role: 'resource-factory', targetIds: [targetId] });
    expect(
      result.symbols.find((symbol) => symbol.name === 'resources'),
    ).toMatchObject({ role: 'resource-result', targetIds: [targetId] });
    expect(
      result.targets.filter((target) => target.id.startsWith('factory-result:')),
    ).toEqual([{
      id: targetId,
      label: 'createResources → resources',
      selector: {
        kind: 'resource',
        selector: 'resources',
        label: 'createResources → resources',
      },
      symbolNames: ['createResources', 'resources'],
    }]);
  });

  it('selects chained local pipelines for exact runtime reconstruction', () => {
    const result = discoverTypeGpuModule(
      '/project/app.ts',
      `
        const mainVertex = tgpu.vertexFn({ in: { color: d.vec4f }, out: Out })(impl);
        const mainFragment = tgpu.fragmentFn({ out: d.vec4f })(impl);
        const pipeline = root
          .createRenderPipeline({
            vertex: mainVertex,
            fragment: mainFragment,
            targets: { format: presentationFormat },
          })
          .with(layout, buffer);
      `,
    );

    expect(result.symbols.map(({ name, role }) => ({ name, role }))).toContainEqual({
      name: 'pipeline',
      role: 'render-pipeline',
    });
    expect(
      result.targets.find((target) => target.id === 'pipeline:pipeline')?.selector,
    ).toMatchObject({
      kind: 'render-pipeline',
      selector: 'pipeline',
    });
    expect(
      result.symbols.find((symbol) => symbol.name === 'mainVertex')?.targetIds,
    ).toEqual(['pipeline:pipeline']);
    expect(
      result.symbols.find((symbol) => symbol.name === 'mainFragment')?.targetIds,
    ).toEqual(['pipeline:pipeline']);
    expect(
      result.targets.find((target) => target.id === 'pipeline:pipeline')
        ?.symbolNames,
    ).toEqual(['pipeline', 'mainVertex', 'mainFragment']);
    expect(
      result.targets.find((target) => target.id === 'pipeline:pipeline')
        ?.pipelineSource,
    ).toEqual({
      kind: 'render-pipeline',
      vertex: 'mainVertex',
      fragment: 'mainFragment',
      bindings: [{ source: 'layout', value: 'buffer' }],
    });
    expect(
      result.targets.some((target) => target.id.startsWith('render:')),
    ).toBe(false);
  });

  it('uses a concrete compute pipeline instead of a duplicate synthesized target', () => {
    const result = discoverTypeGpuModule(
      '/project/compute.ts',
      `
        const simulationStep = tgpu.computeFn({ workgroupSize: [64] })(impl);
        const simulationPipeline = root
          .with(paramsAccess, paramsUniform)
          .createComputePipeline({ compute: simulationStep });
      `,
    );

    expect(
      result.symbols.find((symbol) => symbol.name === 'simulationStep')
        ?.targetIds,
    ).toEqual(['pipeline:simulationPipeline']);
    expect(result.targets.map((target) => target.id)).toEqual([
      'pipeline:simulationPipeline',
    ]);
    expect(result.targets[0]?.selector).toEqual({
      kind: 'compute-pipeline',
      selector: 'simulationPipeline',
      label: 'simulationPipeline',
    });
    expect(result.targets[0]?.symbolNames).toEqual([
      'simulationPipeline',
      'simulationStep',
    ]);
  });

  it('uses a concrete factory pipeline as the inspection context for its stages', () => {
    const result = discoverTypeGpuModule(
      '/project/overlay.ts',
      `
        const overlayVertex = tgpu.vertexFn({ out: Out })(impl);
        const overlayFrag = tgpu.fragmentFn({ out: d.vec4f })(() => {
          return sceneDataAccess.$.color;
        });

        function createRenderPipeline() {
          return root
            .with(sceneDataAccess, sceneDataUniform)
            .createRenderPipeline({
              vertex: overlayVertex,
              fragment: overlayFrag,
            });
        }

        const renderPipeline = createRenderPipeline();
      `,
    );

    expect(
      result.symbols.find((symbol) => symbol.name === 'overlayFrag')?.targetIds,
    ).toEqual(['pipeline:renderPipeline']);
    expect(
      result.targets.find((target) => target.id === 'pipeline:renderPipeline')
        ?.symbolNames,
    ).toEqual([
      'renderPipeline',
      'createRenderPipeline',
      'overlayVertex',
      'overlayFrag',
    ]);
    expect(
      result.targets.find((target) => target.id === 'pipeline:renderPipeline')
        ?.pipelineSource,
    ).toEqual({
      kind: 'render-pipeline',
      vertex: 'overlayVertex',
      fragment: 'overlayFrag',
      bindings: [{
        source: 'sceneDataAccess',
        value: 'sceneDataUniform',
      }],
    });
    expect(
      result.targets.some((target) => target.id === 'resolvable:overlayFrag'),
    ).toBe(false);
  });

  it('pairs render stages by name instead of producing a Cartesian product', () => {
    const result = discoverTypeGpuModule(
      '/project/render.ts',
      `
        export const shadowVertex = tgpu.vertexFn({ out: Out })(impl);
        export const shadowFragment = tgpu.fragmentFn({ out: d.vec4f })(impl);
        export const colorVertex = tgpu.vertexFn({ out: Out })(impl);
        export const colorFragment = tgpu.fragmentFn({ out: d.vec4f })(impl);
      `,
    );

    expect(result.targets.map((target) => target.id)).toEqual([
      'render:shadowVertex+shadowFragment',
      'render:colorVertex+colorFragment',
    ]);
    expect(result.targets.every((target) =>
      'synthesizeMissing' in target.selector &&
      target.selector.synthesizeMissing === true
    )).toBe(true);
  });

  it('discovers guarded pipelines, chained/tagged shaders, comparison samplers, and query sets', () => {
    const result = discoverTypeGpuModule(
      '/project/advanced.ts',
      `
        const guarded = root
          .with(paramsSlot, params)
          .createGuardedComputePipeline((x, y) => {
            'use gpu';
          });
        const rawHelper = tgpu
          .fn([d.vec3f, d.f32], d.vec3f)\`(v, a) {
            return fract(v / a) * a;
          }\`
          .$name('mod');
        const namedVertex = tgpu
          .vertexFn({ out: { position: d.builtin.position } })(impl)
          .$name('vertex');
        const shadowSampler = root.createComparisonSampler({
          compare: 'less-equal',
        });
        const querySet = enabled
          ? root.createQuerySet('timestamp', 2)
          : null;
      `,
    );

    expect(result.symbols.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'guarded', role: 'compute-pipeline' },
      { name: 'rawHelper', role: 'shader-helper' },
      { name: 'namedVertex', role: 'vertex-entrypoint' },
      { name: 'shadowSampler', role: 'sampler-resource' },
      { name: 'querySet', role: 'query-resource' },
    ]);
    expect(result.targets).toMatchObject([
      {
        id: 'pipeline:guarded',
        selector: {
          kind: 'compute-pipeline',
          selector: 'guarded',
        },
      },
      {
        id: 'resolvable:rawHelper',
        selector: { kind: 'resolvable', selector: 'rawHelper' },
      },
      {
        id: 'resource:shadowSampler',
        selector: { kind: 'resource', selector: 'shadowSampler' },
      },
      {
        id: 'resource:querySet',
        selector: { kind: 'resource', selector: 'querySet' },
      },
      {
        id: 'resolvable:namedVertex',
        selector: { kind: 'resolvable', selector: 'namedVertex' },
      },
    ]);
  });

  it('reads pipelines and shells reached through a bracket namespace', () => {
    const result = discoverTypeGpuModule(
      '/project/unstable.ts',
      `
        const simulate = tgpu.computeFn({ workgroupSize: [64] })(impl);
        const simulation = root['~unstable'].createComputePipeline({
          compute: simulate,
        });
        const shellHelper = tgpu['~unstable'].fn([d.f32], d.f32)((value) => value);
      `,
    );

    expect(
      result.symbols.find((symbol) => symbol.name === 'simulation'),
    ).toMatchObject({ role: 'compute-pipeline' });
    expect(
      result.targets.find((target) => target.id === 'pipeline:simulation'),
    ).toMatchObject({
      selector: { kind: 'compute-pipeline', selector: 'simulation' },
      pipelineSource: { kind: 'compute-pipeline', compute: 'simulate' },
    });
    expect(
      result.symbols.find((symbol) => symbol.name === 'simulate')?.targetIds,
    ).toEqual(['pipeline:simulation']);
    expect(
      result.symbols.find((symbol) => symbol.name === 'shellHelper'),
    ).toMatchObject({
      role: 'shader-helper',
      probeArguments: ['ctx.d.f32'],
    });
  });

  it('keeps containers of pipelines as collections instead of pipelines', () => {
    const result = discoverTypeGpuModule(
      '/project/containers.ts',
      `
        const passes = configs.map((config) =>
          root.createRenderPipeline({ vertex, fragment })
        );
        const scene = {
          pipeline: root.createRenderPipeline({ vertex, fragment }),
        };
        const chained = root
          .createRenderPipeline({ vertex, fragment })
          .with(layout, buffer);
        const direct = root.createComputePipeline({ compute });
      `,
    );

    expect(result.symbols.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'passes', role: 'resource-collection' },
      { name: 'scene', role: 'resource-collection' },
      { name: 'chained', role: 'render-pipeline' },
      { name: 'direct', role: 'compute-pipeline' },
    ]);
    expect(result.targets.map((target) => target.id)).toEqual([
      'resource:passes',
      'resource:scene',
      'pipeline:chained',
      'pipeline:direct',
    ]);
    expect(
      result.targets.find((target) => target.id === 'pipeline:chained')
        ?.pipelineSource,
    ).toEqual({
      kind: 'render-pipeline',
      vertex: 'vertex',
      fragment: 'fragment',
      bindings: [{ source: 'layout', value: 'buffer' }],
    });
    expect(
      result.symbols.some((symbol) => symbol.pipelineSource !== undefined &&
        (symbol.name === 'passes' || symbol.name === 'scene')),
    ).toBe(false);
  });

  it('ignores pipelines built inside a nested callback of a function', () => {
    const result = discoverTypeGpuModule(
      '/project/nested.ts',
      `
        function setupPasses() {
          return configs.map(() =>
            root.createRenderPipeline({ vertex, fragment })
          );
        }
        const passes = setupPasses();
      `,
    );

    expect(
      result.symbols.some((symbol) => symbol.name === 'setupPasses'),
    ).toBe(false);
    expect(
      result.targets.some((target) => target.id.startsWith('pipeline:')),
    ).toBe(false);
  });

  it('recognizes the unified pipeline constructor and comptime constants', () => {
    const result = discoverTypeGpuModule(
      '/project/unified.ts',
      `
        const computeUnified = root.createPipeline({ compute: simulate });
        const renderUnified = root.createPipeline({
          vertex: mainVertex,
          fragment: mainFragment,
        });
        const gravity = tgpu.comptime(() => 9.81);
      `,
    );

    expect(result.symbols.map(({ name, role }) => ({ name, role }))).toEqual([
      { name: 'computeUnified', role: 'compute-pipeline' },
      { name: 'renderUnified', role: 'render-pipeline' },
      { name: 'gravity', role: 'shader-constant' },
    ]);
    expect(
      result.targets.find((target) => target.id === 'pipeline:computeUnified')
        ?.pipelineSource,
    ).toEqual({ kind: 'compute-pipeline', compute: 'simulate' });
    expect(
      result.targets.find((target) => target.id === 'pipeline:renderUnified')
        ?.pipelineSource,
    ).toEqual({
      kind: 'render-pipeline',
      vertex: 'mainVertex',
      fragment: 'mainFragment',
    });
    expect(
      result.targets.find((target) => target.id === 'resolvable:gravity')
        ?.selector,
    ).toMatchObject({ kind: 'resolvable', selector: 'gravity' });
  });

  it('derives zero-valued accessor bindings for shellless helper probes', () => {
    const result = discoverTypeGpuModule(
      '/project/struct-helper.ts',
      `
        import { HitInfo } from './schemas.ts';
        const hitAccess = tgpu.accessor(HitInfo);
        const thresholdAccess = tgpu.accessor(d.f32, 0.5);
        function shade(hit: d.Infer<typeof HitInfo>) {
          'use gpu';
          return hit.distance + hitAccess.$.distance + thresholdAccess.$;
        }
      `,
    );

    const shade = result.symbols.find((symbol) => symbol.name === 'shade');
    expect(shade).toMatchObject({
      role: 'shader-helper',
      probeArguments: ['module.HitInfo'],
      probeBindings: [{
        slot: 'hitAccess',
        schema: 'module.HitInfo',
      }],
    });
    expect(result.targets.find((target) => target.id === 'resolvable:shade')?.selector)
      .toMatchObject({
        kind: 'resolvable',
        selector: 'shade',
        probeArguments: ['module.HitInfo'],
        probeBindings: [{
          slot: 'hitAccess',
          schema: 'module.HitInfo',
        }],
      });
  });
});
