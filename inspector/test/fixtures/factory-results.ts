import { tgpu, d } from 'typegpu';
const calls = { getters: 0, cpu: 0 };
const root = await tgpu.init();
const gain = tgpu.slot<number>();
const compute = tgpu.computeFn({ workgroupSize: [1] })(() => { 'use gpu'; const x = d.f32(gain.$); });
function makeBundle(enabled: boolean) {
  const helper = tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(enabled ? 17 : 31); });
  const bare = () => { 'use gpu'; return d.f32(29); };
  const parameterized = (value: number) => { 'use gpu'; return d.f32(value + 3); };
  const invalid = tgpu.fn([], d.f32)`() -> f32 { return unknown_factory_symbol; }`;
  return {
    ['odd.key']: [helper, bare, parameterized],
    chosen: enabled ? root.with(gain, 23).createComputePipeline({ compute }) : invalid,
    buffer: root.createBuffer(d.f32, 0),
    get dangerous() { calls.getters++; throw new Error('getter was invoked'); },
    cpu() { calls.cpu++; throw new Error('CPU function was invoked'); },
  };
}
const bundle = makeBundle(true);
const alternate = makeBundle(false);
const alias = bundle;
const { chosen } = bundle;
function uncalled() { return tgpu.fn([], d.f32)(() => { 'use gpu'; return d.f32(91); }); }

const untouched = tgpu.fn([], d.u32)(() => { 'use gpu'; return d.u32(calls.getters + calls.cpu); });
