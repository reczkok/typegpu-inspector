import tgpu from 'typegpu';
import * as d from 'typegpu/data';
import { config } from './shared.ts';
export const shade = tgpu.fn([], d.f32)(() => { 'use gpu'; return config; });
