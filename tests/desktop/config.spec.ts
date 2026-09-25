import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('config editor creates valid settings, rejects bad JSON, restores backups and finds project hooks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-config-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const project = path.join(root, 'project'); fs.mkdirSync(path.join(project, '.github', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(project, '.github', 'hooks', 'session.json'), '{"version":1,"hooks":{}}');
  const app = await electron.launch({ ...(process.env.KILN_CONFIG_EXE ? { executablePath: process.env.KILN_CONFIG_EXE } : { args: ['.'] }), env: { ...desktopEnv(root), KILN_HOME: home } });
  const page = await app.firstWindow();
  try {
    await page.getByRole('button', { name: 'Config files', exact: true }).click();
    await page.getByLabel('Filter config files').fill('claude settings.json');
    await page.locator('.item-card').filter({ hasText: 'settings.json' }).first().click();
    await page.getByRole('button', { name: 'Create file', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'settings.json content', exact: true });
    await expect(editor).toHaveValue('{}\n');
    await editor.fill('{"permissions":{"deny":["Read(.env)"]},"hooks":{}}\n');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toContain('Read(.env)');
    await editor.fill('{broken');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Configuration was not saved/)).toBeVisible();
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toContain('Read(.env)');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await page.getByRole('button', { name: 'Previous versions', exact: true }).click();
    await page.locator('.revision-row').first().click();
    await page.getByRole('button', { name: 'Restore this version', exact: true }).click();
    await expect(editor).toHaveValue('{}\n');
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
    await page.getByRole('button', { name: 'Add project folder', exact: true }).click();
    await page.getByLabel('Filter config files').fill('session.json');
    await page.locator('.item-card').filter({ hasText: 'session.json' }).click();
    await expect(page.getByRole('textbox', { name: 'session.json content' })).toHaveValue('{"version":1,"hooks":{}}');
    await expect(page.getByRole('button', { name: 'Copy to library', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/config-files.png' });
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
