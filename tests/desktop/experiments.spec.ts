import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('experimental features start off, switch on one at a time and survive a restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-experiments-'));
  const env = { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'profile') };
  delete (env as Record<string, string | undefined>).KILN_EXPERIMENTS;
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await page.locator('.item-list').waitFor();
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    const card = page.getByRole('region', { name: 'Experimental features' });
    await expect(card).toContainText('all off');
    const switches = card.getByRole('switch');
    await expect(switches).toHaveCount(10);
    for (const s of await switches.all()) await expect(s).not.toBeChecked();
    await card.getByRole('switch', { name: 'Code editor' }).click();
    await expect(card.getByRole('switch', { name: 'Code editor' })).toBeChecked();
    await expect(card).toContainText('1 on');
    await expect(card.getByRole('switch', { name: 'Update installed copies' })).not.toBeChecked();
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings & repository' }).waitFor();
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await expect(page.getByRole('region', { name: 'Experimental features' }).getByRole('switch', { name: 'Code editor' })).toBeChecked();
    await page.getByRole('region', { name: 'Experimental features' }).getByRole('switch', { name: 'Code editor' }).click();
    await expect(page.getByRole('region', { name: 'Experimental features' })).toContainText('all off');
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
