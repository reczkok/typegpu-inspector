import { describe, expect, it } from 'vitest';
import { createInspectionDocumentHtml } from '../src/documentFixture.js';

describe('createInspectionDocumentHtml', () => {
  it('materializes statically requested browser elements with useful tags', () => {
    const html = createInspectionDocumentHtml(
      '/project/example.ts',
      `
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        const score = document.getElementById('score') as HTMLElement;
        const reset = document.getElementById('reset-button') as HTMLButtonElement;
        const slider = document.querySelector<HTMLInputElement>('#time-scale');
        const panel = document.querySelector('.controls');
      `,
    );

    expect(html).toContain(
      '<canvas width="64" height="64" data-typegpu-inspector-fixture></canvas>',
    );
    expect(html).toContain('<div id="score"></div>');
    expect(html).toContain('<button id="reset-button" type="button"></button>');
    expect(html).toContain('<input id="time-scale">');
    expect(html).toContain('<div class="controls"></div>');
  });

  it('escapes discovered ids before inserting them into the fixture', () => {
    const html = createInspectionDocumentHtml(
      '/project/example.ts',
      `document.getElementById('score"board');`,
    );

    expect(html).toContain('id="score&quot;board"');
    expect(html).not.toContain('id="score"board"');
  });

  it('uses one canvas when the module requests an identified canvas', () => {
    const html = createInspectionDocumentHtml(
      '/project/example.ts',
      `document.getElementById('viewport') as HTMLCanvasElement;`,
    );

    expect(html.match(/<canvas/g)).toHaveLength(1);
    expect(html).toContain('<canvas id="viewport"');
  });
});
