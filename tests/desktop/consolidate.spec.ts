import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

// Consolidating duplicates: the same "research" skill in the library twice (captured here, and imported from ~/.agents/skills with a
// small difference and an extra file). The copies notice, is:duplicate, the side-by-side dialog, the result, undo, and Not duplicates.
const body = 'Investigate the question against primary sources: official docs, source code, specs and first-party APIs. Write the findings to one Markdown file, citing each claim\'s source.';
const skill = (extra = '') => `---\nname: research\ndescription: Investigate a question against high-trust primary sources.\n---\n\n${body}${extra}\n`;

test('two copies of a skill are flagged, compared side by side and consolidated into one, with undo and Not duplicates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-consolidate-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    const ids = await page.evaluate(async ({ first, second, source }) => {
      const call = window.kiln.call;
      const kept = await call<any>('items.create', { title: 'research', kind: 'skill', content: first, collection: 'Development', tags: ['research'] });
      const copy = await call<any>('items.create', { title: 'research', kind: 'skill', content: second, collection: '', tags: ['imported'], source, files: { 'agents/openai.yaml': btoa('model: x\n') } });
      await call('items.meta', { id: copy.id, expect: copy.revision, favourite: true });
      return { kept: kept.id as string, copy: copy.id as string };
    }, { first: skill(), second: skill(' Say where you saved it.'), source: `local:${path.join(home, '.agents', 'skills', 'research')}` });
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();

    // The library marks both rows, and is:duplicate lists them.
    await expect(page.locator('.lib-dup')).toHaveCount(2);
    const search = page.getByLabel('Search library');
    await search.fill('is:dup'); await search.press('Enter'); await search.press('Escape');
    await expect(page.locator('.item-card')).toHaveCount(2);

    // The copy's page names the other copy and offers Consolidate… and Not duplicates.
    await page.locator(`.item-card[data-id="${ids.copy}"]`).click();
    const notice = page.getByRole('note', { name: 'Duplicates' });
    await expect(notice).toContainText('1 other copy of this skill');
    await expect(notice).toContainText('similar text');
    await notice.getByRole('button', { name: 'Consolidate…' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Consolidate 2 copies of “research”' })).toBeVisible();
    await expect(dialog.getByRole('row', { name: /Collection/ })).toContainText('Development');
    await expect(dialog.getByRole('row', { name: /Collection/ })).toContainText('Unfiled');
    // Keep the captured copy but take the imported copy's text; the diff and the summary follow.
    await dialog.locator('input[name="cons-keep"]').first().check();
    await dialog.locator('input[name="cons-text"]').nth(1).check();
    await expect(dialog.locator('.cons-files')).toContainText('agents/openai.yaml');
    await expect(dialog.getByRole('status')).toContainText('Saves a new draft revision with its text');
    await expect(dialog.getByRole('button', { name: 'imported' })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: 'test-results/consolidate-dialog.png' });
    await dialog.getByRole('button', { name: 'Consolidate', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // One item left: the kept one, on the chosen text, with both copies' tags and the favourite; the other is in Trash as merged.
    await expect(page.locator('.item-head h1')).toHaveText('research');
    const kept = await page.evaluate(id => window.kiln.call<any>('items.read', { id }), ids.kept);
    expect(kept.revision.content).toBe(skill(' Say where you saved it.'));
    expect(Object.keys(kept.revision.files)).toEqual(['agents/openai.yaml']);
    expect(kept.item.tags.sort()).toEqual(['imported', 'research']);
    expect(kept.item.favourite).toBe(true);
    expect(kept.revision.summary).toMatch(/^Consolidated from/);
    const merged = await page.evaluate(id => window.kiln.call<any>('items.read', { id }), ids.copy);
    expect(merged.item.mergedInto).toBe(ids.kept);
    expect(merged.item.deletedAt).toBeTruthy();

    // Undo from the toast brings the copy back.
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.toast')).toContainText('Undone: the 2 copies are separate again');
    expect((await page.evaluate(id => window.kiln.call<any>('items.read', { id }), ids.copy)).item.deletedAt).toBeNull();

    // Not duplicates stops the flag, on this item and in the list.
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Not duplicates' }).click();
    await expect(notice).toHaveCount(0);
    await page.getByRole('button', { name: /^Library/ }).first().click();
    await expect(page.locator('.lib-dup')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
