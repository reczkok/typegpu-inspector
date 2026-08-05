import { d } from 'typegpu';

export type Bounds = d.Infer<typeof Bounds>;
export const Bounds = d.struct({
  min: d.vec3f,
  max: d.vec3f,
});
