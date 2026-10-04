import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { desktopEnv, readyLibrary } from './fixture';

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
