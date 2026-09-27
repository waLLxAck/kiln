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
const card = (page: Page, title: string) => page.locator('.item-card', { hasText: new RegExp(`^${title}`) });
const focusedTitle = (page: Page) => page.evaluate(() => document.activeElement?.closest('.item-card')?.querySelector('.item-title')?.textContent ?? document.activeElement?.textContent ?? '');
const stored = (page: Page, title: string) => page.evaluate(async title => (await window.kiln.call<any>('snapshot')).items.find((i: any) => i.title === title), title);
async function sortByTitle(page: Page) {
  await page.getByRole('button', { name: /^Sort:/ }).click();
  await page.getByRole('menuitem', { name: 'Title A–Z' }).click();
  await expect(page.locator('.item-card').first()).toContainText('Alpha');
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

test('keyboardUndo: list keys, Enter, the shortcut sheet, menus, undo of trash, moves and favourites, dragging onto collections', async () => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-keyboard-'));
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_EXPERIMENTS: 'keyboardUndo' } });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible();
    await seed(page, titles);
    await expect(page.locator('.item-card')).toHaveCount(8);
    // The sort menu focuses its first entry on open; Esc closes it and hands focus back to the pill.
    await page.getByRole('button', { name: /^Sort:/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Recently added' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Sort:/ })).toBeFocused();
    await sortByTitle(page);

    // Home, End and PageDown move the open row.
    await card(page, 'Charlie').click();
    await page.keyboard.press('End');
    await expect(card(page, 'Hotel')).toBeFocused(); await expect(card(page, 'Hotel')).toHaveClass(/selected/);
    await page.keyboard.press('Home');
    await expect(card(page, 'Alpha')).toBeFocused(); await expect(card(page, 'Alpha')).toHaveClass(/selected/);
    await page.keyboard.press('PageDown');
    expect(await focusedTitle(page)).not.toBe('Alpha');
    await page.keyboard.press('Home');
    // Shift+↓ twice picks three rows from the open one.
    await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
    await expect(page.getByText('3 selected', { exact: true })).toBeVisible();
    await expect(card(page, 'Charlie')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByText('3 selected', { exact: true })).toHaveCount(0);
    // Type-ahead: G is not a shortcut, so it jumps to Golf; Shift+D jumps by title although D is Move to trash.
    await card(page, 'Alpha').click();
    await page.keyboard.press('g');
    await expect(card(page, 'Golf')).toBeFocused();
    await page.waitForTimeout(1100);
    await page.keyboard.press('Shift+D');
    await expect(card(page, 'Delta')).toBeFocused();
    expect((await stored(page, 'Delta')).deletedAt).toBeNull();
    // Enter moves focus to the detail pane's main action.
    await page.waitForTimeout(1100);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.detail-pane .detail-actions')))).toBe(true);
    await expect(page.locator('.detail-pane h1')).toHaveText('Delta');

    // ? opens the sheet with platform labels; Esc closes it.
    await card(page, 'Alpha').click();
    await page.keyboard.press('?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Undo the last library action', { exact: false })).toBeVisible();
    await expect(sheet.locator('kbd', { hasText: /^(Ctrl|Cmd)$/ }).first()).toBeVisible();
    await page.screenshot({ path: 'test-results/keyboard-sheet.png' });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // D trashes with an undo toast; Undo brings it back.
    await card(page, 'Bravo').click();
    await page.keyboard.press('d');
    await expect(card(page, 'Bravo')).toHaveCount(0);
    const toast = page.locator('.undo-toast');
    await expect(toast).toContainText('Moved “Bravo” to Trash');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(card(page, 'Bravo')).toHaveCount(1);
    await expect(page.locator('.toast', { hasText: 'Undone: Moved “Bravo” to Trash' })).toBeVisible();

    // Move through the dialog, then Ctrl+Z puts it back in its collection.
    await card(page, 'Echo').click();
    await page.keyboard.press('m');
    await page.getByRole('dialog').getByRole('button', { name: 'Move to Work' }).click();
    await expect.poll(async () => (await stored(page, 'Echo')).collection).toBe('Work');
    await expect(toast).toContainText('Moved “Echo” to “Work”');
    await card(page, 'Echo').focus();
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await stored(page, 'Echo')).collection).toBe('Personal');

    // Favourite, then Ctrl+Z.
    await card(page, 'Foxtrot').click();
    await page.keyboard.press('f');
    await expect.poll(async () => (await stored(page, 'Foxtrot')).favourite).toBe(true);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await stored(page, 'Foxtrot')).favourite).toBe(false);

    // The row context menu opens with its first entry focused; ↓ then Enter runs the second (Copy).
    await card(page, 'Alpha').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Open Shortcut O' })).toBeFocused();
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
    await card(page, 'Alpha').click();
    await card(page, 'Charlie').click({ modifiers: ['Control'] });
    await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
    await dragRow(page, 'Charlie', work);
    await expect.poll(async () => [(await stored(page, 'Alpha')).collection, (await stored(page, 'Charlie')).collection]).toEqual(['Work', 'Work']);
    await expect(toast).toContainText('Moved 2 items to “Work”');
    // Unfiled shows up as a drop target while dragging, and files the item nowhere.
    await dragRow(page, 'Hotel', page.locator('.nav-item', { hasText: 'Unfiled' }));
    await expect.poll(async () => (await stored(page, 'Hotel')).collection).toBe('');

    // A sideways swipe still archives with the flag on.
    const row = page.locator('.swipe-row', { hasText: 'Delta' }), box = (await row.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + box.width * 0.45, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
    await expect.poll(async () => (await stored(page, 'Delta')).status).toBe('archived');
    await expect(toast).toContainText('Archived “Delta”');
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await stored(page, 'Delta')).status).toBe('captured');
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('keyboardUndo: bulk trash of many shows progress and one undo restores them all', async () => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-keyboard-bulk-'));
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_EXPERIMENTS: 'keyboardUndo' } });
  const page = await app.firstWindow();
  try {
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible();
    await seed(page, Array.from({ length: 60 }, (_, n) => `Bulk ${String(n).padStart(2, '0')}`));
    await expect(page.getByRole('heading', { name: /Library/ })).toContainText('60');
    // Record every progress line shown; the batches can finish faster than a poll.
    await page.evaluate(() => { const seen: string[] = ((window as any).progressSeen = []); new MutationObserver(() => { const text = document.querySelector('.progress-toast')?.textContent; if (text && !seen.includes(text)) seen.push(text); }).observe(document.body, { childList: true, subtree: true, characterData: true }); });
    await page.locator('.item-card').first().click();
    await page.keyboard.press('Control+a');
    await expect(page.getByText('60 selected', { exact: true })).toBeVisible();
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

test('keyboardUndo off: Home, ? and D behave as before', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-keyboard-off-'));
  const env = { ...desktopEnv(root) }; delete (env as Record<string, string | undefined>).KILN_EXPERIMENTS;
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  try {
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible();
    await seed(page, titles);
    await expect(page.locator('.item-card')).toHaveCount(8);
    await sortByTitle(page);
    await card(page, 'Charlie').click();
    await page.keyboard.press('Home');
    await expect(card(page, 'Charlie')).toHaveClass(/selected/);
    await expect(card(page, 'Alpha')).not.toHaveClass(/selected/);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
    await expect(page.locator('.item-card[draggable="true"]')).toHaveCount(0);
    await card(page, 'Charlie').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Open Shortcut O' })).not.toBeFocused();
    await page.keyboard.press('Escape');
    await card(page, 'Charlie').click(); await card(page, 'Charlie').focus();
    await page.keyboard.press('d');
    await expect(page.locator('.toast')).toHaveText('Moved to Trash. Restore it any time.');
    await expect(page.locator('.undo-toast')).toHaveCount(0);
    await expect(page.locator('.detail-empty small')).toHaveText('↑ ↓ move · Enter or click opens · right-click for actions');
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
