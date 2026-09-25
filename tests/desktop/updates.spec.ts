import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('prepare keeps the app open and usable; restart waits for a second click even after reopening', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-update-ui-'));
  const source = path.join(root, 'release'); fs.mkdirSync(source);
  const installer = path.join(source, 'Kiln Setup 99.0.0.exe');
  fs.writeFileSync(installer, Buffer.alloc(8 * 1024 * 1024, 42));
  const env = desktopEnv(root);
  const launch = () => electron.launch({ ...(process.env.KILN_UPDATE_EXE ? { executablePath: process.env.KILN_UPDATE_EXE } : { args: ['.'] }), env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.evaluate(async source => { await window.kiln.call('desktop.updateSource', { path: source }); }, source);
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    const panel = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Updates', exact: true }) });
    await panel.getByRole('button', { name: 'Check now' }).click();
    const pid = app.process().pid;
    await panel.getByRole('button', { name: 'Prepare update', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Restart to update', exact: true })).toBeVisible();
    expect(app.process().pid).toBe(pid); expect(app.process().exitCode).toBeNull();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Capture Ctrl N', exact: true }).click();
    await page.getByLabel('Idea', { exact: true }).fill('I can still work while the update waits.');
    await expect(page.getByLabel('Idea', { exact: true })).toHaveValue('I can still work while the update waits.');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: 'artifacts/update-ready.png' });
    fs.unlinkSync(installer);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Restart to update', exact: true }).first()).toBeVisible();
    const status = await page.evaluate(() => window.kiln.call<{ stage: { state: string; version: string } }>('desktop.updateCheck'));
    expect(status.stage).toEqual({ state: 'ready', version: '99.0.0' });
    expect(app.process().exitCode).toBeNull();
    const cache = path.join(root, 'private', 'desktop', 'updates');
    const record = JSON.parse(fs.readFileSync(path.join(cache, 'ready.json'), 'utf8'));
    fs.writeFileSync(path.join(cache, record.folder, 'Kiln Setup 99.0.0.exe'), Buffer.alloc(record.size, 43));
    await page.getByRole('button', { name: 'Restart to update', exact: true }).first().click();
    await expect(page.getByText(/The prepared installer changed/).first()).toBeVisible();
    expect(app.process().exitCode).toBeNull();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
