import { d, tgpu } from 'typegpu';
let factoryCalls = 0;
const make = (wide: boolean) => {
  factoryCalls++;
  const offset = wide ? 17 : 3;
  return (uv: d.v2f, scale: number) => {
    'use gpu';
    return uv.x * scale + offset;
  };
};
const wide = make(true);
const narrow = make(false);
const alias = wide;
const calls = tgpu.fn([], d.u32)(() => { 'use gpu'; return d.u32(factoryCalls); });
const compute = tgpu.computeFn({ workgroupSize: [1] })(() => {
  'use gpu';
  wide(d.vec2f(1, 2), d.f32(1));
  narrow(d.vec2f(1, 2), d.f32(1));
});
