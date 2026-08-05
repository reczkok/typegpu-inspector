import { d } from 'typegpu';
import { type Bounds } from './type-only-schema.ts';

export const scalarHelper = (value: number) => {
  'use gpu';
  return value + 1;
};

export const boundsHelper = (bounds: Bounds) => {
  'use gpu';
  return d.vec3f(bounds.max).sub(d.vec3f(bounds.min));
};
