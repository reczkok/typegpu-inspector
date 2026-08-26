import { describe, expect, it } from 'vitest';
import {
  discoverTypeGpuModule,
  type DiscoveredSymbol,
  type InspectionTarget,
} from '../src/discovery.js';
import type { InspectorStatementMap } from '../src/protocol.js';
import { mapResolutionFailure, mapWgslDiagnostic } from '../src/sourceMapping.js';
import {
  offsetOnLine,
  sourceRangeOnLine,
  statementMap,
  statementMapSource,
  statementMapWgsl,
} from './fixtures/statementMapFixture.js';

describe('WGSL diagnostic source mapping', () => {
  it('maps a uniquely selected generated identifier to its exact TS token', () => {
    const source =
      'export const badWgsl = tgpu.fn([], d.f32)`() { return definitely_missing_symbol; }`;';
    const discovered = discoverTypeGpuModule('/workspace/bad.ts', source);
    const wgsl = 'fn badWgsl() -> f32 { return definitely_missing_symbol; }';
    const offset = wgsl.indexOf('definitely_missing_symbol');
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: "unresolved value 'definitely_missing_symbol'",
        offset,
        length: 'definitely_missing_symbol'.length,
        lineNum: 1,
        linePos: offset + 1,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'generated-token',
      sourceSymbol: 'badWgsl',
      generatedToken: 'definitely_missing_symbol',
      generatedDeclaration: { kind: 'fn', name: 'badWgsl' },
    });
    expect(mapping.sourceRange).toEqual({
      start: { line: 0, character: source.indexOf('definitely_missing_symbol') },
      end: {
        line: 0,
        character: source.indexOf('definitely_missing_symbol') +
          'definitely_missing_symbol'.length,
      },
    });
  });

  it('maps a diagnostic-named callee selected as a whole call expression', () => {
    const source = `
export const postProcessFragment = tgpu.fragmentFn({
  in: { position: d.builtin.position },
  out: d.vec4f,
})(({ position }) => {
  'use gpu';
  if (position.x > material.$.splitPosition) {
    return std.textureSample(sceneTexture.$, linearSampler.$, position.xy);
  }
  return d.vec4f();
});`;
    const discovered = discoverTypeGpuModule('/workspace/post-process.ts', source);
    const wgsl = `@fragment
fn postProcessFragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  if ((position.x > material.splitPosition)) {
    return textureSample(sceneTexture, linearSampler, position.xy);
  }
  return vec4f();
}`;
    const selected = 'textureSample(sceneTexture, linearSampler, position.xy)';
    const offset = wgsl.indexOf(selected);
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: "'textureSample' must only be called from uniform control flow",
        offset,
        length: selected.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'generated-token',
      sourceSymbol: 'postProcessFragment',
      generatedToken: 'textureSample',
      generatedDeclaration: { kind: 'fn', name: 'postProcessFragment' },
    });
    expect(mapping.sourceRange).toEqual({
      start: { line: 7, character: 15 },
      end: { line: 7, character: 28 },
    });
  });

  it('maps the call callee when a whole call is selected without naming it', () => {
    const source =
      'export const helper = tgpu.fn([], d.vec4f)`() { return textureSample(tex, samp, uv); }`;';
    const discovered = discoverTypeGpuModule('/workspace/helper.ts', source);
    const wgsl =
      'fn helper() -> vec4f { return textureSample(tex, samp, uv); }';
    const selected = 'textureSample(tex, samp, uv)';
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: 'derivative operation requires uniform control flow',
        offset: wgsl.indexOf(selected),
        length: selected.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'generated-token',
      generatedToken: 'textureSample',
    });
    expect(mapping.sourceRange).toEqual({
      start: { line: 0, character: source.indexOf('textureSample') },
      end: {
        line: 0,
        character: source.indexOf('textureSample') + 'textureSample'.length,
      },
    });
  });

  it('expands a missing-length caret to its generated and source identifiers', () => {
    const source =
      'export const badWgsl = tgpu.fn([], d.f32)`() { return missingValue; }`;';
    const discovered = discoverTypeGpuModule('/workspace/bad.ts', source);
    const wgsl = 'fn badWgsl() -> f32 {\n  return missingValue;\n}';
    const tokenOffset = wgsl.indexOf('missingValue');
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: 'unresolved identifier',
        lineNum: 2,
        linePos: tokenOffset - wgsl.lastIndexOf('\n', tokenOffset),
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'generated-token',
      generatedToken: 'missingValue',
      generatedRange: {
        start: { line: 1, character: 9 },
        end: { line: 1, character: 21 },
      },
    });
  });

  it('maps through TypeGPU collision suffixes on generated declarations', () => {
    const source =
      'export const helper = tgpu.fn([], d.f32)`() { return missingValue; }`;';
    const discovered = discoverTypeGpuModule('/workspace/helper.ts', source);
    const wgsl = 'fn helper_1() -> f32 { return missingValue; }';
    const offset = wgsl.indexOf('missingValue');
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: "unresolved value 'missingValue'",
        offset,
        length: 'missingValue'.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'generated-token',
      sourceSymbol: 'helper',
      generatedToken: 'missingValue',
      generatedDeclaration: { name: 'helper_1' },
    });
  });

  it('associates an anonymous generated entrypoint by shader stage', () => {
    const source = `export const fragment = tgpu.fragmentFn({
  in: { position: d.builtin.position },
  out: d.vec4f,
})(({ position }) => {
  'use gpu';
  return std.textureSample(tex.$, sampler.$, position.xy);
});`;
    const discovered = discoverTypeGpuModule('/workspace/fragment.ts', source);
    const wgsl = `@fragment fn item(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureSample(tex, sampler, position.xy);
}`;
    const selected = 'textureSample(tex, sampler, position.xy)';
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: "'textureSample' must only be called from uniform control flow",
        offset: wgsl.indexOf(selected),
        length: selected.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'generated-token',
      sourceSymbol: 'fragment',
      generatedToken: 'textureSample',
      generatedDeclaration: { name: 'item' },
    });
  });

  it('maps control-flow keywords selected by compiler notes', () => {
    const source = `export const fragment = tgpu.fragmentFn({ out: d.vec4f })(() => {
  'use gpu';
  if (condition.$) return d.vec4f(1);
  return d.vec4f();
});`;
    const discovered = discoverTypeGpuModule('/workspace/fragment.ts', source);
    const wgsl = `@fragment fn item() -> @location(0) vec4f {
  if (condition) { return vec4f(1); }
  return vec4f();
}`;
    const offset = wgsl.indexOf('if');
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'info',
        message: 'control flow depends on possibly non-uniform value',
        offset,
        length: 2,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'generated-token',
      sourceSymbol: 'fragment',
      generatedToken: 'if',
    });
    expect(mapping.sourceRange).toEqual({
      start: { line: 2, character: 2 },
      end: { line: 2, character: 4 },
    });
  });

  it('ordinal-maps repeated parameters and body references', () => {
    const source = `export const fragment = tgpu.fragmentFn({
  in: { position: d.builtin.position },
  out: d.vec4f,
})(({ position }) => {
  'use gpu';
  const uv = position.xy;
  if (position.x > 1) return d.vec4f(uv, 0, 1);
  return d.vec4f();
});`;
    const discovered = discoverTypeGpuModule('/workspace/fragment.ts', source);
    const wgsl = `@fragment fn item(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy;
  if (position.x > 1) { return vec4f(uv, 0, 1); }
  return vec4f();
}`;
    const offset = wgsl.lastIndexOf('position');
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'info',
        message: "builtin 'position' of 'item' may be non-uniform",
        offset,
        length: 'position'.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'medium',
      strategy: 'generated-token-ordinal',
      sourceSymbol: 'fragment',
      generatedToken: 'position',
    });
    expect(mapping.sourceRange).toEqual({
      start: { line: 6, character: 6 },
      end: { line: 6, character: 14 },
    });
  });

  it('maps compatible operators while retaining their authored width', () => {
    const source = `export const helper = (a: number, b: number) => {
  'use gpu';
  return a === b;
};`;
    const discovered = discoverTypeGpuModule('/workspace/helper.ts', source);
    const wgsl = `fn helper(a: f32, b: f32) -> bool {
  return a == b;
}`;
    const offset = wgsl.indexOf('==');
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: 'operands do not have matching types',
        offset,
        length: 2,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'generated-token',
      sourceSymbol: 'helper',
      generatedToken: '==',
    });
    expect(mapping.sourceRange).toEqual({
      start: { line: 2, character: 11 },
      end: { line: 2, character: 14 },
    });
  });

  it('maps inline pipeline shaders through a unique pipeline association', () => {
    const source = `export const pipeline = root.createRenderPipeline({
  vertex: common.fullScreenTriangle,
  fragment: ({ position }) => {
    'use gpu';
    return std.textureSample(tex.$, sampler.$, position.xy);
  },
  targets: { format: 'bgra8unorm' },
});`;
    const discovered = discoverTypeGpuModule('/workspace/pipeline.ts', source);
    const wgsl = `@fragment fn item(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return textureSample(tex, sampler, position.xy);
}`;
    const selected = 'textureSample(tex, sampler, position.xy)';
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: "'textureSample' must only be called from uniform control flow",
        offset: wgsl.indexOf(selected),
        length: selected.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'medium',
      strategy: 'generated-token',
      sourceSymbol: 'pipeline',
      generatedToken: 'textureSample',
      generatedDeclaration: { name: 'item' },
    });
    expect(mapping.sourceRange).toEqual({
      start: { line: 4, character: 15 },
      end: { line: 4, character: 28 },
    });
  });

  it('maps repeated tokens by ordinal only when occurrence counts agree', () => {
    const source =
      'export const helper = tgpu.fn([], d.f32)`() { firstCall(); firstCall(); return 0; }`;';
    const discovered = discoverTypeGpuModule('/workspace/helper.ts', source);
    const wgsl = 'fn helper() -> f32 { firstCall(); firstCall(); return 0; }';
    const offset = wgsl.lastIndexOf('firstCall');
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: "invalid call to 'firstCall'",
        offset,
        length: 'firstCall'.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'medium',
      strategy: 'generated-token-ordinal',
      sourceSymbol: 'helper',
      generatedToken: 'firstCall',
    });
    expect(mapping.sourceRange).toEqual({
      start: { line: 0, character: source.lastIndexOf('firstCall') },
      end: {
        line: 0,
        character: source.lastIndexOf('firstCall') + 'firstCall'.length,
      },
    });
  });

  it('does not guess when a selected expression names multiple identifiers', () => {
    const source =
      'export const helper = tgpu.fn([], d.f32)`() { return first(second); }`;';
    const discovered = discoverTypeGpuModule('/workspace/helper.ts', source);
    const wgsl = 'fn helper() -> f32 { return first(second); }';
    const selected = 'first(second)';
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: "invalid use of 'first' with 'second'",
        offset: wgsl.indexOf(selected),
        length: selected.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'medium',
      strategy: 'declaration-name',
      sourceSymbol: 'helper',
    });
    expect(mapping.generatedToken).toBeUndefined();
  });

  it('does not choose between ambiguous source declarations', () => {
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 6 },
    };
    const symbols: DiscoveredSymbol[] = ['first', 'second'].map((name) => ({
      name,
      runtimeName: 'shared',
      role: 'shader-helper',
      range,
      targetIds: ['resolvable:shared'],
    }));
    const target: InspectionTarget = {
      id: 'resolvable:shared',
      label: 'shared',
      selector: {
        kind: 'resolvable',
        selector: 'shared',
        label: 'shared',
      },
      symbolNames: ['first', 'second'],
    };
    const wgsl = 'fn shared() -> f32 { return missing; }';
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: 'missing',
        offset: wgsl.indexOf('missing'),
        length: 'missing'.length,
      },
      target,
      symbols,
    );

    expect(mapping).toMatchObject({
      confidence: 'none',
      strategy: 'ambiguous-declaration',
      generatedDeclaration: { name: 'shared' },
    });
    expect(mapping.sourceRange).toBeUndefined();
  });

  it('stays fast and maps line numbers correctly across thousands of declarations', () => {
    const declarationCount = 3_000;
    const lines: string[] = [];
    for (let index = 0; index < declarationCount; index += 1) {
      lines.push(`fn helper${index}() -> f32 {`, `  return ${index}.0;`, `}`, '');
    }
    const wgsl = lines.join('\n');

    const declarationStarts = new Map<string, number>();
    for (
      const match of wgsl.matchAll(/\bfn (helper\d+)\(/g)
    ) {
      const name = match[1];
      if (!name) continue;
      const fnKeywordStart = match.index ?? 0;
      declarationStarts.set(name, fnKeywordStart + 'fn '.length);
    }
    expect(declarationStarts.size).toBe(declarationCount);

    const target: InspectionTarget = {
      id: 'resolvable:none',
      label: 'none',
      selector: { kind: 'resolvable', selector: 'none', label: 'none' },
      symbolNames: [],
    };

    const sampleIndices = [0, 1, Math.floor(declarationCount / 2), declarationCount - 2, declarationCount - 1];

    for (let index = 0; index < declarationCount; index += 1) {
      const name = `helper${index}`;
      const offset = declarationStarts.get(name)!;
      const mapping = mapWgslDiagnostic(
        wgsl,
        {
          type: 'error',
          message: `unresolved value '${name}'`,
          offset,
          length: name.length,
        },
        target,
        [],
      );
      if (sampleIndices.includes(index)) {
        expect(mapping.generatedDeclaration).toMatchObject({ kind: 'fn', name });
        const expectedLine = index * 4;
        expect(mapping.generatedDeclaration?.range.start.line).toBe(expectedLine);
      }
    }
  });

  it('retains the generated range when no declaration can be mapped', () => {
    const discovered = discoverTypeGpuModule(
      '/workspace/helper.ts',
      'export const helper = tgpu.fn([], d.f32)(() => 1);',
    );
    const wgsl = 'fn generatedElsewhere() -> f32 { return missing; }';
    const mapping = mapWgslDiagnostic(
      wgsl,
      {
        type: 'error',
        message: 'missing',
        offset: wgsl.indexOf('missing'),
        length: 'missing'.length,
      },
      discovered.targets[0]!,
      discovered.symbols,
    );

    expect(mapping).toMatchObject({ confidence: 'none', strategy: 'unmapped' });
    expect(mapping.generatedRange).toBeDefined();
    expect(mapping.sourceRange).toBeUndefined();
  });
});

