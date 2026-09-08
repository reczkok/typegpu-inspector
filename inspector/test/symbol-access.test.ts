import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { instrumentSymbols } from '../src/inspect/instrumentSymbols.ts';
import * as registry from '../src/browser/symbolRegistry.ts';
import { readSelector } from '../src/browser/symbolRuntime.ts';

let sequence = 0;
function evaluate(source: string, declarations: number[] = []) {
  const path = `/fixture-${sequence++}.ts`;
  const transformed = instrumentSymbols(path, source, './registry', declarations);
  const js = ts.transpileModule(transformed.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported: Record<string, unknown> = {};
  new Function('require', 'exports', js)(() => registry, exported);
  return { path, scope: registry.moduleScope(path, exported), transformed };
}

describe('original lexical symbol access', () => {
  it('preserves inspector roots when overlaying captured locals without eager reads', () => {
    const module = { existing: 7 };
    const locals = { get notInitialized() { throw new Error('TDZ'); }, value: 3 };
    const roots = registry.overlayScope({ ctx: { d: { f32: 'schema' } }, setup: { amount: 19 } }, locals);
    expect(readSelector(module, 'ctx.d.f32', 'schema', roots)).toBe('schema');
    expect(readSelector(module, 'setup.amount', 'input', roots)).toBe(19);
    expect(readSelector(module, 'value', 'local', roots)).toBe(3);
    expect(readSelector(module, 'existing', 'module', roots)).toBe(7);
  });
  it('preserves live bindings, export aliases, identity and name collisions', () => {
    const { scope } = evaluate(`
      const __typegpuInspectorSymbols = 1;
      let privateValue = { slot: {} };
      export { privateValue as publicAlias };
      export function replace() { privateValue = { slot: {} }; }
      const inspect = 42;
    `);
    expect(scope.privateValue).toBe(scope.publicAlias);
    expect(scope.inspect).toBe(42);
    const before = scope.privateValue;
    (scope.replace as () => void)();
    expect(scope.privateValue).not.toBe(before);
    expect(scope.privateValue).toBe(scope.publicAlias);
    expect(Object.keys(scope)).toContain('privateValue');
  });

  it('captures distinct unreturned closures and their lexical schemas', () => {
    const source = `
      function make(radius) {
        const Schema = radius;
        const helper = () => { 'use gpu'; return radius; };
      }
      make(3); make(7);
    `;
    const { path } = evaluate(source, [source.indexOf('helper =')]);
    const declaration = source.indexOf('helper =');
    const instances = registry.selectInstances(path, declaration);
    expect(instances.map(i => (i.value as () => number)())).toEqual([3, 7]);
    expect(instances.map(i => i.scope.Schema)).toEqual([3, 7]);
    expect(registry.selectInstances(path, declaration, 1)[0]?.instance).toBe(1);
    expect(() => registry.selectInstances(path, declaration, 2)).toThrow('available instance indices');
  });

  it('registers hoisted helpers before an early return and leaves GPU bodies unchanged', () => {
    const source = `function make() { return; function helper() { 'use gpu'; const inner = () => 2; return inner(); } } make();`;
    const { path, transformed } = evaluate(source, [source.indexOf('helper()')]);
    expect(registry.selectInstances(path, source.indexOf('helper()'))).toHaveLength(1);
    expect(transformed.code).toContain("function helper() { 'use gpu'; const inner = () => 2; return inner(); }");
    expect(transformed.map.sourcesContent).toEqual([source]);
  });

  it('requires setup when the enclosing scope has not executed', () => {
    const source = `function make() { const helper = () => { 'use gpu'; return 1; }; }`;
    const { path } = evaluate(source, [source.indexOf('helper =')]);
    expect(() => registry.selectInstances(path, source.indexOf('helper ='))).toThrow('Call its enclosing factory');
  });

  it('keeps captured shader objects after reassignment and exposes loop bindings', () => {
    const source = `function make() {
      for (const radius of [3, 7]) {
        let helper = () => { 'use gpu'; return radius; };
        helper = () => 99;
      }
    } make();`;
    const { path } = evaluate(source, [source.indexOf('helper =')]);
    const instances = registry.selectInstances(path, source.indexOf('helper ='));
    expect(instances.map(i => (i.value as () => number)())).toEqual([3, 7]);
    expect(instances.map(i => i.scope.radius)).toEqual([3, 7]);
  });

  it('captures only requested declarations without guessing their constructor', () => {
    const source = `const wrap = (fn) => fn;
      function make() {
        const selected = wrap(() => { 'use gpu'; return 3; });
        const unrelated = () => { 'use gpu'; return 7; };
      } make();`;
    const { path } = evaluate(source, [source.indexOf('selected =')]);
    expect(registry.selectInstances(path, source.indexOf('selected ='))).toHaveLength(1);
    expect(() => registry.selectInstances(path, source.indexOf('unrelated ='))).toThrow('no runtime instance');
  });
});
