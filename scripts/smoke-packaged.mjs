// Starts a packaged Kiln build against an empty, isolated library and checks that its window opens and the app knows which
// platform it is on. release.yml runs it on each runner after building, since nobody clicks through those builds by hand.
//   node scripts/smoke-packaged.mjs <path to the Kiln executable>
// On Linux, run it under a display, for example `xvfb-run -a node scripts/smoke-packaged.mjs release/linux-unpacked/kiln-workbench`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const executablePath = path.resolve(process.argv[2] ?? '');
assert.ok(fs.existsSync(executablePath), `No executable at ${executablePath}`);
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-smoke-'));
const app = await electron.launch({ executablePath, env: { ...process.env, KILN_LIBRARY: path.join(root, 'library'), KILN_LOCAL: path.join(root, 'private') }, timeout: 90_000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.body.innerText.trim().length > 20, undefined, { timeout: 60_000 });
  const main = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), platform: process.platform, arch: process.arch }));
  assert.equal(main.packaged, true, 'runs as a packaged app');
  assert.equal(main.version, version, 'reports the package.json version');
  const bridge = await page.evaluate(async () => ({ title: document.title, platform: window.kiln.platform, update: await window.kiln.call('desktop.updateCheck') }));
  assert.match(bridge.title, /^Kiln/);
  assert.equal(bridge.platform, main.platform, 'the renderer sees the same platform');
  // Published builds follow GitHub releases. They install in place on Windows and from a .deb (resources/package-type); macOS builds
  // are not Developer ID signed and the tar.gz has no installer, so those open the release page. Reading the status makes no request.
  const debPackage = fs.existsSync(path.join(path.dirname(executablePath), 'resources', 'package-type'));
  assert.equal(bridge.update.sourceKind, 'github', 'published builds follow GitHub releases');
  assert.equal(bridge.update.install, main.platform === 'win32' || (main.platform === 'linux' && debPackage) ? 'app' : 'download', 'installs in place only where the platform allows');
  const logs = path.join(root, 'private', 'desktop', 'logs', 'performance.jsonl');
  const events = fs.existsSync(logs) ? fs.readFileSync(logs, 'utf8') : '';
  if (main.platform !== 'win32') assert.match(events, /"path\.resolved"/, 'took PATH from the login shell');
  assert.deepEqual(errors, [], 'no renderer errors');
  const shot = path.resolve('artifacts', `smoke-${main.platform}-${main.arch}.png`);
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });
  console.log(`ok  Kiln ${main.version} (${main.platform}-${main.arch}) opened: ${(await page.locator('body').innerText()).trim().split('\n')[0]}`);
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
