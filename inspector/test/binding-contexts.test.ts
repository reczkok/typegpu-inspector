import { expect, it } from 'vitest';
import { tgpu, d } from 'typegpu';
import { collectBindingContexts, contextBinds, contextualize } from '../src/browser/bindingContexts.ts';

it('keeps correlated pairs together, and preserves override order', () => {
  const a = tgpu.slot<number>(); const b = tgpu.slot<number>();
  const shader = () => {};
  const contexts = collectBindingContexts([], { uniforms: [], pipelines: [
    { kind: 'compute', pipeline: {}, descriptor: { compute: shader }, slotPairs: [[a, 1], [b, 10], [a, 2]] },
    { kind: 'compute', pipeline: {}, descriptor: { compute: shader }, slotPairs: [[a, 3], [b, 30]] },
  ] });
  expect(contexts.map(context => context.pairs.map(pair => pair[1]))).toEqual([[1, 10, 2], [3, 30]]);
  expect(contextualize({ value: shader, label: 'shader' }, contexts[0]!)).toMatchObject({ autoBind: false, context: { usage: 0, association: 'direct' }, bindingProvider: 'observed-context' });
  expect(contextualize({ value: () => {}, label: 'helper' }, contexts[1]!)).toMatchObject({ autoBind: false, context: { association: 'candidate' }, bindingProvider: 'recorded-app-bindings' });
});

it('associates bound functions with their inner helper and matches accessors by slot identity', () => {
  const access = tgpu.accessor(d.f32);
  const helper = tgpu.fn([], d.f32)(() => 1);
  const bound = helper.with(access, 12);
  const contexts = collectBindingContexts([{ value: { bound }, origin: 'module-scope' }]);
  expect(contexts).toHaveLength(1);
  expect(contextBinds(contexts[0]!, access.slot)).toBe(true);
  expect(contextBinds(contexts[0]!, tgpu.slot())).toBe(false);
  expect(contextualize({ value: helper }, contexts[0]!).context?.association).toBe('direct');
});
