// @ts-nocheck
import tgpu, { d, std } from 'typegpu';

export const lightingSlot = tgpu.slot();

const shadeBase = tgpu.fn([d.vec3f], d.vec3f)((normal) => {
  'use gpu';
  return lightingSlot.$(normal);
});

const phongLighting = tgpu.fn([d.vec3f], d.vec3f)((normal) => {
  'use gpu';
  const lightDir = std.normalize(d.vec3f(0.5, 1, 0.25));
  const diffuse = std.max(std.dot(std.normalize(normal), lightDir), 0);
  return d.vec3f(0.1, 0.1, 0.15) + d.vec3f(1, 0.95, 0.9) * diffuse;
});

// The exported bound function is what makes the bare `shadeBase` target
// inspectable: the inspector borrows lightingSlot's value from it.
export const phongShading = shadeBase.with(lightingSlot, phongLighting);

export async function inspect() {
  return [
    { label: 'bare shading', kind: 'resolvable', value: shadeBase },
    { label: 'sibling helper', kind: 'resolvable', value: phongLighting },
  ];
}
