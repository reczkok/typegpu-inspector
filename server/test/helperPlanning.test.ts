import { describe, expect, it } from 'vitest';
import { discoverTypeGpuModule } from '../src/discovery.js';

const discover = (source: string) => discoverTypeGpuModule('/project/helpers.ts', source);
const shader = (source: string, name: string) => discover(source).symbols.find(symbol => symbol.name === name)!;

describe('helper planning coverage matrix', () => {
  it.each([
    ['typed function', `function helper(v: d.v2f) { 'use gpu'; return v; }`, 'helper', 'ctx.d.vec2f'],
    ['inline shell', `const helper = tgpu.fn([d.f32], d.f32)(x => x);`, 'helper', 'ctx.d.f32'],
    ['named shell', `const shell = tgpu.fn([d.u32], d.u32); const helper = shell(x => x);`, 'helper', 'ctx.d.u32'],
    ['nested shell', `function make() { const shell = tgpu.fn([d.i32], d.i32); const helper = shell(x => x); }`, 'make.helper', 'ctx.d.i32'],
    ['captured local schema', `function make() { const Local = d.struct({ x: d.f32 }); const helper = (v: d.Infer<typeof Local>) => { 'use gpu'; return v.x; }; }`, 'make.helper', 'module.Local'],
    ['nested generic', `function make() { const helper = <T extends d.v2f>(v: T) => { 'use gpu'; return v; }; }`, 'make.helper', 'ctx.d.vec2f'],
  ])('%s supplies one schema plan', (_pattern, source, name, schema) => {
    const symbol = shader(source!, name!);
    expect(symbol.probeArgumentPlan).toEqual([{ schema }]);
    expect(symbol.probeContext?.origin).toBe('schema');
    expect(symbol).not.toHaveProperty('probeArguments');
    expect(symbol).not.toHaveProperty('probeBindings');
  });

  it('emits separate complete resource tuples, without constructing hybrid calls', () => {
    const result = discover(`const a = root.createSampler({}); const b = root.createSampler({});
      const c = root.createSampler({}); const e = root.createSampler({});
      const helper = (s: d.sampler, t: d.sampler) => { 'use gpu'; return 1; };
      const callA = () => { 'use gpu'; return helper(a.$, b.$); };
      const callB = () => { 'use gpu'; return helper(c.$, e.$); };`);
    const targets = result.targets.filter(target => target.symbolNames.includes('helper'));
    expect(targets.map(target => 'selector' in target.selector && target.selector.probeArgumentPlan))
      .toEqual([[{ value: 'a.$' }, { value: 'b.$' }], [{ value: 'c.$' }, { value: 'e.$' }]]);
    expect(targets.every(target => 'selector' in target.selector && target.selector.probeContext?.origin === 'call-site')).toBe(true);
  });

  it('keeps calls on the same source line independently addressable', () => {
    const result = discover(`const a = root.createSampler({}); const b = root.createSampler({}); const helper = (s: d.sampler) => { 'use gpu'; return 1; }; const caller = () => { 'use gpu'; helper(a.$); helper(b.$); };`);
    const targets = result.targets.filter(target => target.symbolNames.includes('helper'));
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map(target => target.label)).size).toBe(2);
  });

  it('does not fill resource positions using different incomplete calls', () => {
    const symbol = shader(`const a = root.createSampler({}); const b = root.createSampler({});
      const helper = (s: d.sampler, t: d.sampler) => { 'use gpu'; return 1; };
      const first = (x: d.sampler) => { 'use gpu'; return helper(a.$, x); };
      const second = (x: d.sampler) => { 'use gpu'; return helper(x, b.$); };`, 'helper');
    expect(symbol.probeArgumentPlan).toBeUndefined();
    expect(symbol.probeContext?.missing?.map(input => input.parameter)).toEqual(['s', 't']);
  });

  it('ignores shadowed resource bindings and shadowed helper calls', () => {
    const symbol = shader(`const sampler = root.createSampler({});
      const helper = (s: d.sampler) => { 'use gpu'; return 1; };
      function caller(sampler: d.sampler) { 'use gpu'; return helper(sampler); }
      function cpu() { const helper = (s: unknown) => s; return helper(sampler.$); }`, 'helper');
    expect(symbol.probeArgumentPlan).toBeUndefined();
    expect(symbol.probeContext?.missing?.[0]?.parameter).toBe('s');
  });

  it('does not treat type-only imports as resource argument values', () => {
    const symbol = shader(`import type { sampler } from './resources';
      const helper = (s: d.sampler) => { 'use gpu'; return 1; };
      const caller = () => { 'use gpu'; return helper(sampler); };`, 'helper');
    expect(symbol.probeArgumentPlan).toBeUndefined();
  });

  it('does not take a module shell signature from a shadowed local CPU function', () => {
    const result = discover(`const shell = tgpu.fn([d.f32], d.f32);
      function make() { const shell = (v: number) => v; const result = shell(2); }`);
    expect(result.symbols.some(symbol => symbol.name === 'make.result')).toBe(false);
  });

  it('does not infer a parameter from an identically named nested function parameter', () => {
    const symbol = shader(`const helper = (x: number) => { 'use gpu';
      const inner = (x: number) => { 'use gpu'; return d.u32(x); }; return x; };`, 'helper');
    expect(symbol.probeArgumentPlan).toEqual([{ schema: 'ctx.d.f32' }]);
  });

  it('does not propagate numeric types through shadowed helpers or block-local aliases', () => {
    const result = discover(`const integer = (x: number) => { 'use gpu'; return d.u32(x); };
      const helper = (x: number) => { 'use gpu'; const integer = (v: number) => v; return integer(x); };
      const aliases = (x: number) => { 'use gpu'; { const y = x; } { const y = 1; const z = y << 1; } return x; };`);
    expect(result.symbols.filter(symbol => ['helper', 'aliases'].includes(symbol.name)).map(symbol => symbol.probeArgumentPlan))
      .toEqual([[{ schema: 'ctx.d.f32' }], [{ schema: 'ctx.d.f32' }]]);
  });

  it('preserves duplicate nested names as separate lexical declarations', () => {
    const result = discover(`function make() {
      { const helper = (x: d.v2f) => { 'use gpu'; return x; }; }
      { const helper = (x: d.v4f) => { 'use gpu'; return x; }; }
    }`);
    expect(result.symbols.filter(symbol => symbol.name.startsWith('make.helper')).map(symbol => symbol.probeArgumentPlan))
      .toEqual([[{ schema: 'ctx.d.vec2f' }], [{ schema: 'ctx.d.vec4f' }]]);
  });
});


