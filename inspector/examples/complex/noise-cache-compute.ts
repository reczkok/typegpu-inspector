// @ts-nocheck
import { perlin2d, randf } from '@typegpu/noise';

export async function inspect({ root, tgpu, d, std }) {
  const Particle = d.struct({
    position: d.vec2f,
    velocity: d.vec2f,
    energy: d.f32,
  });

  const Params = d.struct({
    time: d.f32,
    scale: d.f32,
    count: d.u32,
  });

  const particles = root.createMutable(
    d.arrayOf(Particle, 64),
    Array.from({ length: 64 }, (_, i) => ({
      position: d.vec2f((i % 8) / 8, Math.floor(i / 8) / 8),
      velocity: d.vec2f(0, 0),
      energy: 0.25,
    })),
  );

  const params = root.createUniform(Params, {
    time: 0.125,
    scale: 3.5,
    count: 64,
  });

  const seedScaleSlot = tgpu.slot(0.013);
  const cache = perlin2d.staticCache({ root, size: d.vec2u(16, 16) });

  const update = tgpu.computeFn({
    workgroupSize: [8],
    in: { gid: d.builtin.globalInvocationId },
  })(({ gid }) => {
    'use gpu';
    const index = gid.x;
    if (index >= params.$.count) {
      return;
    }

    const particle = particles.$[index];
    randf.seed2(d.vec2f(index, params.$.time) * seedScaleSlot.$);

    const jitter = randf.inUnitCircle() * 0.025;
    const samplePos = (particle.position + jitter) * params.$.scale + d.vec2f(params.$.time);
    const noise = perlin2d.sample(samplePos);
    const angle = noise * 6.28318530718;
    const force = d.vec2f(std.cos(angle), std.sin(angle)) * 0.02;

    particles.$[index].velocity = particle.velocity * 0.96 + force;
    particles.$[index].position = particle.position + particles.$[index].velocity;
    particles.$[index].energy = std.clamp(particle.energy + noise * 0.03, 0, 1);
  });

  return {
    label: 'perlin cache particle compute',
    kind: 'compute-pipeline',
    value: root
      .with(seedScaleSlot, 0.021)
      .pipe(cache.inject())
      .createComputePipeline({ compute: update }),
  };
}