describe('statement-map source mapping', () => {
  const discovered = discoverTypeGpuModule('/workspace/boids.ts', statementMapSource);
  const targetOf = (name: string) =>
    discovered.targets.find((target) => target.symbolNames.includes(name))!;
  const message = (line: number, needle: string, text: string, occurrence = 0) => {
    const offset = offsetOnLine(statementMapWgsl, line, needle, occurrence);
    return {
      type: 'error',
      message: text,
      offset,
      length: needle.length,
      lineNum: line + 1,
      linePos: offset - statementMapWgsl.lastIndexOf('\n', offset - 1),
    };
  };

  it('maps a statement inside the target to its authored statement', () => {
    const mapping = mapWgslDiagnostic(
      statementMapWgsl,
      message(14, '(vel + vec3f(0.10000000149011612))', 'no matching overload for operator +'),
      targetOf('stepBoid'),
      discovered.symbols,
      statementMap,
    );
    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'statement',
      sourceSymbol: 'stepBoid',
      generatedDeclaration: { kind: 'fn', name: 'stepBoid' },
    });
    expect(mapping.sourceRange).toEqual(sourceRangeOnLine(16, 'vel = vel + d.vec3f(0.1);'));
    expect(mapping.generatedDeclaration?.range.start).toEqual({ line: 6, character: 3 });
  });

  it('pins a repeated token by ordinal within the statement', () => {
    const mapping = mapWgslDiagnostic(
      statementMapWgsl,
      message(14, 'vel', "unresolved value 'vel'", 1),
      targetOf('stepBoid'),
      discovered.symbols,
      statementMap,
    );
    expect(mapping).toMatchObject({
      confidence: 'medium',
      strategy: 'statement-token',
      generatedToken: 'vel',
    });
    expect(mapping.sourceRange).toEqual(sourceRangeOnLine(16, 'vel', 1));
  });

  it('pins a unique token in a compound statement header', () => {
    const mapping = mapWgslDiagnostic(
      statementMapWgsl,
      message(22, 'gid', 'something about gid'),
      targetOf('mainCompute'),
      discovered.symbols,
      statementMap,
    );
    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'statement-token',
      sourceSymbol: 'mainCompute',
    });
    expect(mapping.sourceRange).toEqual(sourceRangeOnLine(27, 'gid'));
  });

  it('maps a closing-brace line to the enclosing statement and a header to the declaration', () => {
    const closing = mapWgslDiagnostic(
      statementMapWgsl,
      message(17, '}', 'unexpected brace'),
      targetOf('stepBoid'),
      discovered.symbols,
      statementMap,
    );
    expect(closing).toMatchObject({ strategy: 'statement', confidence: 'high' });
    expect(closing.sourceRange).toEqual({
      start: { line: 12, character: 2 },
      end: { line: 18, character: 3 },
    });

    const header = mapWgslDiagnostic(
      statementMapWgsl,
      message(6, 'index', "unused parameter 'index'"),
      targetOf('stepBoid'),
      discovered.symbols,
      statementMap,
    );
    expect(header).toMatchObject({ strategy: 'statement', confidence: 'high' });
    expect(header.sourceRange).toEqual(sourceRangeOnLine(9, 'stepBoid'));
  });

  it('maps a helper inlined into another target to its call site with the statement as related source', () => {
    const mapping = mapWgslDiagnostic(
      statementMapWgsl,
      message(14, '(vel + vec3f(0.10000000149011612))', 'no matching overload for operator +'),
      targetOf('mainCompute'),
      discovered.symbols,
      statementMap,
    );
    expect(mapping).toMatchObject({
      confidence: 'high',
      strategy: 'statement-call-site',
      sourceSymbol: 'stepBoid',
      generatedDeclaration: { kind: 'fn', name: 'stepBoid' },
    });
    expect(mapping.sourceRange).toEqual(sourceRangeOnLine(30, 'stepBoid'));
    expect(mapping.relatedSource).toEqual({
      range: sourceRangeOnLine(16, 'vel = vel + d.vec3f(0.1);'),
      sourceSymbol: 'stepBoid',
    });
  });

  it('falls back to token heuristics when the map does not cover the line', () => {
    const partial = { functions: statementMap.functions.filter((fn) => fn.name !== 'rotateXY') };
    const mapping = mapWgslDiagnostic(
      statementMapWgsl,
      message(1, 'sin', "unresolved call 'sin'"),
      targetOf('rotateXY'),
      discovered.symbols,
      partial,
    );
    expect(mapping).toMatchObject({ strategy: 'generated-token', confidence: 'high' });
    expect(mapping.sourceRange).toEqual(sourceRangeOnLine(4, 'sin'));
  });

  it('locates a recorded resolution failure', () => {
    const failure: NonNullable<InspectorStatementMap['failure']> = {
      fn: 'stepBoid',
      path: [1, 'body', 0, 'else', 'then', 0],
    };
    const direct = mapResolutionFailure(failure, targetOf('stepBoid'), discovered.symbols);
    expect(direct).toMatchObject({ strategy: 'statement', confidence: 'high', sourceSymbol: 'stepBoid' });
    expect(direct?.sourceRange).toEqual(sourceRangeOnLine(16, 'vel = vel + d.vec3f(0.1);'));

    const viaCall = mapResolutionFailure(failure, targetOf('mainCompute'), discovered.symbols);
    expect(viaCall).toMatchObject({ strategy: 'statement-call-site' });
    expect(viaCall?.sourceRange).toEqual(sourceRangeOnLine(30, 'stepBoid'));
    expect(viaCall?.relatedSource?.range).toEqual(sourceRangeOnLine(16, 'vel = vel + d.vec3f(0.1);'));

    const compound = mapResolutionFailure({ fn: 'stepBoid', path: [1] }, targetOf('stepBoid'), discovered.symbols);
    expect(compound?.sourceRange).toEqual(sourceRangeOnLine(12, 'for (let i = 0; i < 4; i++)'));

    expect(mapResolutionFailure({ fn: 'stepBoid', path: [9] }, targetOf('stepBoid'), discovered.symbols))
      .toBeUndefined();
    expect(mapResolutionFailure({ fn: 'elsewhere', path: [0] }, targetOf('stepBoid'), discovered.symbols))
      .toBeUndefined();
    expect(mapResolutionFailure({ fn: 'stepBoid_1', path: [] }, targetOf('stepBoid'), discovered.symbols))
      .toMatchObject({ sourceRange: sourceRangeOnLine(9, 'stepBoid') });
  });
});
