// @ts-nocheck
export async function inspect({ root, tgpu, d, std }) {
  const Body = d.struct({
    position: d.vec2f,
    velocity: d.vec2f,
    mass: d.f32,
  });

  const SimParams = d.struct({
    dt: d.f32,
    count: d.u32,
    damping: d.f32,
  });

  const bodies = root.createMutable(
    d.arrayOf(Body, 128),
    Array.from({ length: 128 }, (_, i) => ({
      position: d.vec2f((i % 16) / 16 - 0.5, Math.floor(i / 16) / 8 - 0.5),
      velocity: d.vec2f(0, 0),
      mass: 0.5 + (i % 7) * 0.125,
    })),
  );

  const params = root.createUniform(SimParams, {
    dt: 1 / 60,
    count: 128,
    damping: 0.985,
  });

  const gravityForce = tgpu.fn([d.vec2f, d.f32], d.vec2f)((_position, mass) => {
    'use gpu';
    return d.vec2f(0, -9.8) * mass;
  });

  const vortexForce = tgpu.fn([d.vec2f, d.f32], d.vec2f)((position, mass) => {
    'use gpu';
    const tangent = d.vec2f(-position.y, position.x);
    const falloff = 1 / std.max(std.dot(position, position), 0.08);
    return std.normalize(tangent) * falloff * mass;
  });

  const attractorForce = tgpu.fn([d.vec2f, d.f32], d.vec2f)((position, mass) => {
    'use gpu';
    const toCenter = -position;
    const distance = std.max(std.length(toCenter), 0.05);
    return std.normalize(toCenter) * (mass / (distance * distance));
  });

  const forceSlot = tgpu.slot(gravityForce);

  const integrateBody = tgpu.fn([d.u32])((index) => {
    'use gpu';
    const body = bodies.$[index];
    const acceleration = forceSlot.$(body.position, body.mass) / std.max(body.mass, 0.0001);
    const nextVelocity = (body.velocity + acceleration * params.$.dt) * params.$.damping;

    bodies.$[index].velocity = d.vec2f(nextVelocity);
    bodies.$[index].position = d.vec2f(body.position + nextVelocity * params.$.dt);
  });

  const step = tgpu.computeFn({
    workgroupSize: [16],
    in: { gid: d.builtin.globalInvocationId },
  })(({ gid }) => {
    'use gpu';
    if (gid.x >= params.$.count) {
      return;
    }
    integrateBody(gid.x);
  });

  return [
    {
      label: 'slot integrator gravity',
      kind: 'compute-pipeline',
      value: root.with(forceSlot, gravityForce).createComputePipeline({ compute: step }),
    },
    {
      label: 'slot integrator vortex',
      kind: 'compute-pipeline',
      value: root.with(forceSlot, vortexForce).createComputePipeline({ compute: step }),
    },
    {
      label: 'slot integrator attractor',
      kind: 'compute-pipeline',
      value: root.with(forceSlot, attractorForce).createComputePipeline({ compute: step }),
    },
  ];
}
