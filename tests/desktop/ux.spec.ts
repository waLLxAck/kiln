import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

async function launch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-ux-'));
  const app = await electron.launch({ ...(process.env.KILN_UX_EXE ? { executablePath: process.env.KILN_UX_EXE } : { args: ['.'] }), env: { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'profile') } });
  const page = await app.firstWindow();
  await page.locator('.item-list').waitFor();
  return { app, page };
}
async function create(page: Page, title: string, kind = 'prompt', content = '# Readable heading\n\n- First point\n- Second point\n\n```js\nconst answer = 42;\n```\n\n[Example](https://example.com)\n\n<script>window.unsafe = true</script>') {
  return page.evaluate(async ({ title, kind, content }) => (window as any).kiln.call('items.create', { title, kind, content, collection: 'UX examples', files: {} }), { title, kind, content });
}

test('formatted reading, primary actions, simple status and save without analysis', async () => {
  const { app, page } = await launch();
  try {
    await create(page, 'Reading example');
    await create(page, 'Resource example', 'link', 'https://example.com');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.locator('.item-card').filter({ hasText: 'Reading example' }).click();
    await expect(page.locator('.detail-actions > .primary')).toHaveText('Copy');
    await expect(page.locator('.markdown-content h1')).toHaveText('Readable heading');
    await expect(page.locator('.markdown-content li')).toHaveCount(2);
    await expect(page.locator('.markdown-content pre code')).toContainText('const answer = 42');
    expect(await page.evaluate(() => (window as any).unsafe)).toBeUndefined();
    await expect(page.locator('.item-status-details summary')).toHaveText('Draft');
    await page.getByRole('button', { name: 'Raw text', exact: true }).click();
    await expect(page.locator('.content-preview')).toContainText('# Readable heading');
    await page.getByRole('button', { name: 'Read formatted' }).click();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /^Approve/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('.item-card').filter({ hasText: 'Resource example' }).click();
    await expect(page.locator('.detail-actions > .primary')).toHaveText('Open link');
    await page.getByRole('button', { name: /^Capture/ }).click();
    await page.getByRole('textbox', { name: 'Idea' }).fill('A snippet saved without AI');
    await page.getByRole('button', { name: 'Save only', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'A snippet saved without AI', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).kiln.call('agent.jobs'))).toEqual([]);
    await page.screenshot({ path: 'artifacts/ux-0.15.0-reading.png' });
  } finally { await app.close(); }
});

test('library views retain search, selection and scroll across sections and reload', async () => {
  const { app, page } = await launch();
  try {
    for (let i = 0; i < 35; i++) await create(page, `Remember ${String(i).padStart(2, '0')}`, 'prompt', Array.from({ length: 45 }, (_, n) => `Paragraph ${n}. Keep this useful context.`).join('\n\n'));
    await create(page, 'Other link', 'link', 'https://example.com');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.locator('.sidebar .nav-item').filter({ hasText: 'UX examples' }).click();
    await page.getByRole('tab', { name: /^Prompts/ }).click();
    await page.getByRole('textbox', { name: 'Search library' }).fill('Remember');
    await expect(page.locator('.item-card')).toHaveCount(35);
    await page.locator('.item-card').filter({ hasText: 'Remember 20' }).click();
    await page.getByRole('button', { name: /^Status/ }).click();
    await page.getByRole('menuitem', { name: /^Captured/ }).click();
    await page.locator('.detail-scroll').evaluate(node => { node.scrollTop = 300; });
    await page.locator('.item-list').evaluate(node => { node.scrollTop = 400; });
    await expect.poll(() => page.locator('.item-list').evaluate(node => node.scrollTop)).toBeGreaterThan(300);
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await page.getByRole('button', { name: /^Library/ }).click();
    await expect(page.getByRole('textbox', { name: 'Search library' })).toHaveValue('Remember');
    await expect(page.getByRole('tab', { name: /^Prompts/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Remember 20', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Status/ })).toContainText('Captured');
    await expect.poll(() => page.locator('.detail-scroll').evaluate(node => node.scrollTop)).toBeGreaterThan(200);
    await expect.poll(() => page.locator('.item-list').evaluate(node => node.scrollTop)).toBeGreaterThan(300);
    await page.getByRole('tab', { name: /^Links/ }).click();
    await expect(page.getByRole('textbox', { name: 'Search library' })).toHaveValue('');
    await page.getByRole('tab', { name: /^Prompts/ }).click();
    await expect(page.getByRole('textbox', { name: 'Search library' })).toHaveValue('Remember');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Search library' })).toHaveValue('Remember');
    await expect(page.getByRole('heading', { name: 'Remember 20', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Status/ })).toContainText('Captured');
    await expect.poll(() => page.locator('.detail-scroll').evaluate(node => node.scrollTop)).toBeGreaterThan(200);
    await expect.poll(() => page.locator('.item-list').evaluate(node => node.scrollTop)).toBeGreaterThan(300);
  } finally { await app.close(); }
});

test('quick search previews content and opens the exact item through a filtered view', async () => {
  const { app, page } = await launch();
  try {
    const item = await create(page, 'Search target');
    await create(page, 'Another resource', 'link', 'https://example.com');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.getByRole('tab', { name: /^Links/ }).click();
    const windowPromise = app.waitForEvent('window');
    await page.getByRole('button', { name: /Quick search/ }).click();
    const palette = await windowPromise;
    await palette.getByRole('combobox', { name: 'Quick search' }).fill('Search target');
    await expect(palette.locator('.palette-preview h2')).toHaveText('Search target');
    await expect(palette.locator('.palette-preview .markdown-content h1')).toHaveText('Readable heading');
    await palette.screenshot({ path: 'artifacts/ux-0.15.0-search.png' });
    await palette.getByRole('button', { name: 'Open item', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Search target', exact: true })).toBeVisible();
    await expect(page.locator('.item-card.selected')).toContainText('Search target');
    expect(await page.evaluate(() => localStorage.getItem('kiln-selected'))).toBe(item.id);
  } finally { await app.close(); }
});

test('archive undo lasts eight seconds and pauses for hover and keyboard focus', async () => {
  const { app, page } = await launch();
  try {
    await create(page, 'Undo example');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await expect(page.locator('.item-card')).toBeVisible();
    await page.clock.install();
    await page.locator('.item-card').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Archived/ }).click();
    const toast = page.locator('.undo-toast');
    await expect(toast).toBeVisible();
    await page.clock.runFor(4000);
    await expect(toast).toBeVisible();
    await toast.hover();
    await page.clock.runFor(9000);
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Undo' }).focus();
    await page.mouse.move(0, 0);
    await page.clock.runFor(9000);
    await expect(toast).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.item-card')).toContainText('Undo example');
    await page.locator('.item-card').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Archived/ }).click();
    await expect(toast).toBeVisible();
    await page.mouse.move(0, 0);
    await page.clock.runFor(8100);
    await expect(toast).toHaveCount(0);
  } finally { await app.close(); }
});
