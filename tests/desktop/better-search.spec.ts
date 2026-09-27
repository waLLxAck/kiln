import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

async function launch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-better-search-'));
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'profile') } });
  const page = await app.firstWindow();
  await page.locator('.item-list').waitFor();
  return { app, page, close: async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
async function create(page: Page, title: string, content: string, extra: object = {}) {
  return page.evaluate(async input => (window as any).kiln.call('items.create', { kind: 'prompt', collection: 'Search', files: {}, ...input }), { title, content, ...extra }) as Promise<{ id: string; revision: string }>;
}
const rows = (page: Page) => page.locator('.item-list .item-card');
const titles = (page: Page) => page.locator('.item-list .item-card .item-title').allTextContents();
const paletteVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('#palette') && w.isVisible()));
async function openPalette(app: ElectronApplication, page: Page, existing?: Page) {
  const next = existing ? null : app.waitForEvent('window');
  await page.getByRole('button', { name: /Search or run a command/ }).click();
  const palette = existing ?? await next!;
  await expect(palette.getByRole('combobox', { name: 'Quick search' })).toBeVisible();
  await expect.poll(() => paletteVisible(app)).toBe(true);
  return palette;
}

test('library search never flashes empty, ranks by relevance, searches descriptions, follows renames and tolerates typos', async () => {
  const { page, close } = await launch();
  try {
    // The title hit is the older item, so "Recently added" and relevance disagree about which comes first.
    await create(page, 'Deploy checklist', 'Steps before shipping.');
    const notes = await create(page, 'Weekly notes', 'Deploy on Friday. Deploy the deploy script.');
    await create(page, 'Release plan', 'Nothing here mentions it.', { description: 'How we deploy on Fridays' });
    for (const title of ['Alpha', 'Beta']) await create(page, title, 'Unrelated text.');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await expect(rows(page)).toHaveCount(5);
    await page.evaluate(() => {
      const w = window as unknown as { sawEmpty: boolean };
      w.sawEmpty = false;
      const look = () => { if (document.querySelector('.list-empty')) w.sawEmpty = true; };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true });
      const frame = () => { look(); requestAnimationFrame(frame); }; frame();
    });
    const search = page.getByRole('combobox', { name: 'Search library' });
    await search.pressSequentially('deploy', { delay: 40 });
    await expect(rows(page)).toHaveCount(3);
    expect(await page.evaluate(() => (window as unknown as { sawEmpty: boolean }).sawEmpty)).toBe(false);
    const sort = page.getByRole('button', { name: /^Sort:/ });
    await expect(sort).toHaveText(/Relevance/);
    // Title first, then the description, then body text.
    expect(await titles(page)).toEqual(['Deploy checklist', 'Release plan', 'Weekly notes']);
    // Another order works during the search; clearing the search goes back to the view's own order.
    await search.press('Escape');
    await sort.click(); await page.getByRole('menuitem', { name: 'Recently added' }).click();
    await expect(sort).toHaveText(/Recently added/);
    expect(await titles(page)).toEqual(['Release plan', 'Weekly notes', 'Deploy checklist']);
    await sort.click(); await page.getByRole('menuitem', { name: 'Title A–Z' }).click();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(sort).toHaveText(/Recently added/);
    await expect(rows(page)).toHaveCount(5);
    await sort.click();
    await expect(page.getByRole('menuitem', { name: 'Relevance' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await search.fill('checklist');
    await expect(sort).toHaveText(/Relevance/);
    await expect(rows(page)).toHaveCount(1);
    // A rename keeps the item count; results must follow it anyway.
    await page.evaluate(async id => {
      const detail = await (window as any).kiln.call('items.read', { id });
      await (window as any).kiln.call('items.update', { id, expect: detail.item.revision, summary: 'Rename', value: { ...detail.revision, title: 'Weekly checklist' } });
    }, notes.id);
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await expect(rows(page)).toHaveCount(2);
    // A typo finds close matches and says so under the query bar.
    await search.fill('chekclist');
    await expect(page.getByRole('status').filter({ hasText: 'No exact matches — showing close matches' })).toBeVisible();
    await expect(rows(page)).toHaveCount(2);
    await search.fill('checklist');
    await expect(page.getByRole('status').filter({ hasText: 'close matches' })).toHaveCount(0);
  } finally { await close(); }
});

test('quick search copies on a fast Enter, confirms, hides on blur, remembers the search and lists actions', async () => {
  const { app, page, close } = await launch();
  try {
    await create(page, 'Code review checklist', 'Review the diff carefully.');
    await create(page, 'Weekly notes', 'Nothing about that.');
    for (let n = 0; n < 32; n++) await create(page, `Bulk entry ${n}`, 'bulk');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
    let palette = await openPalette(app, page);
    const input = palette.getByRole('combobox', { name: 'Quick search' });
    // Enter right after typing, before the debounced search has answered, still copies the top result.
    await input.fill(''); await input.pressSequentially('code rev'); await input.press('Enter');
    await expect(palette.getByRole('status').filter({ hasText: 'Copied' })).toContainText('Code review checklist');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Review the diff carefully.');
    await expect.poll(() => paletteVisible(app)).toBe(false);

    // The last search is still there next time.
    palette = await openPalette(app, page, palette);
    await expect(input).toHaveValue('code rev');
    await input.fill('bulk');
    await expect(palette.getByText('Showing the first 30 of 32. Keep typing to narrow.')).toBeVisible();
    await expect(palette.getByRole('group', { name: 'Items' }).getByRole('option')).toHaveCount(30);
    await input.fill('reveiw');
    await expect(palette.getByRole('status').filter({ hasText: 'No exact matches — showing close matches' })).toBeVisible();
    await expect(palette.getByRole('option', { name: /Code review checklist/ })).toBeVisible();

    // Clicking away (the main window taking focus) hides quick search.
    await app.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#palette'))!; main.show(); main.focus(); });
    await expect.poll(() => paletteVisible(app)).toBe(false);

    // ">" lists only the actions, main's quick-search commands included.
    palette = await openPalette(app, page, palette);
    await input.fill('>');
    await expect(palette.getByRole('group', { name: 'Items' })).toHaveCount(0);
    const actions = palette.getByRole('group', { name: 'Actions' });
    for (const name of ['Capture…', 'Go to Library', 'Go to Experiments', 'Go to Config files', 'Go to Activity', 'Go to Settings', 'Check for updates']) await expect(actions.getByRole('option', { name })).toBeVisible();
    await input.fill('>updates');
    await expect(palette.getByRole('option')).toHaveCount(1);
    await input.press('Enter');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('kiln-section'))).toBe('settings');
    await expect(page.getByText('Checked for updates')).toBeVisible();
    await expect.poll(() => paletteVisible(app)).toBe(false);
    // A plain word shows matching actions under the items.
    palette = await openPalette(app, page, palette);
    await input.fill('capture');
    await expect(actions.getByRole('option', { name: 'Capture…' })).toBeVisible();
    await input.fill('new capture');
    await expect(actions.getByRole('option', { name: 'Capture…' })).toHaveAttribute('aria-selected', 'true');
  } finally { await close(); }
});
