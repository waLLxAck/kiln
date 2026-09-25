import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
async function createItem(page: Page, title: string) {
  await page.evaluate(async title => { await (window as any).kiln.call('items.create', { kind: 'prompt', title, content: `Body of ${title}`, collection: 'Personal', tags: [], files: {}, source: '', licence: 'Unknown' }); }, title);
  await page.getByRole('button', { name: 'Refresh library' }).click();
}
const card = (page: Page, title: string) => page.locator('.item-card', { hasText: title });

test('context menu shows single-key shortcuts; A archives with a short undo; swiping a card archives it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-menu-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible();
    await createItem(page, 'First prompt'); await createItem(page, 'Second prompt'); await createItem(page, 'Third prompt');
    await expect(page.locator('.item-card')).toHaveCount(3);

    // Right-click menu: shortcut keys are printed on the right of each row.
    await card(page, 'First prompt').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Copy/ }).locator('kbd')).toHaveText('C');
    await expect(menu.getByRole('menuitem', { name: /^Archived/ }).locator('kbd')).toHaveText('A');
    await expect(menu.getByRole('menuitem', { name: /^Move to trash/ }).locator('kbd')).toHaveText('D');
    await expect(menu.getByRole('menuitem', { name: /^Approved/ })).toBeDisabled();
    await page.waitForTimeout(250); await page.screenshot({ path: 'test-results/context-menu.png' });
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await card(page, 'First prompt').click({ button: 'right' });
    await expect(menu).toBeVisible(); await page.waitForTimeout(250); await page.screenshot({ path: 'test-results/context-menu-dark.png' });

    // Pressing the key while the menu is open runs that entry; the item moves to the archive and an undo toast appears.
    await page.keyboard.press('a');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('.item-card')).toHaveCount(2);
    const toast = page.locator('.undo-toast');
    await expect(toast).toContainText('Archived First prompt');
    await page.screenshot({ path: 'test-results/undo-toast.png' });
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.item-card')).toHaveCount(3);
    await expect(toast).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('First prompt is back in captured');

    // The same key works on a focused card without opening the menu, and the toast leaves on its own after 3 seconds.
    await card(page, 'Second prompt').click();
    await card(page, 'Second prompt').focus();
    await page.keyboard.press('a');
    await expect(page.locator('.item-card')).toHaveCount(2);
    await expect(toast).toContainText('Archived Second prompt');
    await page.mouse.move(0, 0);
    await expect(toast).toHaveCount(0, { timeout: 10000 });

    // Swiping a card sideways archives it too; a new archive replaces the previous undo.
    const box = (await card(page, 'Third prompt').boundingBox())!;
    await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) await page.mouse.move(box.x + box.width - 30 - step * (box.width * 0.6 / 8), box.y + box.height / 2);
    await page.screenshot({ path: 'test-results/swipe-mid.png' });
    await page.mouse.up();
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(toast).toContainText('Archived Third prompt');

    // Archiving another item replaces the undo target.
    await card(page, 'First prompt').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Archived/ }).click();
    await expect(toast).toContainText('Archived First prompt');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(card(page, 'First prompt')).toBeVisible();

    // A short drag never counts as a click or a swipe.
    const small = (await card(page, 'First prompt').boundingBox())!;
    await page.mouse.move(small.x + 100, small.y + small.height / 2); await page.mouse.down();
    await page.mouse.move(small.x + 80, small.y + small.height / 2); await page.mouse.move(small.x + 70, small.y + small.height / 2);
    await page.mouse.up();
    await expect(page.locator('.item-card')).toHaveCount(1);

    // Archived items in the Archive view do not swipe; the menu there still offers other statuses.
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.item-card')).toHaveCount(2);
    await expect(page.locator('.swipe-row')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
