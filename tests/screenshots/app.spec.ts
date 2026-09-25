/**
 * Real screenshots of the desktop app for the README and website. Builds a fictional demo machine (see seed.ts), launches the
 * built app against it, fills the library through the app's own API and takes each screenshot through the UI.
 *
 *   npm run build && npx playwright test --config tests/screenshots/playwright.config.ts
 *
 * KILN_DEMO_HOME chooses the fake home folder (C:\Users\dev in the workflow); images go to test-results/screenshots.
 */
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { environment, machine, prepareMachine, seed } from './seed';
import { captions, takeScreenshots } from './shots';

const size = { width: 1440, height: 900 };

test('screenshots of the demo library', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-screens-'));
  const m = machine(process.env.KILN_DEMO_HOME ?? path.join(scratch, 'Users', 'dev'), scratch);
  prepareMachine(m);
  // Agent runs ask for consent first; the demo machine has already accepted it.
  fs.mkdirSync(path.join(m.local, 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(m.local, 'desktop', 'agent-consent.json'), JSON.stringify({ version: 1, acceptedAt: new Date().toISOString() }));
  const out = path.resolve('test-results', 'screenshots'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const app = await electron.launch({ args: ['.'], env: environment(m) as Record<string, string> });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible({ timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows().find(w => w.isVisible()) ?? BrowserWindow.getAllWindows()[0]; window.setContentSize(size.width, size.height); window.center(); }, size);
    // A display smaller than the window clamps it; the page is then emulated at the intended size instead.
    const inner = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (inner.width !== size.width || inner.height !== size.height) await page.setViewportSize(size);
    const call = <T,>(method: string, args?: unknown) => page.evaluate(([method, args]) => window.kiln.call(method as string, args), [method, args] as const) as Promise<T>;
    const ids = await seed(call, m);
    await page.reload();
    await takeScreenshots({ page, ids, m, out, electron: true, chooseDirectory: async folder => { await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog; }, folder); } });
    fs.writeFileSync(path.join(out, 'captions.json'), JSON.stringify(captions, null, 2) + '\n');
    expect(errors).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await app.close(); }
});
