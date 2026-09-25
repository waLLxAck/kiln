import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('one import area accumulates selection, drop and paste into one item', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-import-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Import file', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Capture Ctrl N', exact: true }).click();
    const picker = page.getByLabel('Select files');
    await picker.setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
      { name: 'paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') },
      { name: 'audio.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('audio') },
      { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') },
    ]);
    await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('second') });
    await page.locator('.quick-capture').evaluate(element => {
      const drop = new DataTransfer(); drop.items.add(new File(['image'], 'photo.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: drop }));
      const paste = new DataTransfer(); paste.setData('text/plain', 'https://example.com/reference');
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: paste }));
    });
    await expect(page.locator('.capture-file')).toHaveCount(6);
    await expect(page.getByRole('button', { name: 'Manual entry' })).toHaveCount(0);
    const thumb = page.getByRole('button', { name: 'Preview photo.png' });
    await expect(thumb).toHaveCount(1); await expect(thumb.locator('img')).toHaveAttribute('src', /^blob:/);
    await thumb.click();
    const lightbox = page.getByRole('dialog', { name: 'Preview of photo.png' });
    await expect(lightbox).toBeVisible(); await expect(lightbox.locator('img')).toHaveAttribute('alt', 'photo.png');
    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0); await expect(page.getByRole('dialog', { name: 'Add to library' })).toBeVisible();
    await expect(page.getByLabel('Idea', { exact: true })).toHaveValue('https://example.com/reference');
    await page.getByRole('button', { name: 'Save only', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const snapshot = await page.evaluate(() => (window as any).kiln.call('snapshot'));
    expect(snapshot.items).toHaveLength(1);
    const detail = await page.evaluate(id => (window as any).kiln.call('items.read', { id }), snapshot.items[0].id);
    expect(detail.item.kind).toBe('file');
    expect(Object.keys(detail.revision.files)).toHaveLength(6);
    expect(Buffer.from(detail.revision.files['notes.txt'], 'base64').toString()).toBe('first');
    expect(Buffer.from(detail.revision.files['notes (2).txt'], 'base64').toString()).toBe('second');
    await page.screenshot({ path: 'test-results/unified-import.png' });
  } finally { await app.close(); }
});
