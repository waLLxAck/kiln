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
    for (const width of [1000, 1300, 1900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
      await expect(page.locator('.item-card')).toHaveCount(10);
      const head = page.locator('.lib-row.head');
      await expect(head.getByRole('columnheader', { name: 'Title' })).toBeVisible();
      await expect(head.getByRole('columnheader', { name: 'Status' })).toBeVisible();
      const layout = await page.locator('.item-list').evaluate(list => ({ overflow: list.scrollWidth - list.clientWidth, heights: [...list.querySelectorAll('.item-card')].map(row => row.getBoundingClientRect().height) }));
      expect(layout.overflow).toBeLessThanOrEqual(1);
      expect(layout.heights.every(height => height <= 44)).toBe(true);
    }
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
