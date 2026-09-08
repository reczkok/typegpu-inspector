import { tgpu, d } from 'typegpu';
import { describe, expect, it } from 'vitest';
import { selectResultMembers } from '../src/browser/resultTargets.ts';

const shader = { resourceType: 'function' };
describe('actual result members', () => {
  it('keeps exact paths and identity through arrays, aliases, cycles and computed keys', () => {
    const root: Record<string, unknown> = { 'odd.key': [shader], alias: shader };
    root.cycle = root;
    const result = selectResultMembers(root);
    expect(result.map(member => member.path)).toEqual([['odd.key', '0'], ['alias']]);
    expect(result.every(member => member.value === shader)).toBe(true);
    expect(selectResultMembers(root, ['odd.key', '0'])[0]?.value).toBe(shader);
    expect(selectResultMembers(root, ['odd', 'key'])[0]?.error).toBeDefined();
  });
  it('does not evaluate getters, CPU functions or arbitrary class instances', () => {
    let calls = 0;
    const result = selectResultMembers({
      shader,
      get getter() { calls++; return shader; },
      cpu() { calls++; return shader; },
      object: new class { nested = shader; get resourceType() { calls++; return 'function'; } }(),
      marker: { get resourceType() { calls++; return 'function'; } },
    });
    expect(calls).toBe(0);
    expect(result.filter(member => member.error).map(member => member.path)).toEqual([['getter'], ['marker', 'resourceType']]);
    expect(selectResultMembers({ get x() { calls++; return shader; } }, ['x'])[0]?.error).toBeDefined();
    expect(calls).toBe(0);
  });
  it('reports limits instead of silently certifying partial coverage', () => {
    for (const root of [Array(200).fill(shader), Array(3000).fill(1)]) {
      const result = selectResultMembers(root);
      expect(result.at(-1)?.error).toBeDefined();
      expect(result.length).toBeLessThanOrEqual(129);
    }
    let deep: unknown = shader;
    for (let i = 0; i < 14; i++) deep = { deep };
    expect(selectResultMembers(deep)[0]?.error).toBeDefined();
  });
  it('does not invoke an uncalled factory', () => {
    let calls = 0;
    expect(selectResultMembers(() => { calls++; return shader; })[0]?.error).toBeDefined();
    expect(calls).toBe(0);
    const factory = () => tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(1); });
    expect(selectResultMembers(factory)[0]?.error).toBeDefined();
    expect(selectResultMembers({ schema: d.struct({ x: d.f32 }) })[0]?.kind).toBe('resource');
  });
});
