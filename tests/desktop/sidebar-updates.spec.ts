import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../../packages/domain/workbench';
import type { UpdateStatus } from '../../packages/protocol/schema';
import { desktopEnv, readyLibrary } from './fixture';

async function fixture(install: 'app' | 'download') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-sidebar-updates-'));
  const library = readyLibrary(root), wb = new Workbench(library, path.join(root, 'private'));
  try {
    for (let n = 0; n < 35; n++) wb.createCollection({ name: `Collection ${n}` });
  } finally { wb.close(); }
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  const status: UpdateStatus = { current: '0.25.3', source: 'https://github.com/waLLxAck/kiln/releases', sourceKind: 'github', packaged: true, available: { version: '99.0.0', path: 'https://github.com/waLLxAck/kiln/releases/tag/v99.0.0' }, stage: { state: 'idle' }, commit: '', install };
  await app.evaluate(({ ipcMain }, status) => {
    const handler = (ipcMain as any)._invokeHandlers.get('kiln:call');
    const state = (globalThis as any).sidebarUpdatesTest = { status, prepared: [] as unknown[], restarts: 0, urls: [] as string[] };
    ipcMain.removeHandler('kiln:call');
    ipcMain.handle('kiln:call', async (event, method, args) => {
      if (method === 'desktop.updateCheck') return { ok: true, data: state.status };
      if (method === 'desktop.updatePrepare') {
        state.prepared.push(args);
        state.status.stage = { state: 'preparing', version: '99.0.0', progress: 37 };
        return { ok: true, data: state.status };
      }
      if (method === 'desktop.updateRestart') { state.restarts++; return { ok: true, data: true }; }
      if (method === 'desktop.openUrl') { state.urls.push(args.url); return { ok: true, data: true }; }
      return handler(event, method, args);
    });
  }, status);
  await page.reload();
  const footer = page.locator('.sidebar-foot');
  await expect(footer).toContainText('v0.25.3');
  return { app, page, footer, close: async () => { await app.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } };
}

test('the bottom-left updater stays visible with scrolling navigation and keeps download and restart separate', async () => {
  const f = await fixture('app');
  try {
    const download = f.footer.getByRole('button', { name: 'Download update', exact: true });
    await expect(download).toBeVisible();
    await expect(f.page.locator('.status-bar').getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0);
    const layout = await f.footer.evaluate(footer => {
      const rect = footer.getBoundingClientRect(), nav = document.querySelector('.rail-nav')!;
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, scrolls: nav.scrollHeight > nav.clientHeight };
    });
    expect(layout.left).toBeLessThan(30);
    expect(layout.right).toBeLessThan(layout.width / 2);
    expect(layout.top).toBeGreaterThan(layout.height - 110);
    expect(layout.bottom).toBeLessThanOrEqual(layout.height);
    expect(layout.scrolls).toBe(true);
    await f.page.locator('.rail-nav').evaluate(nav => { nav.scrollTop = nav.scrollHeight; });
    await expect(download).toBeInViewport();
    await f.page.screenshot({ path: 'artifacts/sidebar-update-available.png' });
    await download.click();
    await expect(f.footer.getByRole('button', { name: 'Downloading update 37%' })).toBeDisabled();
    expect(await f.app.evaluate(() => (globalThis as any).sidebarUpdatesTest.prepared)).toEqual([{ version: '99.0.0' }]);
    expect(await f.app.evaluate(() => (globalThis as any).sidebarUpdatesTest.restarts)).toBe(0);
    await f.app.evaluate(() => { (globalThis as any).sidebarUpdatesTest.status.stage = { state: 'ready', version: '99.0.0' }; });
    await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const restart = f.footer.getByRole('button', { name: 'Restart to update', exact: true });
    await expect(restart).toBeVisible();
    expect(await f.app.evaluate(() => (globalThis as any).sidebarUpdatesTest.restarts)).toBe(0);
    await f.page.screenshot({ path: 'artifacts/sidebar-update-ready.png' });
    await restart.click();
    await expect.poll(() => f.app.evaluate(() => (globalThis as any).sidebarUpdatesTest.restarts)).toBe(1);
    expect(f.app.process().exitCode).toBeNull();
  } finally { await f.close(); }
});

test('the bottom-left update shortcut opens the release page for a copy that cannot install itself', async () => {
  const f = await fixture('download');
  try {
    await f.footer.getByRole('button', { name: 'Get Kiln 99.0.0', exact: true }).click();
    await expect.poll(() => f.app.evaluate(() => (globalThis as any).sidebarUpdatesTest.urls)).toEqual(['https://github.com/waLLxAck/kiln/releases/tag/v99.0.0']);
    expect(await f.app.evaluate(() => (globalThis as any).sidebarUpdatesTest.prepared)).toEqual([]);
    expect(await f.app.evaluate(() => (globalThis as any).sidebarUpdatesTest.restarts)).toBe(0);
  } finally { await f.close(); }
});