it.each(['js', 'jsx', 'mjs', 'cjs'])('binds JavaScript %s modules without crashing and resolves named shells', extension => {
  const source = `import { tgpu, d } from 'typegpu';
    const shell = tgpu.fn([d.f32], d.f32);
    export const sample = shell(v => { 'use gpu'; return v; });
  `;
  const discovered = discoverTypeGpuModule(`/project/shaders.${extension}`, source);
  expect(discovered.targets.find(target => target.label === 'sample')?.selector).toMatchObject({
    selector: 'sample', probeArgumentPlan: [{ schema: 'ctx.d.f32' }],
  });
  expect(() => discoverTypeGpuModule(`/project/eslint.config.${extension}`, `import plugin from 'typegpu'; export default [plugin];`)).not.toThrow();
});

describe('caller-derived numeric schemas', () => {
  const inputs = (source: string) => {
    const result = discover(`import { d, tgpu } from 'typegpu';\n${source}`);
    return result.targets.filter(target => target.symbolNames.includes('helper')).map(target => target.selector);
  };
  const parameters = (targets: ReturnType<typeof inputs>) => targets.map(target => 'probeArgumentPlan' in target ? target.probeArgumentPlan : undefined);

  it('keeps complete typed constructor tuples and deduplicates repeated calls', () => {
    const targets = inputs(`
      const helper = (a: number, b: number) => { 'use gpu'; return a + b; };
      const caller = () => { 'use gpu'; helper(d.u32(1), d.i32(2)); helper(d.i32(3), d.u32(4)); helper(d.u32(5), d.i32(6)); };
    `);
    expect(parameters(targets)).toEqual([
      [{ schema: 'ctx.d.u32' }, { schema: 'ctx.d.i32' }],
      [{ schema: 'ctx.d.i32' }, { schema: 'ctx.d.u32' }],
    ]);
    expect(targets.every(target => 'probeContext' in target && target.probeContext?.origin === 'call-site')).toBe(true);
  });

  it.each([
    `({ gid }) => { 'use gpu'; const i = gid.x; const alias = i; helper(alias); }`,
    `input => { 'use gpu'; helper(input.gid.y); }`,
    `({ gid: invocation }) => { 'use gpu'; helper(invocation.z); }`,
  ])('follows builtin input and local const aliases: %s', callback => {
    const targets = inputs(`
      function helper(index: number) { 'use gpu'; return index % 8; }
      const entry = tgpu.computeFn({ workgroupSize: [1], in: { gid: d.builtin.globalInvocationId } })(${callback});
    `);
    expect(parameters(targets)).toEqual([[{ schema: 'ctx.d.u32' }]]);
    expect(targets[0]).toMatchObject({ probeContext: { origin: 'call-site' } });
  });

  it('recognizes imported namespace aliases and scalar vertex inputs', () => {
    const result = discover(`import gpu, { d as data } from 'typegpu';
      const helper = (index: number) => { 'use gpu'; return index; };
      const vertex = gpu.vertexFn({ in: { index: data.builtin.vertexIndex } })(({ index }) => { 'use gpu'; return helper(index); });`);
    expect(result.symbols.find(symbol => symbol.name === 'helper')?.probeArgumentPlan).toEqual([{ schema: 'ctx.d.u32' }]);
  });

  it.each([
    `const cpu = d.u32(4); const caller = () => { 'use gpu'; helper(cpu); };`,
    `const caller = () => { 'use gpu'; let value = d.u32(4); helper(value); };`,
    `const caller = () => { 'use gpu'; const d = { u32: (x: number) => x }; helper(d.u32(4)); };`,
    `const caller = (helper: (x: number) => number) => { 'use gpu'; helper(d.u32(4)); };`,
    `function cpu() { return helper(d.u32(4)); }`,
    `const caller = () => { 'use gpu'; return (() => helper(d.u32(4)))(); };`,
    `const entry = tgpu.computeFn({ in: { gid: d.builtin.globalInvocationId }, ...unknown })(({ gid }) => { 'use gpu'; helper(gid.x); });`,
  ])('keeps the schema fallback without definite shader evidence: %s', caller => {
    const targets = inputs(`const helper = (x: number) => { 'use gpu'; return x; }; ${caller}`);
    expect(parameters(targets)).toEqual([[{ schema: 'ctx.d.f32' }]]);
    expect(targets[0]).toMatchObject({ probeContext: { origin: 'schema' } });
  });

  it('retains a labelled schema probe when other callers are unresolved', () => {
    const targets = inputs(`
      const helper = (x: number) => { 'use gpu'; return x; };
      const caller = (unknown: number) => { 'use gpu'; helper(d.u32(1)); helper(unknown + 1); };
    `);
    expect(parameters(targets)).toEqual([[{ schema: 'ctx.d.u32' }], [{ schema: 'ctx.d.f32' }]]);
    expect(targets[1]).toMatchObject({ label: 'helper(f32 · schema probe)', probeContext: { origin: 'schema' } });
  });

  it('caps caller combinations using the existing specialization limit', () => {
    const calls = ['u32', 'i32', 'f32'].flatMap(a => ['u32', 'i32', 'f32'].map(b => `helper(d.${a}(1), d.${b}(1));`)).join('\n');
    const result = discover(`import {d} from 'typegpu';
      const helper = (a: number, b: number) => { 'use gpu'; return a + b; };
      const caller = () => { 'use gpu'; ${calls} };`);
    expect(result.symbols.find(symbol => symbol.name === 'helper')?.specializationSynthesis).toEqual({ emitted: 8, limit: 8, truncated: true });
  });
});
