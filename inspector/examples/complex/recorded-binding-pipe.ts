// @ts-nocheck
export async function inspect({ root, tgpu, d, std }) {
  // Two bare slots whose only values come through root.pipe(...): one bound
  // inside the transform, one on the branch pipe returns. The recording shim
  // has to follow pipe for either to be observable.
  const amplitudeSlot = tgpu.slot();
  const gainSlot = tgpu.slot();

  const wave = tgpu.fn([d.f32], d.f32)((x) => {
    'use gpu';
    return std.sin(x) * amplitudeSlot.$ + gainSlot.$;
  });

  const output = root.createMutable(d.arrayOf(d.f32, 64));

  const step = tgpu.computeFn({
    workgroupSize: [16],
    in: { gid: d.builtin.globalInvocationId },
  })(({ gid }) => {
    'use gpu';
    output.$[gid.x] = wave(d.f32(gid.x));
  });

  const pipeline = root
    .pipe((configurable) => configurable.with(amplitudeSlot, 2.5))
    .with(gainSlot, 3.5)
    .createComputePipeline({ compute: step });

  return [
    { label: 'piped pipeline', kind: 'compute-pipeline', value: pipeline },
    { label: 'bare wave helper', kind: 'resolvable', value: wave },
  ];
}
