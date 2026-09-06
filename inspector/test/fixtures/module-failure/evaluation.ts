import tgpu from 'typegpu';
import { config } from './shared.ts';
export async function createRenderer() {
  const root = await tgpu.init();
  return { root, config };
}
