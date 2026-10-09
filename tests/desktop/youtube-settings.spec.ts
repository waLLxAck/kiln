import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

test('YouTube browser and profile save locally and survive a desktop restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln YouTube settings '));
  const env = desktopEnv(root);
  let app = await electron.launch({ args: ['.'], env });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings & repository', exact: true }).click();
    await expect(page.getByLabel('YouTube cookies from browser')).toHaveValue('');
    await expect(page.getByLabel('Browser profile', { exact: true })).toBeDisabled();
    await page.getByLabel('YouTube cookies from browser').selectOption('firefox');
    await page.getByLabel('Browser profile', { exact: true }).fill('Personal');
    await page.getByRole('button', { name: 'Save YouTube settings', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.kiln.call<{ settings: { youtubeBrowser: string } }>('snapshot')).settings.youtubeBrowser)).toBe('firefox');
    await app.close(); app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings & repository', exact: true }).click();
    await expect(page.getByLabel('YouTube cookies from browser')).toHaveValue('firefox');
    await expect(page.getByLabel('Browser profile', { exact: true })).toHaveValue('Personal');
    await page.getByLabel('YouTube cookies from browser').selectOption('chrome');
    await expect(page.getByLabel('Browser profile', { exact: true })).toHaveValue('');
    await page.getByLabel('Browser profile', { exact: true }).fill('Chrome profile');
    await page.getByLabel('YouTube cookies from browser').selectOption('');
    await expect(page.getByLabel('Browser profile', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Save YouTube settings', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.kiln.call<{ settings: { youtubeBrowser: string } }>('snapshot')).settings.youtubeBrowser)).toBe('');
    await expect(page.getByLabel('Browser profile', { exact: true })).toBeDisabled();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
