import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

// Keep these changes: a copy edited outside Kiln becomes a new draft of the item, and approving it adopts the folder as it is.
const skill = (body: string) => `---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\n${body}\n`;
const read = (page: Page, id: string) => page.evaluate(id => window.kiln.call<any>('items.read', { id }), id);

/** The skill installed and approved in Agents and Claude, then the Claude copy edited by hand; the item page open on it. */
async function setUp(page: Page, home: string) {
  await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
  const itemId = await page.evaluate(async ({ home, content }) => {
    const call = window.kiln.call;
    const targets = [];
    for (const provider of ['codex', 'claude']) targets.push(await call<any>('targets.enroll', { name: provider, provider, root: home, scope: 'personal' }));
    const item = await call<any>('items.create', { title: 'Careful review', kind: 'skill', content });
    await call('approvals.approve', { id: item.id, revision: item.revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' });
    for (const target of targets) await call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
    return item.id as string;
  }, { home, content: skill('Version one.') });
  fs.appendFileSync(path.join(home, '.claude', 'skills', 'careful-review', 'SKILL.md'), 'Edited in the Claude folder.\n');
  await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
  await page.locator('.item-card').filter({ hasText: 'Careful review' }).click();
  return itemId;
}

test('keep a copy edited outside Kiln from the Installs rail, Compare and Machines; reload on conflict; warn about skipped entries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-keep-changes-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const claude = path.join(home, '.claude', 'skills', 'careful-review'), agents = path.join(home, '.agents', 'skills', 'careful-review');
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const itemId = await setUp(page, home);
    const installs = page.getByRole('region', { name: 'Installs', exact: true });
    // Personal locations are toggles in the rail; a changed copy's toggle opens its dialog, which offers Keep these changes.
    const claudeCopy = installs.getByRole('group', { name: 'Installed for' }).getByRole('button', { name: /^Claude/ });
    const keepFromRail = async () => { await claudeCopy.click(); await page.getByRole('dialog').getByRole('button', { name: 'Keep these changes' }).click(); };
    const toast = page.locator('.toast');

    // The changed copy in the rail keeps it with one button; approving adopts the folder without rewriting it.
    const edited = fs.readFileSync(path.join(claude, 'SKILL.md'), 'utf8'), inode = fs.statSync(path.join(claude, 'SKILL.md')).ino;
    await expect(claudeCopy).toContainText('edited');
    await keepFromRail();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Changes kept as a draft' })).toBeVisible();
    await expect(dialog).toContainText('Kept changes from the Claude copy');
    await page.screenshot({ path: 'test-results/keep-changes-kept.png' });
    await dialog.getByRole('button', { name: 'Approve & update installs' }).click();
    await expect(toast).toContainText('the Claude copy is now the installed version, left exactly as it was');
    await expect(toast).toContainText('Updated Agents');
    expect(fs.readFileSync(path.join(claude, 'SKILL.md'), 'utf8')).toBe(edited);
    expect(fs.statSync(path.join(claude, 'SKILL.md')).ino).toBe(inode);
    expect(fs.readFileSync(path.join(agents, 'SKILL.md'), 'utf8')).toBe(edited);
    await expect(claudeCopy).toContainText('Installed');
    expect(await page.evaluate(() => window.kiln.call<any[]>('items.list', {}))).toHaveLength(1);

    // Compare (here from the item's history, where the change outside Kiln is listed) offers it too; Not now leaves the draft for later.
    fs.appendFileSync(path.join(claude, 'SKILL.md'), 'Another local note.\n');
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await expect(claudeCopy).toContainText('edited');
    await page.getByRole('button', { name: 'Open history', exact: true }).click();
    await page.getByRole('button', { name: 'Compare', exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1 of 1 file differ.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep these changes' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Changes kept as a draft' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click();
    await expect(toast).toContainText('kept the Claude copy as a new draft');
    let detail = await read(page, itemId);
    expect(detail.revision.summary).toBe('Kept changes from the Claude copy');
    expect(detail.revision.content).toContain('Another local note.');

    // The item changed after the page was loaded: nothing is overwritten, and Kiln reloads it.
    fs.appendFileSync(path.join(claude, 'SKILL.md'), 'A third note.\n');
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await expect(claudeCopy).toContainText('edited');
    await page.evaluate(async ({ id, content }) => {
      const detail = await window.kiln.call<any>('items.read', { id });
      await window.kiln.call('items.update', { id, expect: detail.item.revision, summary: 'Changed elsewhere', value: { ...detail.revision, collection: detail.item.collection, content } });
    }, { id: itemId, content: skill('Changed elsewhere.') });
    await keepFromRail();
    await expect(page.getByText(/changed since you opened it, so nothing was kept/).first()).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    detail = await read(page, itemId);
    expect(detail.revision.summary).toBe('Changed elsewhere');
    expect(detail.revision.content).not.toContain('A third note.');

    // A folder with entries the importer skips can be kept, with a warning and no adopting.
    fs.mkdirSync(path.join(claude, 'node_modules')); fs.writeFileSync(path.join(claude, 'node_modules', 'x.js'), '');
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await keepFromRail();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Changes kept as a draft' })).toBeVisible();
    await expect(dialog).toContainText('Not kept, as when importing: node_modules');
    await expect(dialog.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Not now' }).click();
    fs.rmSync(path.join(claude, 'node_modules'), { recursive: true });

    // Machines: the changed cell on this machine offers it for that copy.
    fs.appendFileSync(path.join(claude, 'SKILL.md'), 'A note kept from Machines.\n');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Machines' }).click();
    await page.getByRole('button', { name: /^Careful review in Claude: Changed outside Kiln/ }).click();
    const cell = page.getByRole('dialog', { name: 'Careful review in Claude' });
    await cell.getByRole('button', { name: 'Keep these changes' }).click();
    dialog = page.getByRole('dialog', { name: 'Changes kept as a draft' });
    await expect(dialog).toContainText('Kept changes from the Claude copy');
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect.poll(async () => (await read(page, itemId)).revision.content).toContain('A note kept from Machines.');
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
