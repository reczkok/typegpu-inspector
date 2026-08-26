// @ts-nocheck
import { tgpu, d } from 'typegpu';

const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('fixture expected a canvas before import');
}

if (window.__TYPEGPU_MCP_FIXTURE_VALUE !== 'ready') {
  throw new Error('fixture expected browserSetup to run before import');
}

const assetText = await fetch('/fixtures/mock.txt').then((response) => response.text());

export async function inspect() {
  const helper = tgpu.fn([], d.f32)(() => {
    'use gpu';
    return 1;
  });

  return {
    label: `dom ${canvas.width} asset ${assetText.trim()}`,
    kind: 'resolvable',
    value: helper,
  };
}
