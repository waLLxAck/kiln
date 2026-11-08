// The standalone yt-dlp that Kiln's installers include, so video distillation works without Python, pip or a PATH change.
// Downloads the build for one platform into vendor/yt-dlp/<os>/ (the program, its LICENSE and THIRD_PARTY_LICENSES.txt), which
// electron-builder's extraResources copies into the app's resources/yt-dlp. The version and every file's SHA-256 are pinned in
// scripts/yt-dlp.json: a download that does not match is rejected, and files already there with the right checksum are kept.
//   node scripts/yt-dlp.mjs [win|mac|linux]    fetch for that platform (default: this machine's)
//   node scripts/yt-dlp.mjs --pin <version>    move to another yt-dlp release: records its checksums in scripts/yt-dlp.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..'), pins = path.join(import.meta.dirname, 'yt-dlp.json');
// The standalone builds (PyInstaller, Python included). yt-dlp_macos is universal, so one file serves both Mac architectures.
const programs = { win: { asset: 'yt-dlp.exe', file: 'yt-dlp.exe' }, mac: { asset: 'yt-dlp_macos', file: 'yt-dlp' }, linux: { asset: 'yt-dlp_linux', file: 'yt-dlp' } };
const licences = ['LICENSE', 'THIRD_PARTY_LICENSES.txt'];
const releaseUrl = version => `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`;
const sourceUrl = version => `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${version}`;
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.argv[2] === '--pin') {
  const version = process.argv[3];
  if (!/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(version ?? '')) throw new Error('Usage: node scripts/yt-dlp.mjs --pin <yt-dlp version, for example 2026.10.26>');
  // SHA2-256SUMS lines are "<sha256>  <asset>".
  const sums = new Map((await download(`${releaseUrl(version)}/SHA2-256SUMS`)).toString('utf8').trim().split('\n').map(line => line.trim().split(/\s+/).reverse()));
  const files = Object.fromEntries(Object.entries(programs).map(([os, { asset }]) => {
    if (!sums.has(asset)) throw new Error(`${asset} is not listed in yt-dlp ${version}'s SHA2-256SUMS`);
    return [os, sums.get(asset)];
  }));
  const licenceSums = Object.fromEntries(await Promise.all(licences.map(async name => [name, sha256(await download(`${sourceUrl(version)}/${name}`))])));
  fs.writeFileSync(pins, `${JSON.stringify({ version, files, licences: licenceSums }, null, 2)}\n`);
  console.log(`Pinned yt-dlp ${version} in scripts/yt-dlp.json. Fetch it (node scripts/yt-dlp.mjs) and distill a video with it before committing.`);
} else {
  const os = process.argv[2] ?? ({ win32: 'win', darwin: 'mac' }[process.platform] ?? 'linux');
  if (!programs[os]) throw new Error(`Unknown platform "${os}": use win, mac or linux.`);
  const { version, files, licences: licenceSums } = JSON.parse(fs.readFileSync(pins, 'utf8'));
  const folder = path.join(root, 'vendor', 'yt-dlp', os);
  const wanted = [
    { file: programs[os].file, url: `${releaseUrl(version)}/${programs[os].asset}`, expected: files[os], mode: 0o755 },
    ...licences.map(name => ({ file: name, url: `${sourceUrl(version)}/${name}`, expected: licenceSums[name], mode: 0o644 })),
  ];
  fs.mkdirSync(folder, { recursive: true });
  // Only these files are bundled: anything else in the folder (an older download, a partial file) is removed.
  for (const name of fs.readdirSync(folder)) if (!wanted.some(entry => entry.file === name)) fs.rmSync(path.join(folder, name), { recursive: true, force: true });
  for (const { file, url, expected, mode } of wanted) {
    const target = path.join(folder, file);
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === expected) { fs.chmodSync(target, mode); continue; }
    const data = await download(url), actual = sha256(data);
    if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, but scripts/yt-dlp.json expects ${expected}. Not bundling it.`);
    fs.writeFileSync(`${target}.partial`, data, { mode });
    fs.renameSync(`${target}.partial`, target);
    fs.chmodSync(target, mode);
  }
  console.log(`yt-dlp ${version} for ${os} is ready to bundle in ${path.relative(root, folder)}`);
}
