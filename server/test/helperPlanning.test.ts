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
