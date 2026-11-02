import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

test('YouTube browser and profile save locally and survive a desktop restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln YouTube settings '));
  const home = path.join(root, 'home'), firefox = path.join(home, '.mozilla/firefox/Personal'), chrome = path.join(home, '.config/google-chrome/Default');
  fs.mkdirSync(firefox, { recursive: true }); fs.writeFileSync(path.join(firefox, 'prefs.js'), '');
  fs.mkdirSync(chrome, { recursive: true }); fs.writeFileSync(path.join(chrome, 'Preferences'), '{}');
  const env = { ...desktopEnv(root), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings & repository', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByLabel('YouTube cookies from browser').locator('option')).toHaveText(['No browser (use ~/cookies.txt if present)', 'Chrome', 'Firefox']);
    await expect(page.getByText('Draft paths on this machine', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('YouTube cookies from browser')).toHaveValue('');
    await expect(page.getByLabel('Browser profile', { exact: true })).toBeDisabled();
    await page.getByLabel('YouTube cookies from browser').selectOption('firefox');
    await page.getByLabel('Browser profile', { exact: true }).selectOption(firefox);
    await page.getByRole('button', { name: 'Save YouTube settings', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.kiln.call<{ settings: { youtubeBrowser: string } }>('snapshot')).settings.youtubeBrowser)).toBe('firefox');
    await app.close(); app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings & repository', exact: true }).click();
    await expect(page.getByLabel('YouTube cookies from browser')).toHaveValue('firefox');
    await expect(page.getByLabel('Browser profile', { exact: true })).toHaveValue(firefox);
    await page.getByLabel('YouTube cookies from browser').selectOption('chrome');
    await expect(page.getByLabel('Browser profile', { exact: true })).toHaveValue('');
    await page.getByLabel('Browser profile', { exact: true }).selectOption(chrome);
    await page.getByLabel('YouTube cookies from browser').selectOption('');
    await expect(page.getByLabel('Browser profile', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Save YouTube settings', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.kiln.call<{ settings: { youtubeBrowser: string } }>('snapshot')).settings.youtubeBrowser)).toBe('');
    await expect(page.getByLabel('Browser profile', { exact: true })).toBeDisabled();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
