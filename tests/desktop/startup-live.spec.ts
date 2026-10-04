import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { desktopEnv, readyLibrary } from './fixture';
import { Workbench } from '../../packages/domain/workbench';

function fixtureRoot() {
  fs.mkdirSync('artifacts', { recursive: true });
  return fs.mkdtempSync(path.resolve('artifacts/startup-live-'));
}

test('real library opening failure recovers through Retry after filesystem repair', async ({}, testInfo) => {
  const root = fixtureRoot(), library = readyLibrary(root);
  const blocked = path.join(library, 'workbench', 'items');
  fs.rmSync(blocked, { recursive: true });
  fs.writeFileSync(blocked, 'not a directory');
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  let recovered = false;
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('alert')).toContainText(/EEXIST|ENOTDIR/, { timeout: 45_000 });
    expect(await page.evaluate(() => (window as any).kiln.call('backend.status'))).toHaveProperty('pending', 0);
    await page.screenshot({ path: testInfo.outputPath('filesystem-error.png') });
    fs.unlinkSync(blocked);
    fs.mkdirSync(blocked);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).kiln.call('snapshot'))).toHaveProperty('items', []);
    await page.screenshot({ path: testInfo.outputPath('recovered.png') });
    recovered = true;
  } finally {
    // A native startup error dialog in a regressed build must not hang test cleanup.
    if (recovered) await app.close();
    else {
      app.process().kill('SIGKILL');
      await new Promise<void>(resolve => app.process().exitCode !== null || app.process().signalCode !== null ? resolve() : app.process().once('exit', () => resolve()));
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('real provider timeout stays in Settings and Detect again retries the executable', async ({}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX provider executable fixture');
  const root = fixtureRoot(), library = readyLibrary(root), bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'codex');
  fs.writeFileSync(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root, library), PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.locator('.startup')).toHaveCount(0);
    const providers = await page.evaluate(() => (window as any).kiln.call('providers.detect'));
    expect(providers.find((provider: { id: string }) => provider.id === 'codex').error).toContain('Version detection failed');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Version detection failed' })).toBeVisible();
    await page.getByRole('alert').filter({ hasText: 'Version detection failed' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('provider-error.png') });
    expect(await page.evaluate(() => (window as any).kiln.call('backend.status'))).toHaveProperty('pending');
    expect(await page.evaluate(() => (window as any).kiln.call('snapshot'))).toHaveProperty('items', []);
    fs.writeFileSync(executable, '#!/bin/sh\necho codex-live-recovered\n', { mode: 0o755 });
    await page.getByRole('button', { name: 'Detect again', exact: true }).click();
    await expect(page.locator('.provider-row').filter({ hasText: 'Codex' })).toContainText('codex-live-recovered');
    await expect(page.getByRole('alert').filter({ hasText: 'Version detection failed' })).toHaveCount(0);
    await page.locator('.provider-row').filter({ hasText: 'Codex' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('provider-recovered.png') });
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});


test('real blocked metadata read keeps the ordinary deadline and independent status probes', async ({}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX named pipe fixture');
  const root = fixtureRoot(), library = readyLibrary(root);
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  const fifo = path.join(library, 'workbench', 'activity', 'blocked.json');
  let writer: number | undefined;
  const release = () => {
    if (writer === undefined) return;
    fs.unlinkSync(fifo);
    fs.writeSync(writer, '{}');
    fs.closeSync(writer); writer = undefined;
  };
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    execFileSync('mkfifo', [fifo]);
    writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    const started = Date.now();
    await page.reload();
    await expect.poll(() => page.evaluate(async () => (await (window as any).kiln.call('backend.status')).running?.method)).toBe('snapshot');
    await expect(page.getByRole('alert')).toContainText('snapshot within 20 s', { timeout: 25_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(19_000);
    expect(Date.now() - started).toBeLessThan(28_000);
    const status = await page.evaluate(() => (window as any).kiln.call('backend.status'));
    expect(status.pending).toBeGreaterThan(0);
    expect(status.running.method).toBe('snapshot');
    await page.screenshot({ path: testInfo.outputPath('read-timeout.png') });
    release();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).kiln.call('snapshot'))).toHaveProperty('items', []);
    await page.screenshot({ path: testInfo.outputPath('recovered.png') });
  } finally {
    release();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

for (const bounded of [false, true]) test(`real blocked library opening ${bounded ? 'times out at 120 seconds and retries' : 'lets tray Quick search wait beyond 20 seconds'}`, async ({}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX named pipe fixture');
  test.setTimeout(180_000);
  const root = fixtureRoot(), library = readyLibrary(root);
  const workbench = new Workbench(library, path.join(root, 'private'));
  const item = workbench.create({ title: 'Cold search target', kind: 'prompt', content: 'Cold startup', files: {} });
  workbench.observe({ schemaVersion: 1, eventId: 'cold-copy', itemId: item.id, revision: item.revision, kind: 'copied', source: 'kiln', confidence: 'observed', occurredAt: new Date().toISOString() });
  workbench.close();
  const marker = path.join(library, 'kiln.json'), contents = fs.readFileSync(marker);
  fs.unlinkSync(marker);
  execFileSync('mkfifo', [marker]);
  let writer: number | undefined = fs.openSync(marker, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  const release = () => {
    if (writer === undefined) return;
    fs.unlinkSync(marker); fs.writeFileSync(marker, contents);
    fs.writeSync(writer, contents); fs.closeSync(writer); writer = undefined;
  };
  // Capture the real tray menu's callback without substituting any product requests or responses.
  const bootstrap = path.resolve(`.startup-live-${process.pid}.cjs`);
  fs.writeFileSync(bootstrap, `const { Menu } = require('electron');
const build = Menu.buildFromTemplate;
Menu.buildFromTemplate = function(template) {
  const quick = template.find(item => item.label === 'Quick search');
  if (quick) globalThis.openRealTraySearch = quick.click;
  return build.call(this, template);
};
require('./dist/desktop/main.cjs');\n`);
  const app = await electron.launch({ args: [bootstrap], env: desktopEnv(root, library) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('status', { name: 'Opening workbench' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).kiln.call('backend.status'))).toHaveProperty('running.method', 'startup');
    const opened = app.waitForEvent('window');
    await app.evaluate(() => (globalThis as any).openRealTraySearch());
    const palette = await opened;
    await expect(palette.getByRole('combobox', { name: 'Quick search' })).toBeVisible();
    if (bounded) {
      await expect(page.getByRole('alert')).toContainText('opening the library within 120 s', { timeout: 130_000 });
      await page.screenshot({ path: testInfo.outputPath('bounded-startup.png') });
    } else {
      await page.waitForTimeout(30_000);
      await expect(page.getByRole('status', { name: 'Opening workbench' })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(palette.getByRole('alert')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('waiting-startup.png') });
    }
    release();
    if (bounded) await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    if (bounded) await palette.reload();
    await expect(palette.getByRole('alert')).toHaveCount(0);
    await expect(palette.locator('.pal-preview .pal-sub')).toContainText('copied 1×');
    await expect(palette.locator('.pal-title').filter({ hasText: /^Cold search target$/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('ready-library.png') });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('#palette'));
      window?.show(); window?.focus();
    });
    await palette.screenshot({ path: testInfo.outputPath('ready-quick-search.png') });
  } finally {
    release(); await app.close(); fs.unlinkSync(bootstrap);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
