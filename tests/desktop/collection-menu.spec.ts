import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('right-clicking a sidebar collection offers to delete it; trashing moves its items to the trash and an empty one just disappears', async () => {
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
    await expect(dialog).toContainText('It holds 1 item.');
    await expect(dialog.getByRole('button', { name: 'Keep items' })).toBeVisible();
    await page.screenshot({ path: 'test-results/collection-delete-dialog.png' });
    await dialog.getByRole('button', { name: 'Move items to trash' }).click();
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

test('subfolders nest in the sidebar; deleting with Keep items lifts items up one level, and Move files items anywhere without touching approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-collection-tree-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Capture Ctrl N', exact: true })).toBeVisible();
    const revision = await page.evaluate(async () => {
      const api = (window as any).kiln.call;
      await api('collections.save', { names: ['Work'] });
      await api('items.create', { kind: 'prompt', title: 'Top prompt', content: 'Top', collection: 'Work', tags: [], files: {}, source: '', licence: 'Unknown' });
      const deep = await api('items.create', { kind: 'prompt', title: 'Deep prompt', content: 'Deep', collection: 'Work/Reviews', tags: [], files: {}, source: '', licence: 'Unknown' });
      return deep.revision as string;
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    const sidebar = page.locator('.sidebar');
    const work = sidebar.getByRole('button', { name: /^Work/ }), reviews = sidebar.getByRole('button', { name: /^Reviews/ });
    await expect(work.locator('small')).toHaveText('2', { timeout: 10_000 });
    await expect(reviews.locator('small')).toHaveText('1');

    // Collapsing hides the subfolder; choosing the parent shows its subfolders' items too.
    await sidebar.getByRole('button', { name: 'Collapse Work' }).click();
    await expect(reviews).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'Expand Work' }).click();
    await work.click();
    await expect(page.locator('.item-card')).toHaveCount(2);

    // A new subfolder from the collection's menu.
    await work.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: /^New subfolder/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: 'New collection' })).toHaveValue('Work/');
    await dialog.getByRole('textbox', { name: 'New collection' }).fill('Work/Ideas');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(sidebar.getByRole('button', { name: /^Ideas/ })).toBeVisible();

    // Move an item from its context menu.
    await page.locator('.item-card', { hasText: 'Top prompt' }).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: /^Move to collection/ }).click();
    await dialog.getByRole('button', { name: 'Move to Work/Ideas' }).click();
    await expect(page.locator('.toast')).toContainText('Moved 1 item to “Work/Ideas”');
    await expect(sidebar.getByRole('button', { name: /^Ideas/ }).locator('small')).toHaveText('1');

    // Deleting the top collection and keeping the items: subfolders move to the top level, nothing is trashed.
    await work.click({ button: 'right' });
    await page.keyboard.press('d');
    await expect(dialog).toContainText('It holds 2 items and 2 subfolders.');
    await dialog.getByRole('button', { name: 'Keep items' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(work).toHaveCount(0);
    await expect(reviews.locator('small')).toHaveText('1');
    await expect(sidebar.getByRole('button', { name: /^Ideas/ })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Trash', exact: true }).locator('small')).toHaveText('');

    // Taking an item out of every collection leaves it in the library, under Unfiled, with the same revision.
    await reviews.click();
    await page.locator('.item-card', { hasText: 'Deep prompt' }).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: /^Move to collection/ }).click();
    await dialog.getByRole('button', { name: /^No collection/ }).click();
    const unfiled = sidebar.getByRole('button', { name: /^Unfiled/ });
    await expect(unfiled.locator('small')).toHaveText('1');
    await unfiled.click();
    await expect(unfiled).toHaveClass(/active/); await expect(reviews).not.toHaveClass(/active/);
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(page.locator('.item-card', { hasText: 'Deep prompt' })).toBeVisible();
    const after = await page.evaluate(async () => (await (window as any).kiln.call('snapshot')).items.find((i: any) => i.title === 'Deep prompt'));
    expect(after.collection).toBe(''); expect(after.revision).toBe(revision);
    await page.waitForTimeout(250); await page.screenshot({ path: 'test-results/collection-tree.png' });
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
