// @ts-nocheck
import { tgpu, d, std } from 'typegpu';

export const Boid = d.struct({ pos: d.vec3f, vel: d.vec3f });
const layout = tgpu.bindGroupLayout({
  boids: { storage: d.arrayOf(Boid, 64), access: 'mutable' },
});

export const rotateXY = tgpu.fn([d.vec3f, d.f32], d.vec3f)((p, angle) => {
  'use gpu';
  const s = std.sin(angle);
  const c = std.cos(angle);
  return d.vec3f(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
});

export const stepBoid = tgpu.fn([d.u32])((index) => {
  'use gpu';
  const boid = layout.$.boids[index];
  let pos = d.vec3f(boid.pos);
  let vel = d.vec3f(boid.vel);
  for (let i = 0; i < 4; i++) {
    if (std.length(vel) > 2) {
      vel = std.normalize(vel) * 2;
    } else if (i > 2) {
      vel = vel + d.vec3f(0.1);
    }
    pos = pos + vel * 0.016;
  }
  const bounded = std.select(pos, d.vec3f(-1, pos.y, pos.z), pos.x > 1);
  layout.$.boids[index].pos = rotateXY(bounded, 0.01);
  layout.$.boids[index].vel = vel * 1;
});

export const mainCompute = tgpu.computeFn({
  in: { gid: d.builtin.globalInvocationId },
  workgroupSize: [64],
})(({ gid }) => {
  'use gpu';
  if (gid.x >= 64) {
    return;
  }
  stepBoid(gid.x);
});

export const brokenHelper = tgpu.fn([d.u32])((index) => {
  'use gpu';
  const boid = layout.$.boids[index];
  const scaled = boid.vel * 2;
  // References cannot be assigned to `let`: TypeGPU rejects this statement.
  let pos = boid.pos;
  layout.$.boids[index].pos = pos + scaled;
});

export const brokenCompute = tgpu.computeFn({
  in: { gid: d.builtin.globalInvocationId },
  workgroupSize: [64],
})(({ gid }) => {
  'use gpu';
  brokenHelper(gid.x);
});
