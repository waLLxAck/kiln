import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('right-clicking a sidebar collection offers to delete it; its items move to the trash and an empty one just disappears', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-collection-menu-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Capture Ctrl N', exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const api = (window as any).kiln.call;
      await api('collections.save', { names: ['Personal', 'Scratch', 'Empty'] });
      await api('items.create', { kind: 'prompt', title: 'Kept prompt', content: 'Stays', collection: 'Personal', tags: [], files: {}, source: '', licence: 'Unknown' });
      await api('items.create', { kind: 'prompt', title: 'Doomed prompt', content: 'Goes', collection: 'Scratch', tags: [], files: {}, source: '', licence: 'Unknown' });
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await expect(page.locator('.item-card')).toHaveCount(2);
    const sidebar = page.locator('.sidebar');
    const scratch = sidebar.getByRole('button', { name: /^Scratch/ });
    await expect(scratch.locator('small')).toHaveText('1');

    // Right-click opens a menu; Delete is the danger entry with the D shortcut.
    await scratch.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Show in library/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Delete collection/ })).toHaveClass(/danger/);
    await expect(menu.getByRole('menuitem', { name: /^Delete collection/ }).locator('kbd')).toHaveText('D');
    await page.waitForTimeout(250); await page.screenshot({ path: 'test-results/collection-menu.png' });
    await menu.getByRole('menuitem', { name: /^Delete collection/ }).click();

    // The dialog says how many items are affected and where they go.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Delete “Scratch”?' })).toBeVisible();
    await expect(dialog).toContainText('1 item will move to the trash.');
    await page.screenshot({ path: 'test-results/collection-delete-dialog.png' });
    await dialog.getByRole('button', { name: 'Delete collection' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(scratch).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Deleted “Scratch”; 1 item moved to the trash');
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(page.locator('.item-card', { hasText: 'Kept prompt' })).toBeVisible();

    // The item is in the trash, not gone.
    await sidebar.getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(page.locator('.item-card', { hasText: 'Doomed prompt' })).toBeVisible();

    // An empty collection: the D key runs the entry, the dialog says it is empty, and confirming just removes it.
    const empty = sidebar.getByRole('button', { name: /^Empty/ });
    await empty.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('d');
    await expect(menu).toHaveCount(0);
    await expect(dialog).toContainText('This collection is empty.');
    await dialog.getByRole('button', { name: 'Delete collection' }).click();
    await expect(empty).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: /^Personal/ })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
