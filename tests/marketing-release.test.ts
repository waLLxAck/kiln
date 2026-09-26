import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackRelease, latestRelease, releasesPage } from '../apps/marketing/latest-release.mjs';

const asset = (name: string) => ({ name, browser_download_url: `${releasesPage}/download/v1.2.3/${name}` });
const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('the website takes each download from the newest release’s actual assets', async () => {
  const names = ['Kiln-1.2.3-arm64.dmg', 'Kiln-1.2.3-arm64.zip', 'Kiln-1.2.3-x64.dmg', 'Kiln-1.2.3-x64.tar.gz', 'Kiln-1.2.3-x86_64.AppImage', 'Kiln-Setup-1.2.3.exe', 'Kiln-Setup-1.2.3.exe.blockmap', 'kiln_1.2.3_amd64.deb', 'latest.yml', 'SHA256SUMS.txt'];
  const release = await latestRelease(answer({ tag_name: 'v1.2.3', html_url: `${releasesPage}/tag/v1.2.3`, assets: names.map(asset) }), '');
  assert.equal(release.version, '1.2.3');
  assert.deepEqual(Object.fromEntries(Object.entries(release.assets).map(([key, url]) => [key, url.split('/').pop()])), { windows: 'Kiln-Setup-1.2.3.exe', 'mac-arm64': 'Kiln-1.2.3-arm64.dmg', 'mac-x64': 'Kiln-1.2.3-x64.dmg', appimage: 'Kiln-1.2.3-x86_64.AppImage', deb: 'kiln_1.2.3_amd64.deb', targz: 'Kiln-1.2.3-x64.tar.gz' });
});

test('a platform missing from a release links to that release’s page; an unreachable GitHub is an error the build can fall back from', async () => {
  const release = await latestRelease(answer({ tag_name: 'v2.0.0', html_url: `${releasesPage}/tag/v2.0.0`, assets: [asset('Kiln-2.0.0-x86_64.AppImage'), asset('Kiln.Setup.2.0.0.exe')] }), '');
  assert.equal(release.assets['mac-arm64'], `${releasesPage}/tag/v2.0.0`);
  assert.match(release.assets.windows, /Kiln\.Setup\.2\.0\.0\.exe$/, 'the pre-0.20 Windows name still matches');
  await assert.rejects(latestRelease(answer({ message: 'rate limited' }, 403), ''), /GitHub answered 403/);
  assert.ok(Object.values(fallbackRelease().assets).every(url => url === `${releasesPage}/latest`));
  assert.equal(fallbackRelease().version, '');
});
