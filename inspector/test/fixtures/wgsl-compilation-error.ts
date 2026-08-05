// @ts-nocheck
export async function inspect({ tgpu, d }) {
  const badWgsl = tgpu.fn([], d.f32)`() { return definitely_missing_symbol; }`;

  return {
    label: 'wgsl compilation error',
    kind: 'resolvable',
    value: badWgsl,
  };
}
