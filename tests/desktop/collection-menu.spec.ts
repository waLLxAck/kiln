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

    // A new subfolder from the collection's menu appears at once, named in place.
    await work.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: /^New subfolder/ }).click();
    const naming = sidebar.getByRole('textbox', { name: 'Name for Work/New Folder' });
    await expect(naming).toBeFocused();
    await naming.fill('Ideas'); await naming.press('Enter');
    await expect(sidebar.getByRole('button', { name: /^Ideas/ })).toBeVisible();
    await expect(naming).toHaveCount(0);
    const dialog = page.getByRole('dialog');

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

test('new folders are named in place, and dragging a collection nests it, reorders it or lifts it to the top level', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-collection-drag-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const names = () => page.evaluate(async () => (await (window as any).kiln.call('snapshot')).collections as string[]);
  try {
    await expect(page.getByRole('button', { name: 'Capture Ctrl N', exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const api = (window as any).kiln.call;
      await api('collections.save', { names: ['Alpha', 'Beta', 'Gamma'] });
      await api('items.create', { kind: 'prompt', title: 'Gamma prompt', content: 'In Gamma', collection: 'Gamma', tags: [], files: {}, source: '', licence: 'Unknown' });
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    const sidebar = page.locator('.sidebar'), folder = (name: RegExp) => sidebar.getByRole('button', { name });
    await expect(folder(/^Gamma/).locator('small')).toHaveText('1', { timeout: 10_000 });

    // The + makes "New Folder" straight away with its name selected, so typing replaces it.
    await sidebar.getByRole('button', { name: 'New collection' }).click();
    const untitled = sidebar.getByRole('textbox', { name: 'Name for New Folder' });
    await expect(untitled).toBeFocused(); await expect(untitled).toHaveValue('New Folder');
    expect(await untitled.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 10]);
    await page.keyboard.type('Delta'); await page.keyboard.press('Enter');
    await expect(folder(/^Delta/)).toBeVisible();

    // Escape keeps the folder under its current name, like a file manager.
    await sidebar.getByRole('button', { name: 'New collection' }).click();
    await expect(untitled).toBeFocused(); await page.keyboard.press('Escape');
    await expect(untitled).toHaveCount(0); await expect(folder(/^New Folder/)).toBeVisible();
    await sidebar.getByRole('button', { name: 'New collection' }).click();
    await expect(sidebar.getByRole('textbox', { name: 'Name for New Folder 2' })).toBeFocused();
    await page.keyboard.press('Escape');

    // Rename from the menu is in place too; a clash shows the error and keeps the field open.
    await folder(/^Alpha/).click({ button: 'right' });
    await expect(page.getByRole('menu').getByRole('menuitem', { name: /^Rename/ })).not.toContainText('…');
    await page.getByRole('menu').getByRole('menuitem', { name: /^Rename/ }).click();
    const alpha = sidebar.getByRole('textbox', { name: 'Name for Alpha' });
    await alpha.fill('beta'); await alpha.press('Enter');
    await expect(page.locator('.global-error')).toContainText('already exists');
    await expect(alpha).toBeVisible();
    await alpha.fill('Aleph'); await alpha.press('Enter');
    await expect(folder(/^Aleph/)).toBeVisible(); await expect(alpha).toHaveCount(0);
    await expect(page.locator('.global-error')).toHaveCount(0);

    // F2 renames the focused collection.
    await folder(/^New Folder 2/).focus(); await page.keyboard.press('F2');
    await sidebar.getByRole('textbox', { name: 'Name for New Folder 2' }).fill('Epsilon'); await page.keyboard.press('Enter');
    await expect(folder(/^Epsilon/)).toBeVisible();
    expect(await names()).toEqual(['Aleph', 'Beta', 'Gamma', 'Delta', 'New Folder', 'Epsilon']);

    // Dropping on the middle of a row nests the collection there; the open view follows it.
    const node = (name: string) => sidebar.locator('.collection-node', { has: page.getByRole('button', { name: new RegExp(`^${name}`) }) });
    const dropOn = async (source: string, target: string, where: 'before' | 'into' | 'after') => {
      const box = (await node(target).boundingBox())!;
      await node(source).dragTo(node(target), { targetPosition: { x: box.width / 2, y: where === 'before' ? 3 : where === 'after' ? box.height - 3 : box.height / 2 } });
    };
    await folder(/^Gamma/).click();
    await expect(page.locator('.item-card')).toHaveCount(1);
    // While dragging, the row under the pointer shows where it will land: lit up for inside, a line for beside; itself never.
    const at = async (name: string, y: (height: number) => number) => { const box = (await node(name).boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + y(box.height), { steps: 4 }); };
    await at('Gamma', h => h / 2); await page.mouse.down();
    await at('Beta', h => h / 2); await expect(node('Beta')).toHaveAttribute('data-drop', 'into');
    await at('Beta', () => 2); await expect(node('Beta')).toHaveAttribute('data-drop', 'before');
    await page.screenshot({ path: 'test-results/collection-drag-line.png' });
    await at('Gamma', h => h / 2); await expect(node('Gamma')).not.toHaveAttribute('data-drop', /./); await expect(node('Beta')).not.toHaveAttribute('data-drop', /./);
    await page.keyboard.press('Escape'); await page.mouse.up();
    expect(await names()).toEqual(['Aleph', 'Beta', 'Gamma', 'Delta', 'New Folder', 'Epsilon']);
    await dropOn('Gamma', 'Beta', 'into');
    await expect.poll(names).toEqual(['Aleph', 'Beta', 'Beta/Gamma', 'Delta', 'New Folder', 'Epsilon']);
    await expect(node('Gamma')).toHaveCSS('padding-left', '14px');
    await expect(folder(/^Gamma/)).toHaveClass(/active/);
    await expect(page.locator('.item-card', { hasText: 'Gamma prompt' })).toBeVisible();

    // The top edge of a row places it before that row.
    await dropOn('Delta', 'Aleph', 'before');
    await expect.poll(names).toEqual(['Delta', 'Aleph', 'Beta', 'Beta/Gamma', 'New Folder', 'Epsilon']);
    // The bottom edge places it after, taking it out of its parent in the same gesture.
    await dropOn('Gamma', 'New Folder', 'after');
    await expect.poll(names).toEqual(['Delta', 'Aleph', 'Beta', 'New Folder', 'Gamma', 'Epsilon']);
    // A collection cannot go inside itself or its own subfolders.
    await dropOn('Epsilon', 'Gamma', 'into');
    await expect.poll(names).toEqual(['Delta', 'Aleph', 'Beta', 'New Folder', 'Gamma', 'Gamma/Epsilon']);
    await dropOn('Gamma', 'Epsilon', 'into');
    await page.waitForTimeout(300);
    expect(await names()).toEqual(['Delta', 'Aleph', 'Beta', 'New Folder', 'Gamma', 'Gamma/Epsilon']);
    // The COLLECTIONS heading takes a collection to the top level, last.
    await node('Epsilon').dragTo(sidebar.locator('.collection-label'));
    await expect.poll(names).toEqual(['Delta', 'Aleph', 'Beta', 'New Folder', 'Gamma', 'Epsilon']);
    expect((await page.evaluate(async () => (await (window as any).kiln.call('snapshot')).items))[0].collection).toBe('Gamma');

    // Manage collections: a New folder button and per-row subfolders, both named in place.
    await folder(/^Delta/).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: /^Manage collections/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Name for New Folder 2' })).toBeFocused();
    await page.keyboard.type('Zeta'); await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: /^Zeta/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Add a subfolder to Zeta' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Name for Zeta/New Folder' })).toBeFocused();
    await page.keyboard.type('Inner'); await page.keyboard.press('Enter');
    await expect(dialog.getByRole('button', { name: /^Inner/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Move Zeta up' }).click();
    await expect.poll(names).toEqual(['Delta', 'Aleph', 'Beta', 'New Folder', 'Gamma', 'Zeta', 'Zeta/Inner', 'Epsilon']);
    // Rows in the dialog drag the same way.
    const row = (name: string) => dialog.locator('.collection-row', { has: page.getByRole('button', { name: `Rename ${name}`, exact: true }) });
    await row('Epsilon').dragTo(row('Delta'));
    await expect.poll(names).toEqual(['Delta', 'Delta/Epsilon', 'Aleph', 'Beta', 'New Folder', 'Gamma', 'Zeta', 'Zeta/Inner']);
    await page.waitForTimeout(250); await page.screenshot({ path: 'test-results/collection-dialog-inline.png' });
    await dialog.getByRole('button', { name: 'Done' }).click();
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
