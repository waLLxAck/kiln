import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
async function seed(page: Page, names: string[], collection = 'Personal') {
  await page.evaluate(async ({ names, collection }) => {
    await window.kiln.call('collections.create', { name: 'Work' });
    for (const title of names) await window.kiln.call('items.create', { kind: 'prompt', title, content: `Body of ${title}`, collection, tags: [], files: {}, source: '', licence: 'Unknown' });
  }, { names, collection });
  await page.getByRole('button', { name: 'Refresh library' }).click();
}
/** A library row by its title. Collection is the first column, so the row's text does not start with the title. */
const card = (page: Page, title: string) => page.locator('.item-card').filter({ has: page.locator('.item-title', { hasText: new RegExp(`^${title}$`) }) });
const focusedTitle = (page: Page) => page.evaluate(() => document.activeElement?.closest('.item-card')?.querySelector('.item-title')?.textContent ?? document.activeElement?.textContent ?? '');
const stored = (page: Page, title: string) => page.evaluate(async title => (await window.kiln.call<any>('snapshot')).items.find((i: any) => i.title === title), title);
/** Focuses a row without opening it: clicking opens the item page, and Esc comes back with focus on the row. */
async function focusRow(page: Page, title: string) {
  await card(page, title).click();
  await expect(page.locator('.item-page h1')).toHaveText(title);
  await page.keyboard.press('Escape');
  await expect(card(page, title)).toBeFocused();
}
async function sortByTitle(page: Page) {
  await page.getByRole('button', { name: /^Sort:/ }).click();
  await page.getByRole('menuitem', { name: 'Title A–Z' }).click();
  await expect(page.locator('.item-card .item-title').first()).toHaveText('Alpha');
}
/** Native drag: a short vertical move first (so it is not a swipe), then over the sidebar target. */
async function dragRow(page: Page, title: string, target: ReturnType<Page['locator']>) {
  const from = (await card(page, title).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 14, { steps: 4 });
  // Measured once the drag runs: Unfiled only shows while items are dragged when nothing is unfiled.
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  // Playwright delivers the drag over the target on the next move.
  await page.mouse.move(to.x + to.width / 2 + 2, to.y + to.height / 2, { steps: 2 });
  await expect(target).toHaveAttribute('data-item-drop', 'true');
  await page.mouse.up();
}

