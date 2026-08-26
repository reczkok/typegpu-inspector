import { describe, expect, it } from 'vitest';
import { tgpu, d } from 'typegpu';
import {
  TYPEGPU_INTROSPECTION_ADAPTER,
  hasTypegpuInternalSymbol,
  inferTargetKind,
  isAccessorLike,
  isMutableAccessorLike,
  isSlotLike,
  isTypegpuShaderResolvableLike,
  readAccessorSchema,
  readAccessorSlot,
  readBoundFunctionProvidingPairs,
  readMissingSlotFromError,
  readRenderPipelineSlotBindings,
  readResourceType,
  readSlotName,
  readTypegpuFunctionKind,
} from '../src/browser/typegpuIntrospection.ts';

describe('TypeGPU introspection adapter', () => {
  it('documents the TypeGPU private shapes it reads', () => {
    expect(TYPEGPU_INTROSPECTION_ADAPTER).toEqual({
      privateShapes: [
        'resourceType',
        'shell.entryPoint',
        'Symbol(typegpu:*:$resolve)',
        'Symbol(typegpu:*:$soul)',
        'Symbol(typegpu:*:$internal).core.options',
        'Symbol(typegpu:*:$providing).pairs',
        'accessor.slot',
        'accessor.schema',
        'MissingSlotValueError.slot',
        'slot.toString()',
      ],
    });
  });

  it('recognizes real TypeGPU shader and resource objects', () => {
    const helper = tgpu.fn([], d.f32)(() => {
      'use gpu';
      return 1;
    });
    const compute = tgpu.computeFn({ workgroupSize: [1] })(() => {
      'use gpu';
    });
    const layout = tgpu.bindGroupLayout({
      data: { storage: d.arrayOf(d.u32), access: 'mutable' },
    });

    expect(readResourceType(helper)).toBe('function');
    expect(readTypegpuFunctionKind(compute)).toBe('compute');
    expect(hasTypegpuInternalSymbol(helper, '$resolve')).toBe(true);
    expect(isTypegpuShaderResolvableLike(helper)).toBe(true);
    expect(isTypegpuShaderResolvableLike(compute)).toBe(true);
    expect(inferTargetKind(layout)).toBe('resolvable');
    expect(readResourceType(layout)).toBe('bind-group-layout');
  });

  it('recognizes real slots and accessors', () => {
    const bareSlot = tgpu.slot<number>().$name('bare');
    const withDefault = tgpu.slot(7);
    const access = tgpu.accessor(d.f32).$name('paramsAccess');
    const mutableAccess = tgpu.mutableAccessor(d.f32);

    expect(isSlotLike(bareSlot)).toBe(true);
    expect(isSlotLike(withDefault)).toBe(true);
    expect(isSlotLike(access)).toBe(false);
    expect(isAccessorLike(access)).toBe(true);
    expect(isAccessorLike(mutableAccess)).toBe(false);
    expect(isMutableAccessorLike(mutableAccess)).toBe(true);
    expect(isAccessorLike(bareSlot)).toBe(false);

    expect(readAccessorSlot(access)).toBe(access.slot);
    expect(isSlotLike(readAccessorSlot(access))).toBe(true);
    expect(readAccessorSchema(access)).toBe(d.f32);
    expect(readAccessorSlot(bareSlot)).toBeUndefined();

    expect(readSlotName(bareSlot)).toBe('bare');
    expect(readSlotName(tgpu.slot())).toBe('<unnamed>');
    expect(readSlotName(undefined)).toBe('unknown slot');
  });

  it('finds the live slot in an error cause chain', () => {
    const missing = tgpu.slot<number>().$name('missing');
    const inner = Object.assign(new Error("Missing value for 'slot:missing'"), {
      slot: missing,
    });
    const wrapped = new Error('Resolution of the following tree failed', {
      cause: inner,
    });
    const doubleWrapped = new Error('outer', { cause: wrapped });

    expect(readMissingSlotFromError(inner)).toBe(missing);
    expect(readMissingSlotFromError(wrapped)).toBe(missing);
    expect(readMissingSlotFromError(doubleWrapped)).toBe(missing);
  });

  it('fails soft on serialized, cyclic, or shapeless errors', () => {
    const serialized = new Error("Missing value for 'slot:params'");
    expect(readMissingSlotFromError(serialized)).toBeUndefined();

    const cyclic = new Error('a');
    const other = new Error('b', { cause: cyclic });
    cyclic.cause = other;
    expect(readMissingSlotFromError(cyclic)).toBeUndefined();

    expect(readMissingSlotFromError(undefined)).toBeUndefined();
    expect(readMissingSlotFromError({ slot: { resourceType: 'buffer' } })).toBeUndefined();
    expect(readMissingSlotFromError('boom')).toBeUndefined();
  });

  it('reads bindings off bound functions created with fn.with', () => {
    const valueSlot = tgpu.slot<number>().$name('value');
    const base = tgpu.fn([], d.f32)(() => {
      'use gpu';
      return valueSlot.$;
    });
    const bound = base.with(valueSlot, 42);

    const pairs = readBoundFunctionProvidingPairs(bound);
    expect(pairs).toHaveLength(1);
    expect(pairs?.[0]?.[0]).toBe(valueSlot);
    expect(pairs?.[0]?.[1]).toBe(42);

    expect(readBoundFunctionProvidingPairs(base)).toBeUndefined();
    expect(readBoundFunctionProvidingPairs({})).toBeUndefined();
    expect(readBoundFunctionProvidingPairs(undefined)).toBeUndefined();
  });

  it('reads slot bindings off render-pipeline-shaped internals', () => {
    const slot = tgpu.slot<number>();
    const internalSymbol = Symbol('typegpu:whatever:$internal');
    const pipelineLike = {
      [internalSymbol]: { core: { options: { slotBindings: [[slot, 5]] } } },
    };

    expect(readRenderPipelineSlotBindings(pipelineLike)).toEqual([[slot, 5]]);
    expect(
      readRenderPipelineSlotBindings({ [internalSymbol]: { core: { options: {} } } }),
    ).toBeUndefined();
    expect(
      readRenderPipelineSlotBindings({
        [internalSymbol]: { core: { options: { slotBindings: [['not-a-pair']] } } },
      }),
    ).toBeUndefined();
    expect(readRenderPipelineSlotBindings({})).toBeUndefined();
    expect(readRenderPipelineSlotBindings(undefined)).toBeUndefined();
  });
});
