import type { Range } from 'vscode-languageserver';
import type { InspectorStatementMap } from '../../src/protocol.js';

/**
 * A helper chain and its WGSL as TypeGPU 0.12 generates it, with the
 * statement map the runtime records alongside. Lines are 0-based.
 */
export const statementMapSource = [
  "import { tgpu, d, std } from 'typegpu';",
  '',
  'export const rotateXY = tgpu.fn([d.vec3f, d.f32], d.vec3f)((p, angle) => {',
  "  'use gpu';",
  '  const s = std.sin(angle);',
  '  const c = std.cos(angle);',
  '  return d.vec3f(p.x * c - p.y * s, p.x * s + p.y * c, p.z);',
  '});',
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
  '  layout.$.boids[index].pos = rotateXY(vel, 0.01);',
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

export const statementMapWgsl = [
  'fn rotateXY(p: vec3f, angle: f32) -> vec3f {',
  '  let s = sin(angle);',
  '  let c = cos(angle);',
  '  return vec3f(((p.x * c) - (p.y * s)), ((p.x * s) + (p.y * c)), p.z);',
  '}',
  '',
  'fn stepBoid(index: u32) {',
  '  var vel = vec3f(1f);',
  '  for (var i = 0; (i < 4i); i++) {',
  '    if ((length(vel) > 2f)) {',
  '      vel = (normalize(vel) * 2f);',
  '    }',
  '    else {',
  '      if ((i > 2i)) {',
  '        vel = (vel + vec3f(0.10000000149011612));',
  '      }',
  '    }',
  '  }',
  '  boids[index].pos = rotateXY(vel, 0.01f);',
  '}',
  '',
  '@compute @workgroup_size(64) fn mainCompute(@builtin(global_invocation_id) gid: vec3u) {',
  '  if ((gid.x >= 64u)) {',
  '    return;',
  '  }',
  '  stepBoid(gid.x);',
  '}',
].join('\n');

export const statementMap: InspectorStatementMap = {
  functions: [
    {
      name: 'rotateXY',
      line: 0,
      statements: [
        { path: [0], line: 1, lineCount: 1 },
        { path: [1], line: 2, lineCount: 1 },
        { path: [2], line: 3, lineCount: 1 },
      ],
    },
    {
      name: 'stepBoid',
      line: 6,
      statements: [
        { path: [0], line: 7, lineCount: 1 },
        { path: [1], line: 8, lineCount: 10 },
        { path: [1, 'init'], line: 8, lineCount: 1 },
        { path: [1, 'update'], line: 8, lineCount: 1 },
        { path: [1, 'body', 0], line: 9, lineCount: 8 },
        { path: [1, 'body', 0, 'then', 0], line: 10, lineCount: 1 },
        { path: [1, 'body', 0, 'else'], line: 13, lineCount: 3 },
        { path: [1, 'body', 0, 'else', 'then', 0], line: 14, lineCount: 1 },
        { path: [2], line: 18, lineCount: 1 },
      ],
    },
    {
      name: 'mainCompute',
      line: 21,
      statements: [
        { path: [0], line: 22, lineCount: 3 },
        { path: [0, 'then', 0], line: 23, lineCount: 1 },
        { path: [1], line: 25, lineCount: 1 },
      ],
    },
  ],
};

/** Offset of the `occurrence`-th (0-based) `needle` on `line` of `text`. */
export function offsetOnLine(text: string, line: number, needle: string, occurrence = 0): number {
  const lines = text.split('\n');
  const lineStart = lines.slice(0, line).reduce((sum, entry) => sum + entry.length + 1, 0);
  let column = -1;
  for (let found = 0; found <= occurrence; found += 1) {
    column = lines[line]!.indexOf(needle, column + 1);
    if (column === -1) throw new Error(`no '${needle}' #${occurrence} on line ${line}`);
  }
  return lineStart + column;
}

/** LSP range of `needle` on `line` of the authored source. */
export function sourceRangeOnLine(line: number, needle: string, occurrence = 0): Range {
  const lines = statementMapSource.split('\n');
  let column = -1;
  for (let found = 0; found <= occurrence; found += 1) {
    column = lines[line]!.indexOf(needle, column + 1);
    if (column === -1) throw new Error(`no '${needle}' #${occurrence} on source line ${line}`);
  }
  return {
    start: { line, character: column },
    end: { line, character: column + needle.length },
  };
}
