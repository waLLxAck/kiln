import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

test('a cold startup outlasts the read deadline, opens without Retry, and keeps provider errors in Settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-startup-'));
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page.evaluate(() => (window as any).kiln.call('items.create', { title: 'Cold search target', kind: 'prompt', content: 'Cold startup', files: {} }));
    await page.evaluate(() => (window as any).kiln.call('desktop.theme', { theme: 'dark' }));
    const paletteOpened = app.waitForEvent('window');
    await page.evaluate(() => (window as any).kiln.call('desktop.palette'));
    const palette = await paletteOpened;
    await expect(palette.getByRole('combobox', { name: 'Quick search' })).toBeVisible();
    await expect(palette.locator('html')).toHaveAttribute('data-theme', 'dark');
    // Hold the opening gate just as main.ts does while the real worker opens an existing library.
    await app.evaluate(({ ipcMain }) => {
      const handler = (ipcMain as any)._invokeHandlers.get('kiln:call');
      let release!: () => void;
      const opening = new Promise<void>(resolve => { release = resolve; });
      const state = (globalThis as any).startupTest = { release, ready: 0, reads: [] as string[] };
      ipcMain.removeHandler('kiln:call');
      ipcMain.handle('kiln:call', async (event, method, args) => {
        if (method === 'backend.status') return { ok: true, data: { pending: 1, running: { method: 'startup', ms: 21_000 } } };
        if (method === 'desktop.telemetry') return handler(event, method, args);
        if (method === 'desktop.ready') state.ready++;
        if (method === 'snapshot' || method === 'providers.detect' || method === 'agent.jobs') state.reads.push(method);
        await opening;
        if (method === 'providers.detect') return { ok: false, error: { code: 'TIMEOUT', message: 'Provider probe unavailable' } };
        const result = await handler(event, method, args);
        if (method === 'snapshot' && result.ok) {
          result.data.usage = Object.fromEntries(result.data.items.map((item: { id: string }) => [item.id, { copied: 7, used: 7 }]));
        }
        return result;
      });
    });
    await page.clock.install();
    await page.reload();
    await expect.poll(() => app.evaluate(() => (globalThis as any).startupTest.ready)).toBe(1);
    await palette.clock.install();
    await palette.reload();
    await expect.poll(() => app.evaluate(() => (globalThis as any).startupTest.ready)).toBe(2);
    await palette.clock.fastForward(30_000);
    await expect(palette.getByRole('alert')).toHaveCount(0);
    await page.clock.fastForward(30_000);
    await expect(page.getByRole('status', { name: 'Opening workbench' })).toContainText('Waiting for Kiln');
    await expect(page.getByRole('status', { name: 'Opening workbench' })).toContainText('opening the library');
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).startupTest.reads)).toEqual([]);
    await app.evaluate(() => (globalThis as any).startupTest.release());
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.locator('.startup')).toHaveCount(0);
    await expect(palette.locator('.pal-preview .pal-sub')).toContainText('copied 7×');
    await expect(palette.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(palette.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Provider probe unavailable' })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('startup failure names the opening error and Retry repeats the readiness check', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-startup-retry-'));
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      const handler = (ipcMain as any)._invokeHandlers.get('kiln:call');
      let failed = false;
      ipcMain.removeHandler('kiln:call');
      ipcMain.handle('kiln:call', async (event, method, args) => {
        if (method === 'desktop.ready' && !failed) {
          failed = true;
          return { ok: false, error: { code: 'LIBRARY_BUSY', message: 'Another process is opening this library' } };
        }
        return handler(event, method, args);
      });
    });
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('Another process is opening this library');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('a library that never opens gives a bounded startup error with Retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-startup-timeout-'));
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      const handler = (ipcMain as any)._invokeHandlers.get('kiln:call');
      (globalThis as any).startupWaiting = false;
      let attempts = 0;
      ipcMain.removeHandler('kiln:call');
      ipcMain.handle('kiln:call', (event, method, args) => {
        if (method === 'desktop.ready' && ++attempts === 1) {
          (globalThis as any).startupWaiting = true;
          return new Promise(() => {});
        }
        return handler(event, method, args);
      });
    });
    await page.clock.install();
    await page.reload();
    await expect.poll(() => app.evaluate(() => (globalThis as any).startupWaiting)).toBe(true);
    await page.clock.fastForward(120_001);
    await expect(page.getByRole('alert')).toContainText('could not finish opening the library within 120 s');
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
