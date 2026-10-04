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
    // Collection comes first; the Title cell holds only the title, and the description moved to the row's tooltip. A skill is
    // listed, so Invoked by shows too.
    const head = page.locator('.lib-row.head');
    await expect(head.getByRole('columnheader')).toHaveText(['Collection', 'Title', 'Status', 'Invoked by', 'Installed', 'Last test', 'Updated']);
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
    // Only prompts: Invoked by (skills only) gives way.
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
    // Any column but Title can be hidden from the header menu; it stays hidden after a reload and comes back from the same menu.
    await head.locator('[data-col=installed]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide column' }).click();
    await expect(headings).toHaveText(['Collection', 'Title', 'Status', 'Last test', 'Updated']);
    await page.reload();
    await expect(headings).toHaveText(['Collection', 'Title', 'Status', 'Last test', 'Updated']);
    await head.locator('[data-col=title]').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Hide column' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Show Installed' }).click();
    await expect(headings).toHaveText(['Collection', 'Title', 'Status', 'Installed', 'Last test', 'Updated']);
    // A chosen collection hides Collection and keeps the rest in order.
    await page.locator('.sidebar .nav-item').filter({ hasText: 'Columns' }).click();
    await expect(headings).toHaveText(['Title', 'Status', 'Installed', 'Last test', 'Updated']);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('library columns resize from their edges without sorting or moving, and the widths survive a reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-library-widths-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1500, 900); w.show(); w.focus(); });
    await page.evaluate(async () => {
      for (const title of ['Beta', 'Alpha']) await window.kiln.call('items.create', { kind: 'prompt', title, content: 'Widths fixture', collection: 'A collection with a long enough name/and a nested folder' });
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    const head = page.locator('.lib-row.head'), headings = head.getByRole('columnheader');
    const order = ['Collection', 'Title', 'Status', 'Installed', 'Last test', 'Updated'];
    await expect(headings).toHaveText(order);
    const width = async (key: string) => (await head.locator(`[data-col=${key}]`).boundingBox())!.width;
    const sorted = head.locator('[aria-sort="ascending"], [aria-sort="descending"]'), sortedBefore = await sorted.count();
    // Each column but Title has one handle, on its side away from Title (Title takes the space left over).
    const collectionEdge = page.getByRole('separator', { name: 'Resize Collection column' }), statusEdge = page.getByRole('separator', { name: 'Resize Status column' });
    await expect(head.getByRole('separator')).toHaveCount(5);
    await expect(page.getByRole('separator', { name: 'Resize Title column' })).toHaveCount(0);
    await expect(statusEdge).toHaveAttribute('aria-orientation', 'vertical');
    await expect(statusEdge).toHaveAttribute('aria-valuenow', '150');
    await expect(statusEdge).toHaveAttribute('aria-valuemin', '100');
    // Dragging the Collection edge right widens Collection by as much, in the header and every row; Title gives up the space.
    const collectionBefore = await width('collection'), titleBefore = await width('title');
    let edge = (await collectionEdge.boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2); await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 30, edge.y + edge.height / 2, { steps: 3 });
    await page.mouse.move(edge.x + edge.width / 2 + 60, edge.y + edge.height / 2, { steps: 3 });
    await expect(page.locator('.col-drop')).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(() => width('collection')).toBeCloseTo(collectionBefore + 60, 0);
    expect(await width('title')).toBeCloseTo(titleBefore - 60, 0);
    expect((await page.locator('.item-card').first().locator('.col-collection').boundingBox())!.width).toBeCloseTo(collectionBefore + 60, 0);
    // Resizing neither sorts nor moves a column.
    await expect(headings).toHaveText(order);
    await expect(sorted).toHaveCount(sortedBefore);
    // Status's edge is on its left, so dragging it left widens Status.
    edge = (await statusEdge.boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2); await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 - 40, edge.y + edge.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(statusEdge).toHaveAttribute('aria-valuenow', '190');
    await expect(headings).toHaveText(order);
    await expect(sorted).toHaveCount(sortedBefore);
    // A plain click on an edge does not sort either.
    await statusEdge.click();
    await expect(sorted).toHaveCount(sortedBefore);
    await page.reload();
    await expect(headings).toHaveText(order);
    expect(await width('collection')).toBeCloseTo(collectionBefore + 60, 0);
    expect(await width('status')).toBeCloseTo(190, 0);
    // Keyboard: the arrows move the edge 16px (Left widens Status, whose edge is on its left); Home and End go to the limits.
    await statusEdge.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(statusEdge).toHaveAttribute('aria-valuenow', '206');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await expect(statusEdge).toHaveAttribute('aria-valuenow', '174');
    await page.keyboard.press('Home');
    await expect(statusEdge).toHaveAttribute('aria-valuenow', '100');
    expect(await width('status')).toBeCloseTo(100, 0);
    await expect(headings).toHaveText(order);
    // Reset width from the header menu, for that column only.
    await head.locator('[data-col=status]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reset width' }).click();
    await expect(statusEdge).toHaveAttribute('aria-valuenow', '150');
    expect(await width('collection')).toBeCloseTo(collectionBefore + 60, 0);
    // Double-clicking an edge fits the column to its content: the long collection name is no longer cut off.
    const cut = () => page.locator('.item-card .col-collection').first().evaluate(cell => cell.scrollWidth > cell.clientWidth);
    expect(await cut()).toBe(true);
    await collectionEdge.dblclick();
    await expect.poll(cut).toBe(false);
    await expect(sorted).toHaveCount(sortedBefore);
    // Reset columns puts the widths back too, and leaves nothing stored.
    await head.locator('[data-col=title]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reset columns' }).click();
    await expect.poll(() => width('collection')).toBeCloseTo(200, 0);
    expect(await width('status')).toBeCloseTo(150, 0);
    expect(await page.evaluate(() => localStorage.getItem('kiln-library-columns'))).toBeNull();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
