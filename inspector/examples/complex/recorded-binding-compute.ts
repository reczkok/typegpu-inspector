// @ts-nocheck
export async function inspect({ root, tgpu, d, std }) {
  // A bare slot: no default, no accessor schema, no exported bound function.
  // The ONLY place its value exists is the root.with(...) call below — which
  // the recording shim observes, making both targets inspectable.
  const amplitudeSlot = tgpu.slot();

  const wave = tgpu.fn([d.f32], d.f32)((x) => {
    'use gpu';
    return std.sin(x) * amplitudeSlot.$;
  });

  const output = root.createMutable(d.arrayOf(d.f32, 64));

  const step = tgpu.computeFn({
    workgroupSize: [16],
    in: { gid: d.builtin.globalInvocationId },
  })(({ gid }) => {
    'use gpu';
    output.$[gid.x] = wave(d.f32(gid.x));
  });

  const pipeline = root.with(amplitudeSlot, 2.5).createComputePipeline({ compute: step });

  return [
    { label: 'recorded pipeline', kind: 'compute-pipeline', value: pipeline },
    { label: 'bare wave helper', kind: 'resolvable', value: wave },
  ];
}
