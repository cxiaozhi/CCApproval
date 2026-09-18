#!/usr/bin/env node
'use strict';
/**
 * Regenerate the raster icons from assets/icon.svg: `npm run icon`.
 *
 * The SVG is the source of truth — edit it (or drop in a replacement of the same
 * square design) and run this. sharp renders the SVG at the exact pixel size via
 * `density`, rather than upscaling a small raster; png-to-ico packs the three sizes
 * Windows/Chrome pick from.
 *
 * Nothing at runtime depends on this: the panel reads the committed files (see
 * src/icon.js), so a broken/absent toolchain only ever affects this script.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
// v3 is ESM (`export default`) while v2 was a plain CJS function; require() interop
// hands back a namespace object, so accept either shape.
const pngToIcoModule = require('png-to-ico');
const pngToIco = typeof pngToIcoModule === 'function' ? pngToIcoModule : pngToIcoModule.default;

const assetsDir = path.join(__dirname, '..', 'assets');
const svg = fs.readFileSync(path.join(assetsDir, 'icon.svg'));
const INTRINSIC = 64; // the SVG's own viewBox edge
const PNG_SIZES = [180, 512];
const ICO_SIZES = [16, 32, 48];

/** Render the SVG at exactly `size`×`size` pixels. */
function render(size) {
  return sharp(svg, { density: (72 * size) / INTRINSIC })
    .resize(size, size, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

(async () => {
  for (const size of PNG_SIZES) {
    const png = await render(size);
    fs.writeFileSync(path.join(assetsDir, `icon-${size}.png`), png);
    console.log(`✔ assets/icon-${size}.png  ${png.length} B`);
  }

  const ico = await pngToIco(await Promise.all(ICO_SIZES.map(render)));
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);
  console.log(`✔ assets/icon.ico  ${ico.length} B  (${ICO_SIZES.join('/')})`);
})().catch(e => {
  console.error('✘ 生成失败: ' + e.message);
  process.exit(1);
});
