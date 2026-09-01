#!/usr/bin/env node
// Renders extension/icons-src/*.svg to extension/public/icons/{16,32,48,128}.png
// with @resvg/resvg-js (a root devDependency). Run after an SVG change; the
// PNG files are committed.
//
//   node scripts/gen-icons.mjs
//
// 16 and 32 use icon-small.svg (fewer details). 48 and 128 use icon.svg.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'extension', 'icons-src');
const outDir = path.resolve(here, '..', 'extension', 'public', 'icons');

const SIZES = [
  { size: 16, svg: 'icon-small.svg' },
  { size: 32, svg: 'icon-small.svg' },
  { size: 48, svg: 'icon.svg' },
  { size: 128, svg: 'icon.svg' },
];

await fs.mkdir(outDir, { recursive: true });
for (const { size, svg } of SIZES) {
  const source = await fs.readFile(path.join(srcDir, svg), 'utf8');
  const renderer = new Resvg(source, { fitTo: { mode: 'width', value: size } });
  const png = renderer.render().asPng();
  const out = path.join(outDir, `${size}.png`);
  await fs.writeFile(out, png);
  console.log(`wrote ${path.relative(process.cwd(), out)} (${png.length} bytes)`);
}