test('library keys, Enter, type-ahead, the shortcut sheet, menus, undo of trash, moves and favourites, dragging onto collections', async () => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-keyboard-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible();
    await seed(page, titles);
    await expect(page.locator('.item-card')).toHaveCount(8);
    // The sort menu focuses its first entry on open; End goes to the last; Esc closes it and hands focus back to the pill.
    await page.getByRole('button', { name: /^Sort:/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Recently added' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem').last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Sort:/ })).toBeFocused();
    await sortByTitle(page);

    // Esc back from an item puts focus on its row; Home, End and PageDown move the open row from there.
    await focusRow(page, 'Charlie');
    await page.keyboard.press('End');
    await expect(card(page, 'Hotel')).toBeFocused(); await expect(card(page, 'Hotel')).toHaveClass(/selected/);
    await page.keyboard.press('Home');
    await expect(card(page, 'Alpha')).toBeFocused(); await expect(card(page, 'Alpha')).toHaveClass(/selected/);
    await page.keyboard.press('PageDown');
    await expect.poll(() => focusedTitle(page)).not.toBe('Alpha');
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('selected'))).toBe(true);
    await page.keyboard.press('Home');
    // Shift+↓ twice picks three rows from the open one; Shift+End extends to the last.
    await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
    await expect(page.getByText('3 selected', { exact: true })).toBeVisible();
    await expect(card(page, 'Charlie')).toBeFocused();
    await page.keyboard.press('Shift+End');
    await expect(page.getByText('8 selected', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText(/^\d+ selected$/)).toHaveCount(0);
    // Type-ahead: G is not a shortcut, so it jumps to Golf; Shift+D jumps by title although D is Move to trash, and the
    // letters typed right after extend the title instead of running their shortcuts (E opens the stored file, L removes copies).
    await focusRow(page, 'Alpha');
    await page.keyboard.press('g');
    await expect(card(page, 'Golf')).toBeFocused();
    await page.waitForTimeout(1100);
    await page.keyboard.press('Shift+D'); await page.keyboard.press('e'); await page.keyboard.press('l');
    await expect(card(page, 'Delta')).toBeFocused();
    expect((await stored(page, 'Delta')).deletedAt).toBeNull();
    // Enter opens the item and moves focus to its header's main action.
    await page.waitForTimeout(1100);
    await page.keyboard.press('Enter');
    await expect(page.locator('.item-page h1')).toHaveText('Delta');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.item-page .detail-actions')))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(card(page, 'Delta')).toBeFocused();

    // ? opens the sheet with platform labels; Esc closes it.
    await page.keyboard.press('?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Undo the last library action', { exact: false })).toBeVisible();
    await expect(sheet.locator('kbd', { hasText: /^(Ctrl|Cmd)$/ }).first()).toBeVisible();
    await page.waitForTimeout(250); await page.screenshot({ path: 'test-results/keyboard-sheet.png' });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // D trashes with an undo toast; Undo brings it back.
    await card(page, 'Bravo').focus();
    await page.keyboard.press('d');
    await expect(card(page, 'Bravo')).toHaveCount(0);
    const toast = page.locator('.undo-toast');
    await expect(toast).toContainText('Moved “Bravo” to Trash');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(card(page, 'Bravo')).toHaveCount(1);
    await expect(page.locator('.toast', { hasText: 'Undone: Moved “Bravo” to Trash' })).toBeVisible();

    // Move through the dialog, then Ctrl+Z puts it back in its collection.
    await card(page, 'Echo').focus();
    await page.keyboard.press('m');
    await page.getByRole('dialog').getByRole('button', { name: 'Move to Work' }).click();
    await expect.poll(async () => (await stored(page, 'Echo')).collection).toBe('Work');
    await expect(toast).toContainText('Moved “Echo” to “Work”');
    await card(page, 'Echo').focus();
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await stored(page, 'Echo')).collection).toBe('Personal');

    // Favourite, then Ctrl+Z.
    await card(page, 'Foxtrot').focus();
    await page.keyboard.press('f');
    await expect.poll(async () => (await stored(page, 'Foxtrot')).favourite).toBe(true);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await stored(page, 'Foxtrot')).favourite).toBe(false);

    // The row context menu opens with its first entry focused; Tab closes it and focus goes back to the row.
    await card(page, 'Alpha').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Open Shortcut O' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await expect(card(page, 'Alpha')).toBeFocused();
    // Shift+F10 opens it from the keyboard, under the row; ↓ then Enter runs the second entry (Copy).
    await page.keyboard.press('Shift+F10');
    await expect(menu.getByRole('menuitem', { name: 'Open Shortcut O' })).toBeFocused();
    const row = (await card(page, 'Alpha').boundingBox())!, opened = (await menu.boundingBox())!;
    expect(opened.y).toBeGreaterThan(row.y);
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Copy Shortcut C' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('.toast', { hasText: 'Copied to clipboard' })).toBeVisible();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Body of Alpha');

    // Drag a row onto a sidebar collection; Ctrl+Z moves it back.
    const work = page.locator('.collection-node', { hasText: 'Work' });
    await dragRow(page, 'Golf', work);
    await expect.poll(async () => (await stored(page, 'Golf')).collection).toBe('Work');
    await expect(toast).toContainText('Moved “Golf” to “Work”');
    await page.screenshot({ path: 'test-results/keyboard-drag.png' });
    await card(page, 'Golf').focus();
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await stored(page, 'Golf')).collection).toBe('Personal');
    // Dragging a picked row takes the whole selection.
    await focusRow(page, 'Alpha');
    await card(page, 'Charlie').click({ modifiers: ['Control'] });
    await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
    await dragRow(page, 'Charlie', work);
    await expect.poll(async () => [(await stored(page, 'Alpha')).collection, (await stored(page, 'Charlie')).collection]).toEqual(['Work', 'Work']);
    await expect(toast).toContainText('Moved 2 items to “Work”');
    // Unfiled shows up as a drop target while dragging, and files the item nowhere.
    await dragRow(page, 'Hotel', page.locator('.nav-item', { hasText: 'Unfiled' }));
    await expect.poll(async () => (await stored(page, 'Hotel')).collection).toBe('');

    // Dragging a column heading sideways moves the column; it neither drags items nor swipes rows.
    const status = page.locator('.lib-row.head [data-col="status"]'), heading = (await status.boundingBox())!, first = (await page.locator('.lib-row.head [data-col]').first().boundingBox())!;
    await page.mouse.move(heading.x + 10, heading.y + heading.height / 2); await page.mouse.down();
    await page.mouse.move(first.x + 2, heading.y + heading.height / 2, { steps: 8 }); await page.mouse.up();
    await expect(page.locator('.lib-row.head [data-col]').first()).toHaveAttribute('data-col', 'status');
    await expect(page.locator('[data-item-drop]')).toHaveCount(0);
    expect((await stored(page, 'Delta')).status).toBe('captured');
    await page.locator('.lib-row.head').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reset columns' }).click();

    // A sideways swipe still archives, and Ctrl+Z brings it back.
    const swipe = page.locator('.swipe-row', { has: card(page, 'Delta') }), box = (await swipe.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + box.width * 0.45, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    await expect.poll(async () => (await stored(page, 'Delta')).status).toBe('archived');
    await expect(toast).toContainText('Archived “Delta”');
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await stored(page, 'Delta')).status).toBe('captured');

    // While a search orders by relevance, no column heading shows as sorted; clearing it brings Title A–Z back.
    const bar = page.getByRole('combobox', { name: 'Search library' });
    await bar.fill('Body');
    await expect(page.getByRole('button', { name: /^Sort:/ })).toContainText('Relevance');
    await expect(page.locator('.lib-row.head .sorted')).toHaveCount(0);
    await expect(page.locator('.lib-row.head [aria-sort="ascending"], .lib-row.head [aria-sort="descending"]')).toHaveCount(0);
    await bar.fill('');
    await expect(page.locator('.lib-row.head [data-col="title"]')).toHaveAttribute('aria-sort', 'ascending');
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('bulk trash of many shows progress and one undo restores them all', async () => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-keyboard-bulk-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow();
  try {
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible();
    await seed(page, Array.from({ length: 60 }, (_, n) => `Bulk ${String(n).padStart(2, '0')}`));
    await expect(page.getByRole('heading', { name: /Library/ })).toContainText('60');
    // Record every progress line shown; the batches can finish faster than a poll.
    await page.evaluate(() => { const seen: string[] = ((window as any).progressSeen = []); new MutationObserver(() => { const text = document.querySelector('.progress-toast')?.textContent; if (text && !seen.includes(text)) seen.push(text); }).observe(document.body, { childList: true, subtree: true, characterData: true }); });
    await page.locator('.item-card').first().focus();
    await page.keyboard.press('Control+a');
    await expect(page.getByText('60 selected', { exact: true })).toBeVisible();
    // Picking every row keeps focus on the list, so the shortcut still reaches it.
    await page.keyboard.press('d');
    await expect(page.locator('.undo-toast')).toContainText('Moved 60 items to Trash', { timeout: 60_000 });
    await expect(page.locator('.item-card')).toHaveCount(0);
    const seen: string[] = await page.evaluate(() => (window as any).progressSeen);
    expect(seen.some(text => /^Moving \d+ of 60 to Trash…$/.test(text))).toBe(true);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.item-card')).toHaveCount(60, { timeout: 60_000 });
    await expect(page.locator('.toast', { hasText: 'Undone: Moved 60 items to Trash' })).toBeVisible();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
