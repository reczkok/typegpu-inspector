import type { Range } from 'vscode-languageserver';
import { discoverTypeGpuModule } from '../../src/discovery.js';
import type { ExternalShaderSymbol } from '../../src/moduleGraph.js';

/**
 * The statement-map fixture split across two files: `rotateXY` lives in
 * `math.ts` and `boids.ts` imports it under an alias. The generated WGSL and
 * statement map are those of `statementMapFixture` — TypeGPU names the
 * function after its declaration, not the import.
 */
export const crossFileHelperSource = [
  "import { tgpu, d, std } from 'typegpu';",
  '',
  'export const rotateXY = tgpu.fn([d.vec3f, d.f32], d.vec3f)((p, angle) => {',
  "  'use gpu';",
  '  const s = std.sin(angle);',
  '  const c = std.cos(angle);',
  '  return d.vec3f(p.x * c - p.y * s, p.x * s + p.y * c, p.z);',
  '});',
].join('\n');

export const crossFileEntrySource = [
  "import { tgpu, d, std } from 'typegpu';",
  "import { rotateXY as rot } from './math.ts';",
  '',
  'export const stepBoid = tgpu.fn([d.u32])((index) => {',
  "  'use gpu';",
  '  let vel = d.vec3f(1);',
  '  for (let i = 0; i < 4; i++) {',
  '    if (std.length(vel) > 2) {',
  '      vel = std.normalize(vel) * 2;',
  '    } else if (i > 2) {',
  '      vel = vel + d.vec3f(0.1);',
  '    }',
  '  }',
  '  layout.$.boids[index].pos = rot(vel, 0.01);',
  '});',
  '',
  'export const mainCompute = tgpu.computeFn({',
  '  in: { gid: d.builtin.globalInvocationId },',
  '  workgroupSize: [64],',
  '})(({ gid }) => {',
  "  'use gpu';",
  '  if (gid.x >= 64) {',
  '    return;',
  '  }',
  '  stepBoid(gid.x);',
  '});',
].join('\n');

export const crossFileHelperUri = 'file:///workspace/math.ts';
export const crossFileEntryUri = 'file:///workspace/boids.ts';

export const crossFileEntry = discoverTypeGpuModule('/workspace/boids.ts', crossFileEntrySource);
const helperModule = discoverTypeGpuModule('/workspace/math.ts', crossFileHelperSource);

/** What `collectImportedShaderSymbols` yields for the entry, built without touching disk. */
export const crossFileExternalSymbols: ExternalShaderSymbol[] = helperModule.symbols
  .filter((symbol) => (symbol.shaderBodies?.length ?? 0) > 0)
  .map((symbol) => ({
    symbol,
    fileName: '/workspace/math.ts',
    uri: crossFileHelperUri,
    callName: 'rot',
  }));

/** LSP range of the `occurrence`-th `needle` on `line` of `text`. */
export function rangeOnLine(text: string, line: number, needle: string, occurrence = 0): Range {
  const lines = text.split('\n');
  let column = -1;
  for (let found = 0; found <= occurrence; found += 1) {
    column = lines[line]!.indexOf(needle, column + 1);
    if (column === -1) throw new Error(`no '${needle}' #${occurrence} on line ${line}`);
  }
  return {
    start: { line, character: column },
    end: { line, character: column + needle.length },
  };
}
