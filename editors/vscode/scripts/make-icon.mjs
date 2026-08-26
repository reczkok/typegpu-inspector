#!/usr/bin/env node
// Generates editors/vscode/icon.png — the Marketplace / extension-list icon.
//
// Committed as a generator rather than a checked-in binary blob so the mark
// stays editable and reviewable in a diff. Uses only node:zlib: a PNG is a
// signature plus CRC'd chunks around a zlib stream, which is little enough
// code to not be worth a dependency (and the extension must stay free of
// runtime deps it does not ship).
//
//   node editors/vscode/scripts/make-icon.mjs
//
// The mark: a stylized ⟨GPU⟩ — two chevrons around a die with a cut-out core
// — in TypeGPU teal on a near-black ground. Pure geometry, no text rendering,
// so it survives being scaled down to 32px in the extensions sidebar.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
/** Supersampling factor; averaging the samples is our whole anti-aliaser. */
const SAMPLES = 3;

const GROUND = [0x17, 0x1a, 0x21];
const TEAL = [0x0e, 0x7c, 0x7b];
/** A lift on the teal so the die reads as lit rather than flat. */
const TEAL_LIGHT = [0x19, 0xa8, 0xa4];

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRect(x, y, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x - cx) - (halfWidth - radius);
  const dy = Math.abs(y - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Signed distance to a thick line segment with round caps (a capsule). */
function capsule(x, y, ax, ay, bx, by, radius) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = x - ax;
  const apy = y - ay;
  const lengthSquared = abx * abx + aby * aby;
  const t = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, (apx * abx + apy * aby) / lengthSquared));
  return Math.hypot(apx - abx * t, apy - aby * t) - radius;
}

/**
 * Shapes are painted in order; the last one covering a sample wins. Kept as
 * plain predicates so the composite is just "which shape is on top here".
 */
const LAYERS = [
  // ⟨ : two strokes meeting at a point on the left.
  {
    color: TEAL,
    hit: (x, y) =>
      capsule(x, y, 46, 128, 88, 78, 11) < 0 ||
      capsule(x, y, 46, 128, 88, 178, 11) < 0,
  },
  // ⟩ : mirrored on the right.
  {
    color: TEAL,
    hit: (x, y) =>
      capsule(x, y, 210, 128, 168, 78, 11) < 0 ||
      capsule(x, y, 210, 128, 168, 178, 11) < 0,
  },
  // The die between the brackets.
  {
    color: TEAL_LIGHT,
    hit: (x, y) => roundedRect(x, y, 128, 128, 38, 38, 11) < 0,
  },
  // Its cut-out core, punched back to the ground colour.
  {
    color: GROUND,
    hit: (x, y) => roundedRect(x, y, 128, 128, 15, 15, 5) < 0,
  },
];

function shade(x, y) {
  let color = GROUND;
  for (const layer of LAYERS) {
    if (layer.hit(x, y)) color = layer.color;
  }
  return color;
}

/** Raw PNG scanlines: one filter byte (0 = None) then RGB triples. */
function renderScanlines() {
  const stride = 1 + SIZE * 3;
  const raw = Buffer.alloc(stride * SIZE);
  const step = 1 / SAMPLES;
  const offset = step / 2;
  for (let py = 0; py < SIZE; py += 1) {
    const rowStart = py * stride;
    raw[rowStart] = 0;
    for (let px = 0; px < SIZE; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const color = shade(px + sx * step + offset, py + sy * step + offset);
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const total = SAMPLES * SAMPLES;
      const at = rowStart + 1 + px * 3;
      raw[at] = Math.round(r / total);
      raw[at + 1] = Math.round(g / total);
      raw[at + 2] = Math.round(b / total);
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour RGB
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(renderScanlines(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const output = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'icon.png',
);
writeFileSync(output, png);
process.stdout.write(`Wrote ${output} (${SIZE}x${SIZE}, ${png.length} bytes)\n`);
