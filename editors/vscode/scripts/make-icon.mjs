#!/usr/bin/env node
// Usage: node editors/vscode/scripts/make-icon.mjs
// Rasterizes editors/vscode/icon.svg (the source of truth) to icon.png at 256×256.
// Uses the Chromium that the inspector package already depends on; run `pnpm install` first.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, '..', 'icon.svg');
const pngPath = join(here, '..', 'icon.png');
const SIZE = 256;

const require = createRequire(join(here, '..', '..', '..', 'inspector', 'package.json'));
const { chromium } = require('playwright-chromium');

const svg = readFileSync(svgPath, 'utf8').replace(/width="\d+" height="\d+"/, `width="${SIZE}" height="${SIZE}"`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
await page.setContent(`<body style="margin:0">${svg}</body>`);
await page.screenshot({ path: pngPath, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
await browser.close();
console.log(`wrote ${pngPath}`);
