import { d, tgpu } from 'typegpu';
const root = await tgpu.init();
const first = root.createSampler({ magFilter: 'nearest' });
const second = root.createSampler({ magFilter: 'linear' });
const pair = (a: d.sampler, b: d.sampler) => { 'use gpu'; return d.f32(1); };
const callFirst = () => { 'use gpu'; return pair(first.$, second.$); };
const callSecond = () => { 'use gpu'; return pair(second.$, first.$); };
const valueAccess = tgpu.accessor(d.f32);
const withAccessor = (value: number) => { 'use gpu'; return value + valueAccess.$; };
const generic = <T extends d.v2f | d.v4f>(value: T) => { 'use gpu'; return value.x; };
const missingArray = (values: number[]) => { 'use gpu'; return values[0]; };
function make() {
  const Local = d.struct({ value: d.f32 });
  const helper = (value: d.Infer<typeof Local>) => { 'use gpu'; return value.value; };
  void helper;
}
make();
void callFirst; void callSecond; void withAccessor; void generic; void missingArray;
