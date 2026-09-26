import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../../packages/domain/workbench';
import { desktopEnv, readyLibrary } from './fixture';

test('a source has its own tab and page: no copy or test, its recorded analysis, what was made from it, and links both ways', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-sources-'));
  const library = readyLibrary(root);
  const wb = new Workbench(library, path.join(root, 'private'));
  try {
    const source = wb.create({ title: 'Design chat', kind: 'source', content: 'We compared three homepage designs.', description: 'A chat comparing homepage designs.', collection: 'Design' });
    const technique = wb.createFrom({ id: source.id, revision: source.revision, author: 'Codex', item: { title: 'Compare designs side by side', kind: 'technique', content: '1. Compare.', collection: 'Design' } });
    wb.createFrom({ id: source.id, revision: source.revision, author: 'Codex', item: { title: 'Ground the copy', kind: 'prompt', content: 'Ground every claim in this repository.', collection: 'Writing' } });
    wb.create({ title: 'Unrelated prompt', kind: 'prompt', content: 'Other', collection: 'Writing' });
    wb.recordAnalysis({ schemaVersion: 1, id: randomUUID(), itemId: source.id, revision: source.revision, provider: 'codex', model: 'gpt-test', effort: 'medium', usage: { input: 42000, cached: 0, output: 1704, reasoning: 0 }, startedAt: '2026-09-24T10:35:00.000Z', finishedAt: '2026-09-24T10:36:05.000Z', summary: 'This exchange explores homepage designs.', takeaway: 'Ground claims in the code.', skipped: 'Live designs were not inspected.', counts: { prompt: 1, technique: 1 }, created: [technique.id], collection: 'Design' });
  } finally { wb.close(); }
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const tab = page.getByRole('tab', { name: /^Sources/ });
    await expect(tab.locator('small')).toHaveText('1', { timeout: 15_000 });
    await tab.click();
    const row = page.locator('.item-card', { hasText: 'Design chat' });
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(row.locator('.lib-made')).toHaveText('2 made');

    // The source page: material and analysis, no copy, test or approval.
    await row.click();
    const detail = page.getByRole('article', { name: 'Selected item' });
    await expect(detail.getByRole('heading', { name: 'Design chat' })).toBeVisible();
    await expect(detail.getByRole('button', { name: '2 made from it' })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Analyze again' })).toBeVisible();
    for (const name of ['Copy', 'Test']) await expect(detail.getByRole('button', { name, exact: true })).toHaveCount(0);
    await detail.getByRole('button', { name: 'overview', exact: true }).click();
    const record = detail.getByRole('region', { name: 'Recorded analysis' });
    await expect(record).toContainText('This exchange explores homepage designs.');
    await expect(record).toContainText('42k in · 1,704 out');
    await expect(detail.getByRole('heading', { name: 'Original material' })).toBeVisible();
    await page.screenshot({ path: 'test-results/source-overview.png' });

    // What was made from it, wherever it is filed.
    await detail.getByRole('button', { name: /^made 2/ }).click();
    await expect(detail.getByRole('heading', { name: '2 items made from this source' })).toBeVisible();
    await expect(detail.locator('.made-row', { hasText: 'Ground the copy' })).toContainText('Writing');
    await page.screenshot({ path: 'test-results/source-made.png' });

    // No copy on its menu either.
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /^Copy/ })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: /^Show what was made from it/ }).click();

    // The library, filtered to the source across collections.
    await expect(page.getByRole('group', { name: 'Filters' })).toContainText('Source: Design chat');
    await expect(page.locator('.item-card')).toHaveCount(2);
    await expect(page.locator('.item-card', { hasText: 'Unrelated prompt' })).toHaveCount(0);

    // An entry links back to its source.
    await page.locator('.item-card', { hasText: 'Ground the copy' }).click();
    await detail.getByRole('button', { name: 'From “Design chat”' }).click();
    await expect(detail.getByRole('heading', { name: 'Design chat' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
