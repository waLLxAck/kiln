// Renders assets/kiln.svg into assets/kiln.png (256 px) and assets/kiln.ico (16–256 px) for Windows, assets/kiln-1024.png for
// Linux, assets/kiln.icns for macOS (the mark inset on Apple's 1024 px icon grid) and assets/kilnTemplate.png / @2x for the macOS
// menu bar (a black silhouette that macOS tints). Each icon size is rendered from the vector separately rather than downscaled, so
// small sizes stay crisp. Needs `rsvg-convert` (librsvg) and ImageMagick `magick`.
//   node scripts/render-icon.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const svg = path.resolve('assets/kiln.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256];
// At 16 and 24 px the arch base and the fire opening fall on half pixels, so those sizes use the same mark snapped to whole pixels.
const hinted = {
  16: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="#1f1c18"/><path d="M4 13V8a4 4 0 0 1 8 0v5z" fill="#f6efe3"/><path d="M6 13v-2a2 2 0 0 1 4 0v2z" fill="#e8892b"/></svg>',
  24: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#1f1c18"/><path d="M6 19v-7a6 6 0 0 1 12 0v7z" fill="#f6efe3"/><path d="M10 19v-5a2 2 0 0 1 4 0v5z" fill="#e8892b"/></svg>',
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-icon-'));
try {
  const pngs = sizes.map(size => {
    const file = path.join(temp, `kiln-${size}.png`);
    let source = svg;
    if (hinted[size]) { source = path.join(temp, `kiln-${size}.svg`); fs.writeFileSync(source, hinted[size]); }
    execFileSync('rsvg-convert', ['--width', String(size), '--height', String(size), '--output', file, source]);
    return file;
  });
  fs.copyFileSync(pngs.at(-1), path.resolve('assets/kiln.png'));
  // ImageMagick writes every size as a 32-bit BMP. Keep those for 16–128 px and embed the 256 px size as PNG, as Windows expects.
  const bmpIco = path.join(temp, 'small.ico');
  execFileSync('magick', [...pngs.slice(0, -1), bmpIco]);
  const small = fs.readFileSync(bmpIco);
  const images = sizes.slice(0, -1).map((_, i) => {
    const entry = 6 + 16 * i;
    return { entry: small.subarray(entry, entry + 8), data: small.subarray(small.readUInt32LE(entry + 12), small.readUInt32LE(entry + 12) + small.readUInt32LE(entry + 8)) };
  });
  const large = Buffer.alloc(8); large.writeUInt16LE(1, 4); large.writeUInt16LE(32, 6); // 0×0 means 256 px; one plane, 32 bpp
  images.push({ entry: large, data: fs.readFileSync(pngs.at(-1)) });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ entry, data }, i) => {
    entry.copy(header, 6 + 16 * i);
    header.writeUInt32LE(data.length, 6 + 16 * i + 8); header.writeUInt32LE(offset, 6 + 16 * i + 12);
    offset += data.length;
  });
  fs.writeFileSync(path.resolve('assets/kiln.ico'), Buffer.concat([header, ...images.map(image => image.data)]));

  const render = (source, size, output) => { execFileSync('rsvg-convert', ['--width', String(size), '--height', String(size), '--output', output, source]); return fs.readFileSync(output); };
  render(svg, 1024, path.resolve('assets/kiln-1024.png'));

  // macOS icons sit inside Apple's grid: an 824 px body centred on a 1024 px canvas, so Kiln is not oversized in the Dock.
  const mark = fs.readFileSync(svg, 'utf8').replace(/^<svg[^>]*>|<\/svg>\s*$/g, '');
  const macSvg = path.join(temp, 'kiln-mac.svg');
  fs.writeFileSync(macSvg, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="translate(100 100) scale(25.75)">${mark}</g></svg>`);
  // ICNS: 'icns', total length, then one entry per size (type, entry length, PNG bytes). All lengths are big-endian.
  const icnsTypes = [['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];
  const entries = icnsTypes.map(([type, size]) => {
    const png = render(macSvg, size, path.join(temp, `mac-${type}.png`)), head = Buffer.alloc(8);
    head.write(type, 0, 'ascii'); head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const icnsHead = Buffer.alloc(8); icnsHead.write('icns', 0, 'ascii'); icnsHead.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
  fs.writeFileSync(path.resolve('assets/kiln.icns'), Buffer.concat([icnsHead, ...entries]));

  // Menu bar: the arch with its fire opening cut out, black on transparent. The "Template" suffix tells Electron to let macOS tint it.
  const template = path.join(temp, 'template.svg');
  fs.writeFileSync(template, '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M3 14V8a5 5 0 0 1 10 0v6zM6 14v-2.5a2 2 0 0 1 4 0V14z" fill="#000"/></svg>');
  render(template, 16, path.resolve('assets/kilnTemplate.png'));
  render(template, 32, path.resolve('assets/kilnTemplate@2x.png'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`Rendered assets/kiln.png and assets/kiln.ico (${sizes.join(', ')} px), assets/kiln-1024.png, assets/kiln.icns and the macOS menu bar template`);
