import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('rows keep their height while held in a swipe in a long library', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-swipe-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await page.locator('.item-list').waitFor();
    await page.evaluate(async () => {
      for (const kind of ['prompt', 'skill', 'link', 'instruction', 'image', 'file', 'reference']) {
        for (let i = 0; i < 25; i++) await (window as any).kiln.call('items.create', {
          kind, title: `${kind} ${i}`, content: 'Test content', collection: 'Personal', tags: [], files: {}, source: '', licence: 'Unknown',
        });
      }
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    for (const tab of ['All', 'Prompts', 'Skills', 'Links', 'Instructions', 'Images', 'Files', 'References']) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
      const row = page.locator('.swipe-row').first();
      await row.scrollIntoViewIfNeeded();
      const before = (await row.boundingBox())!;
      const x = before.x + before.width / 2, y = before.y + before.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + 25, y, { steps: 3 });
      await expect(row).toHaveClass(/swiping/);
      const during = (await row.boundingBox())!;
      expect(during.height, `${tab}: row height during held swipe`).toBeGreaterThanOrEqual(before.height - 1);
      await expect(row.locator('.item-title')).toBeVisible();
      await page.mouse.up();
      await expect(row).not.toHaveClass(/swiping/);
    }
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
