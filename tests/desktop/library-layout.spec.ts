import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('the library table keeps one line per item, Title and Status visible, across window widths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-library-layout-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      for (const kind of ['prompt', 'insight', 'technique', 'tool', 'resource', 'link', 'reference', 'instruction', 'file', 'skill']) {
        await window.kiln.call('items.create', { kind, title: `Layout ${kind} with a title long enough to need trimming in a narrow window`, content: 'Layout fixture', description: 'A description that runs on past the edge of the title column.' });
      }
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    // Collection comes first; the Title cell holds only the title, and the description moved to the row's tooltip.
    const head = page.locator('.lib-row.head');
    await expect(head.getByRole('columnheader')).toHaveText(['Collection', 'Title', 'Status', 'Installed', 'Last test', 'Updated']);
    await expect(page.getByText('A description that runs on past the edge of the title column.')).toHaveCount(0);
    await expect(page.locator('.item-card').first()).toHaveAttribute('title', 'A description that runs on past the edge of the title column.');
    for (const width of [1000, 1300, 1900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
      await expect(page.locator('.item-card')).toHaveCount(10);
      await expect(head.getByRole('columnheader', { name: 'Title' })).toBeVisible();
      await expect(head.getByRole('columnheader', { name: 'Status' })).toBeVisible();
      const layout = await page.locator('.item-list').evaluate(list => ({ overflow: list.scrollWidth - list.clientWidth, heights: [...list.querySelectorAll('.item-card')].map(row => row.getBoundingClientRect().height) }));
      expect(layout.overflow).toBeLessThanOrEqual(1);
      expect(layout.heights.every(height => height <= 44)).toBe(true);
    }
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('library columns move by dragging a heading or from the header menu, and the order survives a reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-library-columns-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      for (const title of ['Beta', 'Alpha']) await window.kiln.call('items.create', { kind: 'prompt', title, content: 'Columns fixture', collection: 'Columns' });
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    const head = page.locator('.lib-row.head'), headings = head.getByRole('columnheader');
    await expect(headings).toHaveText(['Collection', 'Title', 'Status', 'Installed', 'Last test', 'Updated']);
    // Drag Title in front of Collection. The press that ends a drag must not also sort by Title.
    const sortedBefore = await head.locator('[aria-sort="ascending"], [aria-sort="descending"]').count();
    const title = (await head.locator('[data-col=title]').boundingBox())!, collection = (await head.locator('[data-col=collection]').boundingBox())!;
    await page.mouse.move(title.x + 12, title.y + title.height / 2); await page.mouse.down();
    await page.mouse.move(title.x - 20, title.y + title.height / 2, { steps: 4 });
    await page.mouse.move(collection.x + 4, collection.y + collection.height / 2, { steps: 4 });
    await expect(page.locator('.col-drop')).toBeVisible();
    await page.mouse.up();
    await expect(page.locator('.col-drop')).toHaveCount(0);
    await expect(headings).toHaveText(['Title', 'Collection', 'Status', 'Installed', 'Last test', 'Updated']);
    await expect(head.locator('[aria-sort="ascending"], [aria-sort="descending"]')).toHaveCount(sortedBefore);
    // Rows follow the header.
    await expect(page.locator('.item-card').first().locator('[role=cell]').first()).toContainText(/Alpha|Beta/);
    await page.reload();
    await expect(headings).toHaveText(['Title', 'Collection', 'Status', 'Installed', 'Last test', 'Updated']);
    // The header menu: Move left / Move right for the column under it (also from the keyboard), and Reset columns.
    await head.locator('[data-col=status]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move left' }).click();
    await expect(headings).toHaveText(['Title', 'Status', 'Collection', 'Installed', 'Last test', 'Updated']);
    await expect(head.locator('[data-col=status]')).toBeFocused();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Move right' }).click();
    await expect(headings).toHaveText(['Title', 'Collection', 'Status', 'Installed', 'Last test', 'Updated']);
    await head.locator('[data-col=title]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reset columns' }).click();
    await expect(headings).toHaveText(['Collection', 'Title', 'Status', 'Installed', 'Last test', 'Updated']);
    // A plain click still sorts.
    await head.locator('[data-col=title]').click();
    await expect(head.locator('[data-col=title]')).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('.item-card .item-title')).toHaveText(['Alpha', 'Beta']);
    // A chosen collection hides Collection and keeps the rest in order.
    await page.locator('.sidebar .nav-item').filter({ hasText: 'Columns' }).click();
    await expect(headings).toHaveText(['Title', 'Status', 'Installed', 'Last test', 'Updated']);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
