import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../../packages/domain/workbench';
import { desktopEnv, readyLibrary } from './fixture';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-library-navigation-')), library = readyLibrary(root);
  const wb = new Workbench(library, path.join(root, 'private'));
  try {
    const create = (title: string, collection: string, kind: 'prompt' | 'source' | 'skill' = 'prompt') => wb.create({ title, collection, kind, content: kind === 'skill' ? '---\nname: release-checklist\ndescription: Verify a release before publishing it.\n---\nCheck the release artifacts.' : `Working notes for ${title}.` });
    const research = create('Research outline', 'Research'), release = create('Release checklist', 'Tooling', 'skill'), review = create('Code review', 'Tooling'), reference = create('API reference', 'Research', 'source');
    wb.setMeta({ id: review.id, expect: review.revision, favourite: true });
    for (const [item, count, days] of [[research, 3, 10], [release, 1, 0], [review, 5, 1]] as const) {
      const at = new Date(); at.setHours(10, 0, 0, 0); at.setDate(at.getDate() - days);
      for (let n = 0; n < count; n++) wb.observe({ schemaVersion: 1, eventId: `${item.id}-${n}`, itemId: item.id, revision: item.revision, kind: 'copied', source: 'kiln', confidence: 'observed', occurredAt: at.toISOString() });
    }
    wb.approve({ id: release.id, revision: release.revision, reviewer: 'Test', scope: 'Fixture', note: 'Reviewed', waivedChecks: 'Fixture' });
    if (wb.snapshot().usage[reference.id]) throw new Error('Source must be unused');
  } finally { wb.close(); }
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) }), page = await app.firstWindow();
  await expect(page.locator('.item-list .item-card')).toHaveCount(4);
  return { app, page, close: async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } };
}
const titles = (page: Page) => page.locator('.item-list .item-card .item-title');
async function groupBy(page: Page, name: string) {
  await page.getByRole('button', { name: /^Group by:/ }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

test('usage shortcuts show actual order and context; saved views restore sorting and grouping', async () => {
  const f = await fixture();
  try {
    const quick = f.page.getByRole('group', { name: 'Quick sort' });
    await quick.getByRole('button', { name: 'Most used', exact: true }).click();
    await expect(titles(f.page)).toHaveText(['Code review', 'Research outline', 'Release checklist', 'API reference']);
    await expect(f.page.locator('.item-card .lib-usage')).toHaveText(['5 uses', '3 uses', '1 use', '0 uses']);
    await f.page.screenshot({ path: 'artifacts/library-most-used.png', animations: 'disabled' });
    await quick.getByRole('button', { name: 'Last used', exact: true }).click();
    await expect(titles(f.page)).toHaveText(['Release checklist', 'Code review', 'Research outline', 'API reference']);
    await expect(f.page.locator('.item-card .lib-usage').last()).toHaveText('Never used');
    await groupBy(f.page, 'Last used');
    await expect(f.page.locator('.lib-group .ellipsis').first()).toHaveText('Today');
    await expect(f.page.locator('.lib-group')).toContainText(['Today', 'Yesterday', 'Last 30 days', 'Never used']);
    await f.page.screenshot({ path: 'artifacts/library-last-used-groups.png', animations: 'disabled' });
    await f.page.getByRole('button', { name: 'Collapse all', exact: true }).click();
    await expect(titles(f.page)).toHaveCount(0);
    await f.page.getByRole('button', { name: 'Expand all', exact: true }).click();
    await expect(titles(f.page)).toHaveCount(4);
    await f.page.getByRole('button', { name: 'Save this view', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Name this view' }).fill('Recently used work');
    await f.page.getByRole('button', { name: 'Save view', exact: true }).click();
    await groupBy(f.page, 'No grouping');
    await quick.getByRole('button', { name: 'Title A–Z', exact: true }).click();
    await f.page.getByRole('button', { name: 'Recently used work', exact: true }).click();
    await expect(quick.getByRole('button', { name: 'Last used', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(f.page.getByRole('button', { name: /^Group by:/ })).toContainText('Last used');
    const search = f.page.getByRole('combobox', { name: 'Search library' }), sortPill = f.page.getByRole('button', { name: /^Sort:/ });
    await search.fill('review');
    await expect(sortPill).toContainText('Relevance');
    await sortPill.click();
    await f.page.getByRole('menuitem', { name: /^Title A–Z/ }).click();
    await expect(sortPill).toContainText('Title A–Z');
    await f.page.getByRole('button', { name: 'Save this view', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Name this view' }).fill('Reviews by title');
    await f.page.getByRole('button', { name: 'Save view', exact: true }).click();
    await search.fill(''); await search.press('Escape');
    await f.page.getByRole('button', { name: 'Recently used work', exact: true }).click();
    await f.page.getByRole('button', { name: 'Reviews by title', exact: true }).click();
    await expect(search).toHaveValue('review');
    await expect(sortPill).toContainText('Title A–Z');
    await search.fill(''); await search.press('Escape');
    await expect(quick.getByRole('button', { name: 'Last used', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(titles(f.page)).toHaveText(['Release checklist', 'Code review', 'Research outline', 'API reference']);
    await f.page.getByRole('button', { name: 'Recently used work', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(quick.getByRole('button', { name: 'Last used', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await f.page.reload();
    await expect(quick.getByRole('button', { name: 'Last used', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(f.page.getByRole('button', { name: 'Recently used work', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // Collection views have their own grouping, and explicit usage sorts do not pin unused sources above used items.
    await f.page.locator('.sidebar .nav-item').filter({ hasText: /^Research/ }).click();
    await expect(f.page.getByRole('button', { name: /^Group by:/ })).toContainText('No grouping');
    await quick.getByRole('button', { name: 'Most used', exact: true }).click();
    await expect(titles(f.page)).toHaveText(['Research outline', 'API reference']);
    await f.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Library', exact: true }).click();
    await expect(f.page.getByRole('button', { name: /^Group by:/ })).toContainText('Last used');
  } finally { await f.close(); }
});

test('clickable filters preserve search text and keyboard selection still works', async () => {
  const f = await fixture();
  try {
    const search = f.page.getByRole('combobox', { name: 'Search library' });
    await search.fill('review'); await search.press('Escape');
    await expect(titles(f.page)).toHaveText(['Code review']);
    await f.page.getByRole('button', { name: /^Filters/ }).click();
    await f.page.getByRole('button', { name: 'Type', exact: true }).click();
    await expect(f.page.getByRole('option', { name: /kind: prompt/ }).locator('.query-count')).toHaveText('1');
    await f.page.getByRole('option', { name: /kind: prompt/ }).click();
    await expect(search).toHaveValue('review');
    await expect(f.page.locator('.q-token')).toContainText('prompt');
    await expect(titles(f.page)).toHaveText(['Code review']);
    await f.page.getByRole('button', { name: 'Clear', exact: true }).click();
    await search.fill('status:approved'); await search.press('Enter'); await search.press('Escape');
    await expect(titles(f.page)).toHaveText(['Release checklist']);
    await expect(search).toHaveValue('');
  } finally { await f.close(); }
});

test('empty-query filter browsing supports ArrowDown and Tab without changing normal search navigation', async () => {
  const f = await fixture();
  try {
    const search = f.page.getByRole('combobox', { name: 'Search library' });
    await search.focus();
    await search.press('ArrowDown');
    await expect(f.page.getByRole('listbox', { name: 'Filter suggestions' })).toHaveCount(0);
    await expect(f.page.locator('.item-card.selected')).toBeFocused();
    await f.page.getByRole('button', { name: /^Filters/ }).click();
    await f.page.getByRole('button', { name: 'Type', exact: true }).click();
    await expect(search).toHaveValue('');
    await search.press('ArrowDown');
    await expect(f.page.getByRole('option', { name: /kind: prompt/ })).toHaveAttribute('aria-selected', 'true');
    await search.press('Tab');
    await expect(f.page.locator('.q-token')).toContainText('prompt');
    await expect(search).toHaveValue('');
    await expect(titles(f.page)).toHaveCount(2);
    await expect(f.page.getByRole('listbox', { name: 'Filter suggestions' })).toHaveCount(0);
  } finally { await f.close(); }
});

test('existing grouping and saved filters survive the view-memory upgrade', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const memory = JSON.parse(localStorage.getItem('kiln-view-memory')!);
      for (const view of Object.values(memory.views) as Record<string, unknown>[]) delete view.group;
      memory.views['["library","broken",""]'] = 'invalid old entry';
      localStorage.setItem('kiln-view-memory', JSON.stringify(memory));
      localStorage.setItem('kiln-library-group', JSON.stringify('kind'));
      localStorage.setItem('kiln-saved-views', JSON.stringify([{ id: 'legacy', name: 'Approved work', tokens: [{ facet: 'status', value: 'approved' }], query: '' }]));
    });
    await f.page.reload();
    await expect(f.page.getByRole('button', { name: /^Group by:/ })).toContainText('Type');
    await f.page.getByRole('button', { name: 'Approved work', exact: true }).click();
    await expect(titles(f.page)).toHaveText(['Release checklist']);
    await expect(f.page.getByRole('button', { name: /^Group by:/ })).toContainText('Type');
    // Legacy views still select by filters, but cannot hide saving a new sort/group configuration.
    const quick = f.page.getByRole('group', { name: 'Quick sort' });
    const legacy = f.page.getByRole('button', { name: 'Approved work', exact: true });
    await quick.getByRole('button', { name: 'Most used', exact: true }).click();
    await groupBy(f.page, 'Last used');
    await expect(legacy).toHaveAttribute('aria-pressed', 'true');
    await f.page.getByRole('button', { name: 'Save this view', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Name this view' }).fill('Approved by usage');
    await f.page.getByRole('button', { name: 'Save view', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Approved by usage', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(legacy).toHaveAttribute('aria-pressed', 'false');
    await expect(f.page.getByRole('button', { name: 'Save this view', exact: true })).toHaveCount(0);
    await quick.getByRole('button', { name: 'Title A–Z', exact: true }).click();
    await groupBy(f.page, 'No grouping');
    await legacy.click();
    await expect(quick.getByRole('button', { name: 'Title A–Z', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(f.page.getByRole('button', { name: /^Group by:/ })).toContainText('No grouping');
    await f.page.reload();
    await f.page.getByRole('button', { name: 'Approved by usage', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Approved by usage', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(legacy).toHaveAttribute('aria-pressed', 'false');
    await expect(quick.getByRole('button', { name: 'Most used', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(f.page.getByRole('button', { name: /^Group by:/ })).toContainText('Last used');
    await expect(titles(f.page)).toHaveText(['Release checklist']);
    await expect(f.page.getByRole('button', { name: 'Save this view', exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test('recently added and every named grouping preserve the complete library', async () => {
  const f = await fixture();
  try {
    const original = await titles(f.page).allTextContents();
    const quick = f.page.getByRole('group', { name: 'Quick sort' });
    await quick.getByRole('button', { name: 'Title A–Z', exact: true }).click();
    await expect(titles(f.page)).toHaveText(['API reference', 'Code review', 'Release checklist', 'Research outline']);
    await quick.getByRole('button', { name: 'Recently added', exact: true }).click();
    await expect(titles(f.page)).toHaveText(original);
    for (const [name, labels] of [
      ['Collection', ['Research', 'Tooling']],
      ['Type', ['Sources', 'Prompts', 'Skills']],
      ['Status', ['Approved', 'Drafts']],
    ] as const) {
      await groupBy(f.page, name);
      await expect(f.page.locator('.lib-group .ellipsis')).toHaveText([...labels]);
      await expect(titles(f.page)).toHaveCount(4);
      await f.page.getByRole('button', { name: 'Collapse all', exact: true }).click();
      await expect(titles(f.page)).toHaveCount(0);
      await f.page.getByRole('button', { name: 'Expand all', exact: true }).click();
      await expect(titles(f.page)).toHaveCount(4);
    }
  } finally { await f.close(); }
});
