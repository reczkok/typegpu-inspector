import { describe, expect, it } from 'vitest';
import { analyzeWgsl, formatByteSize } from '../src/wgsl.js';

describe('analyzeWgsl', () => {
  it('extracts declarations and bindings regardless of attribute order', () => {
    const wgsl = `
struct Params {
  scale: f32,
}

@group(0) @binding(2) var<uniform> params: Params;
@binding(0) @group(1) var outputTex: texture_storage_2d<rgba8unorm, write>;

const factor = 2.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
}
`.trim();

    const result = analyzeWgsl(wgsl);

    expect(result.bindings).toEqual([
      {
        group: 0,
        binding: 2,
        name: 'params',
        addressSpace: 'uniform',
        type: 'Params',
      },
      {
        group: 1,
        binding: 0,
        name: 'outputTex',
        type: 'texture_storage_2d<rgba8unorm, write>',
      },
    ]);
    expect(result.declarations.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: 'struct', name: 'Params' },
      { kind: 'var', name: 'params' },
      { kind: 'var', name: 'outputTex' },
      { kind: 'const', name: 'factor' },
      { kind: 'fn', name: 'main' },
    ]);
    expect(result.utf8Bytes).toBe(Buffer.byteLength(wgsl));
    expect(result.entryPoints).toEqual([{
      name: 'main',
      stage: 'compute',
      line: 10,
      workgroupSize: ['8', '8', '1'],
      workgroupInvocations: 64,
    }]);
  });

  it('counts static shader operations without counting comments', () => {
    const wgsl = `
// textureSample(fakeTexture, fakeSampler, fakeUv);
/* atomicAdd(&fake, 1u);
   /* textureStore(fakeTexture, vec2u(), vec4f()); */
*/
@vertex
fn vertexMain() -> @builtin(position) vec4f {
  return vec4f();
}

@workgroup_size(4, 2, 2) @compute
fn computeMain() {
  let a = textureSample(inputTex, linearSampler, uv);
  let b = textureSampleLevel(inputTex, linearSampler, uv, 0);
  let c = textureGather(inputTex, linearSampler, uv);
  let d = textureLoad(inputTex, vec2i(), 0);
  textureStore(outputTex, vec2i(), a);
  atomicAdd(&counter, 1u);
  workgroupBarrier();
  let dx = dpdx(a.x);
  if (dx > 0) { discard; }
  for (var i = 0; i < 2; i++) {}
  loop { break; }
  switch i { default: {} }
}
`.trim();

    const result = analyzeWgsl(wgsl);

    expect(result.entryPoints).toMatchObject([
      { name: 'vertexMain', stage: 'vertex' },
      {
        name: 'computeMain',
        stage: 'compute',
        workgroupSize: ['4', '2', '2'],
        workgroupInvocations: 16,
      },
    ]);
    expect(result.operations).toEqual({
      textureSamples: 3,
      textureLoads: 1,
      textureStores: 1,
      atomics: 1,
      barriers: 1,
      derivatives: 1,
      discards: 1,
      loops: 2,
      branches: 2,
    });
  });
});

describe('analyzeWgsl performance', () => {
  it('stays fast and reports correct line numbers for thousands of declarations', () => {
    const declarationCount = 5_000;
    const lines: string[] = [];
    for (let index = 0; index < declarationCount; index += 1) {
      lines.push(`const value${index} = ${index}.0;`);
    }
    const entryPointLine = declarationCount + 2;
    lines.push(
      '',
      '@compute @workgroup_size(4, 4, 1)',
      'fn mainCompute(@builtin(global_invocation_id) gid: vec3u) {',
      '  let noop = 0;',
      '}',
    );
    const wgsl = lines.join('\n');

    const result = analyzeWgsl(wgsl);

    expect(result.declarations).toHaveLength(declarationCount + 1);
    const constDeclarations = result.declarations.slice(0, declarationCount);
    expect(constDeclarations.map((declaration) => declaration.line)).toEqual(
      Array.from({ length: declarationCount }, (_, index) => index + 1),
    );
    expect(constDeclarations[0]).toMatchObject({
      kind: 'const',
      name: 'value0',
      line: 1,
    });
    expect(constDeclarations[declarationCount - 1]).toMatchObject({
      kind: 'const',
      name: `value${declarationCount - 1}`,
      line: declarationCount,
    });
    expect(result.declarations[declarationCount]).toMatchObject({
      kind: 'fn',
      name: 'mainCompute',
    });
    expect(result.entryPoints).toHaveLength(1);
    expect(result.entryPoints[0]).toMatchObject({
      name: 'mainCompute',
      line: entryPointLine,
    });
    expect(result.characters).toBe([...wgsl].length);
  });
});

describe('formatByteSize', () => {
  it('uses compact decimal units', () => {
    expect(formatByteSize(742)).toBe('742 B');
    expect(formatByteSize(1_250)).toBe('1.3 kB');
  });
});
