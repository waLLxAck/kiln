import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

async function launch(flag: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-better-search-'));
  const env: Record<string, string | undefined> = { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'profile') };
  if (flag) env.KILN_EXPERIMENTS = 'betterSearch'; else delete env.KILN_EXPERIMENTS;
  const app = await electron.launch({ args: ['.'], env: env as Record<string, string> });
  const page = await app.firstWindow();
  await page.locator('.item-list').waitFor();
  return { app, page, close: async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
async function create(page: Page, title: string, content: string, extra: object = {}) {
  return page.evaluate(async input => (window as any).kiln.call('items.create', { kind: 'prompt', collection: 'Search', files: {}, ...input }), { title, content, ...extra }) as Promise<{ id: string; revision: string }>;
}
const titles = (page: Page) => page.locator('.item-list .item-card .item-title').allTextContents();
const paletteVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('#palette') && w.isVisible()));
async function openPalette(app: ElectronApplication, page: Page, existing?: Page) {
  const next = existing ? null : app.waitForEvent('window');
  await page.getByRole('button', { name: /Quick search/ }).click();
  const palette = existing ?? await next!;
  await expect(palette.getByRole('combobox', { name: 'Quick search' })).toBeVisible();
  await expect.poll(() => paletteVisible(app)).toBe(true);
  return palette;
}

test('flag on: library search never flashes empty, ranks by relevance and follows renames', async () => {
  const { page, close } = await launch(true);
  try {
    // The title hit is the older item, so "Recently added" and relevance disagree about which comes first.
    await create(page, 'Deploy checklist', 'Steps before shipping.');
    const notes = await create(page, 'Weekly notes', 'Deploy on Friday. Deploy the deploy script.');
    for (const title of ['Alpha', 'Beta', 'Gamma']) await create(page, title, 'Unrelated text.');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await expect(page.locator('.item-list .item-card')).toHaveCount(5);
    await page.evaluate(() => {
      const w = window as unknown as { sawEmpty: boolean };
      w.sawEmpty = false;
      const look = () => { if (document.querySelector('.list-empty')) w.sawEmpty = true; };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true });
      const frame = () => { look(); requestAnimationFrame(frame); }; frame();
    });
    const search = page.getByRole('textbox', { name: 'Search library' });
    await search.pressSequentially('deploy', { delay: 40 });
    await expect(page.locator('.item-list .item-card')).toHaveCount(2);
    expect(await page.evaluate(() => (window as unknown as { sawEmpty: boolean }).sawEmpty)).toBe(false);
    const sort = page.getByRole('button', { name: /^Sort:/ });
    await expect(sort).toHaveText(/Relevance/);
    expect(await titles(page)).toEqual(['Deploy checklist', 'Weekly notes']);
    // Another order still works during the search, and clearing the search goes back to the view's own order.
    await sort.click(); await page.getByRole('menuitem', { name: 'Recently added' }).click();
    await expect(sort).toHaveText(/Recently added/);
    expect(await titles(page)).toEqual(['Weekly notes', 'Deploy checklist']);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(sort).toHaveText(/Recently added/);
    await expect(page.locator('.item-list .item-card')).toHaveCount(5);
    await search.fill('checklist');
    await expect(sort).toHaveText(/Relevance/);
    await expect(page.locator('.item-list .item-card')).toHaveCount(1);
    // A rename keeps the item count; results must follow it anyway.
    await page.evaluate(async id => {
      const detail = await (window as any).kiln.call('items.read', { id });
      await (window as any).kiln.call('items.update', { id, expect: detail.item.revision, summary: 'Rename', value: { ...detail.revision, title: 'Weekly checklist' } });
    }, notes.id);
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await expect(page.locator('.item-list .item-card')).toHaveCount(2);
    // A typo finds close matches and says so.
    await search.fill('chekclist');
    await expect(page.getByRole('status').filter({ hasText: 'No exact matches — showing close matches' })).toBeVisible();
    await expect(page.locator('.item-list .item-card')).toHaveCount(2);
  } finally { await close(); }
});

test('flag on: quick search copies on a fast Enter, confirms, hides on blur and runs commands', async () => {
  const { app, page, close } = await launch(true);
  try {
    await create(page, 'Code review checklist', 'Review the diff carefully.');
    await create(page, 'Weekly notes', 'Nothing about that.');
    for (let n = 0; n < 32; n++) await create(page, `Bulk entry ${n}`, 'bulk');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
    let palette = await openPalette(app, page);
    const input = palette.getByRole('combobox', { name: 'Quick search' });
    // Enter right after typing, before the debounced search has answered, still copies the top result.
    await input.pressSequentially('code rev'); await input.press('Enter');
    await expect(palette.getByRole('status')).toContainText('Copied');
    await expect(palette.getByRole('status')).toContainText('Code review checklist');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Review the diff carefully.');
    await expect.poll(() => paletteVisible(app)).toBe(false);

    palette = await openPalette(app, page, palette);
    await expect(input).toHaveValue('code rev');
    await input.fill('bulk');
    await expect(palette.getByText('Showing 30 of 32 — keep typing to narrow')).toBeVisible();
    await expect(palette.getByRole('option')).toHaveCount(30);
    await input.fill('reveiw');
    await expect(palette.locator('.palette-label')).toContainText('CLOSE MATCHES');
    await expect(palette.getByRole('option', { name: /Code review checklist/ })).toBeVisible();

    // Clicking away (the main window taking focus) hides quick search.
    await app.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#palette'))!; main.show(); main.focus(); });
    await expect.poll(() => paletteVisible(app)).toBe(false);

    palette = await openPalette(app, page, palette);
    await input.fill('>');
    await expect(palette.getByRole('option', { name: /Go to Settings/ })).toBeVisible();
    await expect(palette.getByRole('option', { name: /New capture/ })).toBeVisible();
    await expect(palette.getByRole('option', { name: /Check for updates/ })).toBeVisible();
    await input.fill('>sett');
    await expect(palette.getByRole('option')).toHaveCount(1);
    await input.press('Enter');
    await expect(page.getByRole('region', { name: 'Experimental features' })).toBeVisible();
    await expect.poll(() => paletteVisible(app)).toBe(false);
    // Plain queries show matching commands below the items.
    palette = await openPalette(app, page, palette);
    await input.fill('capture');
    await expect(palette.getByRole('option', { name: /New capture/ })).toBeVisible();
    await input.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
  } finally { await close(); }
});

test('flag off: no relevance sort and no quick search commands', async () => {
  const { app, page, close } = await launch(false);
  try {
    await create(page, 'Deploy checklist', 'Steps before shipping.');
    await create(page, 'Weekly notes', 'Deploy on Friday. Deploy the deploy script.');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.getByRole('textbox', { name: 'Search library' }).fill('deploy');
    await expect(page.locator('.item-list .item-card')).toHaveCount(2);
    const sort = page.getByRole('button', { name: /^Sort:/ });
    await expect(sort).toHaveText(/Recently added/);
    expect(await titles(page)).toEqual(['Weekly notes', 'Deploy checklist']);
    await sort.click();
    await expect(page.getByRole('menuitem', { name: 'Relevance' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    const palette = await openPalette(app, page);
    await palette.getByRole('combobox', { name: 'Quick search' }).fill('>');
    await expect(palette.getByText('No matching items. Try another search.')).toBeVisible();
    await expect(palette.getByRole('option', { name: /Go to Settings/ })).toHaveCount(0);
  } finally { await close(); }
});
