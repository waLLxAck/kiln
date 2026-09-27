import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

async function launch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-palette-'));
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'profile') } });
  const page = await app.firstWindow();
  await page.locator('.item-list').waitFor();
  return { app, page, root };
}
const create = (page: Page, title: string, content: string) => page.evaluate(async ({ title, content }) => (window as any).kiln.call('items.create', { title, kind: 'prompt', content, files: {} }) as Promise<{ id: string }>, { title, content });
async function openPalette(app: ElectronApplication, page: Page) {
  const opened = app.waitForEvent('window');
  await page.evaluate(() => (window as any).kiln.call('desktop.palette'));
  const palette = await opened;
  await expect(palette.getByRole('combobox', { name: 'Quick search' })).toBeFocused();
  return palette;
}
const visibleWindows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isVisible()).length);

test('variables fill the preview live and Enter copies the filled text; blank ones stay as {{name}}', async () => {
  const { app, page, root } = await launch();
  try {
    await create(page, 'Review for a project', 'Review {{project}} with focus on {{focus}}.');
    const palette = await openPalette(app, page);
    await palette.getByRole('combobox', { name: 'Quick search' }).fill('Review for a project');
    await expect(palette.locator('.pal-preview h2')).toHaveText('Review for a project');
    await palette.getByRole('textbox', { name: '{{project}}' }).fill('Kiln');
    await expect(palette.locator('.pal-content')).toContainText('Review Kiln with focus on {{focus}}.');
    await palette.keyboard.press('Enter');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Review Kiln with focus on {{focus}}.');
    await expect.poll(() => visibleWindows(app)).toBe(1);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('actions run in the main window; Tab lists the item actions and Esc goes back, then closes', async () => {
  const { app, page, root } = await launch();
  try {
    await create(page, 'Palette action target', 'Plain text to copy.');
    const palette = await openPalette(app, page);
    const input = palette.getByRole('combobox', { name: 'Quick search' });
    await input.fill('go sett');
    await expect(palette.getByRole('group', { name: 'Actions' }).getByRole('option', { name: 'Go to Settings' })).toHaveAttribute('aria-selected', 'true');
    await palette.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('kiln-section'))).toBe('settings');
    await expect.poll(() => visibleWindows(app)).toBe(1);

    await page.evaluate(() => (window as any).kiln.call('desktop.palette'));
    await expect(input).toBeFocused();
    await input.fill('Palette action target');
    await expect(palette.locator('.pal-preview h2')).toHaveText('Palette action target');
    await palette.keyboard.press('Tab');
    await expect(palette.getByRole('listbox', { name: 'Actions for Palette action target' })).toBeVisible();
    await expect(palette.getByRole('option', { name: 'Open in Kiln' })).toBeVisible();
    await palette.keyboard.press('Escape');
    await expect(palette.getByRole('group', { name: 'Items' })).toBeVisible();
    await palette.keyboard.press('Control+Enter');
    await expect(page.getByRole('heading', { name: 'Palette action target', exact: true })).toBeVisible();
    await expect.poll(() => visibleWindows(app)).toBe(1);

    await page.evaluate(() => (window as any).kiln.call('desktop.palette'));
    await expect(input).toBeFocused();
    await expect.poll(() => visibleWindows(app)).toBe(2);
    await palette.keyboard.press('Escape');
    await expect.poll(() => visibleWindows(app)).toBe(1);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
