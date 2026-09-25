// Renders assets/kiln.svg into assets/kiln.png (256 px) and assets/kiln.ico (16–256 px). Each icon size is rendered from the
// vector separately rather than downscaled, so small sizes stay crisp. Needs `rsvg-convert` (librsvg) and ImageMagick `magick`.
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
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`Rendered assets/kiln.png and assets/kiln.ico (${sizes.join(', ')} px)`);
