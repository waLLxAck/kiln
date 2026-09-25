import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('library tabs stay compact and visible across narrow and expanded panel widths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-library-layout-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1900, 1000));
    await page.evaluate(async () => {
      for (const kind of ['prompt', 'insight', 'technique', 'tool', 'resource', 'link', 'reference', 'instruction', 'file']) {
        await window.kiln.call('items.create', { kind, title: `Layout ${kind}`, content: 'Layout fixture' });
      }
    });
    for (const width of [380, 620, 780, 1100]) {
      await page.evaluate(width => localStorage.setItem('kiln-list-width', String(width)), width);
      await page.reload();
      const tabs = page.getByRole('tablist', { name: 'Library views' });
      await expect(tabs.getByRole('tab')).toHaveCount(10);
      const layout = await tabs.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return { overflow: element.scrollWidth - element.clientWidth, buttons: [...element.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { visible: rect.left >= bounds.left && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1, height: rect.height };
        }) };
      });
      expect(layout.overflow).toBeLessThanOrEqual(1);
      expect(layout.buttons.every(button => button.visible && button.height <= 32)).toBe(true);
    }
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
