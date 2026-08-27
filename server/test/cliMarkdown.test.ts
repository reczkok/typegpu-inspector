import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/cliMarkdown.js';
import { colors } from '../src/cliOutput.js';

describe('Markdown on a terminal', () => {
  const plain = colors(false);

  it('turns headings, emphasis, links, and fences into plain text', () => {
    const rendered = renderMarkdown(
      [
        '### TypeGPU · shader helper `shade`',
        '',
        '**✓ WGSL validated**',
        '',
        '[Open generated WGSL](file:///workspace/out/main__shade.wgsl) · 7 lines',
        '',
        '```wgsl',
        'fn shade() {}',
        '```',
        '',
        '_1 WGSL line omitted._',
        '---',
        '| a | b |',
      ].join('\n'),
      plain,
      '/workspace',
    );
    expect(rendered).toEqual([
      'TypeGPU · shader helper shade',
      '',
      '✓ WGSL validated',
      '',
      'Open generated WGSL → out/main__shade.wgsl · 7 lines',
      '',
      '── wgsl ──',
      'fn shade() {}',
      '──',
      '',
      '1 WGSL line omitted.',
      '──',
      '| a | b |',
    ]);
  });

  it('keeps underscores inside identifiers', () => {
    expect(renderMarkdown('`@0:0` `my_buffer` · storage read_write', plain, '/w')).toEqual([
      '@0:0 my_buffer · storage read_write',
    ]);
  });
});
