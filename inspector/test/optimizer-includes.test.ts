import { describe, expect, it } from 'vitest';
import { collectOptimizerIncludes } from '../src/inspect/vite.ts';

describe('collectOptimizerIncludes', () => {
  it('keeps value imports and dynamic imports of bare specifiers', () => {
    const includes = collectOptimizerIncludes(
      '/project/src/water.ts',
      [
        "import tgpu from 'typegpu';",
        "import * as d from 'typegpu/data';",
        "import { mat4 } from 'wgpu-matrix';",
        "import './setup.ts';",
        "import styles from '/abs/path.css';",
        "const lazy = await import('three');",
      ].join('\n'),
    );
    expect(includes).toEqual(['wgpu-matrix', 'three']);
  });

  it('leaves type-only imports out, whether on the clause or on every specifier', () => {
    const includes = collectOptimizerIncludes(
      '/project/src/water.ts',
      [
        "import type { RNCanvasContext } from 'react-native-webgpu';",
        "import { type GPUCanvasContext, type Other } from 'react-native-wgpu';",
        "import { type Only, value } from 'mixed';",
        "import Default, { type Named } from 'default-and-type';",
      ].join('\n'),
    );
    expect(includes).toEqual(['mixed', 'default-and-type']);
  });

  it('expands react to its JSX runtimes', () => {
    expect(collectOptimizerIncludes('/project/src/app.tsx', "import React from 'react';")).toEqual([
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
    ]);
  });
});
