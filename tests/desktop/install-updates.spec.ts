import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

// Experimental installUpdates ("Update installed copies") and keepOutsideEdits ("Keep changes made outside Kiln").
const skill = (body: string) => `---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\n${body}\n`;

/** Two personal locations with the skill installed in both at revision one, then revision two approved and the Claude copy edited by hand. */
async function setUp(page: Page, home: string) {
  await expect(page.getByRole('tab', { name: /^All/ })).toBeVisible();
  const itemId = await page.evaluate(async ({ home, one, two }) => {
    const call = window.kiln.call;
    const targets = [];
    for (const provider of ['codex', 'claude']) targets.push(await call<any>('targets.enroll', { name: provider, provider, root: home, scope: 'personal' }));
    const item = await call<any>('items.create', { title: 'Careful review', kind: 'skill', content: one });
    for (const target of targets) await call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
    const detail = await call<any>('items.read', { id: item.id });
    const next = await call<any>('items.update', { id: item.id, expect: item.revision, summary: 'Version two', value: { ...detail.revision, collection: detail.item.collection, content: two } });
    await call('approvals.approve', { id: item.id, revision: next.revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' });
    return item.id as string;
  }, { home, one: skill('Version one.'), two: skill('Version two.') });
  fs.appendFileSync(path.join(home, '.claude', 'skills', 'careful-review', 'SKILL.md'), 'Edited in the Claude folder.\n');
  await page.reload();
  await page.getByRole('tab', { name: /^Skills/ }).click();
  await page.locator('.item-card').filter({ hasText: 'Careful review' }).click();
  await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'installs', exact: true }).click();
  return itemId;
}

test('outdated copies show Update, update from the toggle and the header, and edited copies can be kept and adopted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-install-updates-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const agents = path.join(home, '.agents', 'skills', 'careful-review'), claude = path.join(home, '.claude', 'skills', 'careful-review');
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_EXPERIMENTS: 'installUpdates,keepOutsideEdits' } });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const itemId = await setUp(page, home);
    const toggles = page.getByRole('group', { name: 'Installed for' });
    const toast = page.locator('.toast');
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toContainText('Update');
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toHaveAttribute('title', /newer version is approved/);
    await expect(toggles.getByRole('button', { name: /^Claude/ })).toContainText('edited');
    await expect(page.locator('.installation-row').filter({ hasText: 'behind the approved version' }).getByText('update available')).toBeVisible();
    await expect(page.locator('.item-card').filter({ hasText: 'Careful review' }).locator('.install-mark.outdated')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Update installs (1)' })).toBeVisible();
    await page.screenshot({ path: 'test-results/install-updates-outdated.png' });

    // The outdated toggle offers Update instead of the remove dialog.
    await toggles.getByRole('button', { name: /^Agents/ }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Update available in Agents' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toast).toContainText('Updated Agents to revision');
    await expect(toast).toContainText('New agent sessions pick up the change.');
    expect(fs.readFileSync(path.join(agents, 'SKILL.md'), 'utf8')).toBe(skill('Version two.'));
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toContainText('Installed');
    await expect(page.getByRole('button', { name: /^Update installs/ })).toHaveCount(0);

    // A new draft: the header approves it and updates every copy Kiln installed, skipping the edited one.
    await page.evaluate(async ({ id, content }) => {
      const detail = await window.kiln.call<any>('items.read', { id });
      await window.kiln.call('items.update', { id, expect: detail.item.revision, summary: 'Version three', value: { ...detail.revision, collection: detail.item.collection, content } });
    }, { id: itemId, content: skill('Version three.') });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.getByRole('button', { name: 'Approve & update installs' }).click();
    await expect(toast).toContainText('Approved revision');
    await expect(toast).toContainText('Updated Agents');
    await expect(toast).toContainText('Skipped Claude (edited outside Kiln)');
    expect(fs.readFileSync(path.join(agents, 'SKILL.md'), 'utf8')).toBe(skill('Version three.'));
    expect(fs.readFileSync(path.join(claude, 'SKILL.md'), 'utf8')).toContain('Edited in the Claude folder.');

    // Keep the Claude edits as a draft of the same item, then approve: the folder is adopted as it is and Agents follows.
    const edited = fs.readFileSync(path.join(claude, 'SKILL.md'), 'utf8'), inode = fs.statSync(path.join(claude, 'SKILL.md')).ino;
    await toggles.getByRole('button', { name: /^Claude/ }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Keep these changes saves this folder as a new draft/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep these changes' }).click();
    await expect(dialog.getByRole('heading', { name: 'Changes kept as a draft' })).toBeVisible();
    await expect(dialog).toContainText('Kept changes from the Claude copy');
    await page.screenshot({ path: 'test-results/install-updates-kept.png' });
    await dialog.getByRole('button', { name: 'Approve & update installs' }).click();
    await expect(toast).toContainText('the Claude copy is now the installed version, left exactly as it was');
    await expect(toast).toContainText('Updated Agents');
    await expect(toggles.getByRole('button', { name: /^Claude/ })).toContainText('Installed');
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toContainText('Installed');
    expect(fs.readFileSync(path.join(claude, 'SKILL.md'), 'utf8')).toBe(edited);
    expect(fs.statSync(path.join(claude, 'SKILL.md')).ino).toBe(inode);
    expect(fs.readFileSync(path.join(agents, 'SKILL.md'), 'utf8')).toBe(edited);
    const items = await page.evaluate(() => window.kiln.call<any[]>('items.list', {}));
    expect(items).toHaveLength(1);

    // Compare offers Keep too.
    fs.appendFileSync(path.join(claude, 'SKILL.md'), 'Another local note.\n');
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.locator('.installation-row').filter({ hasText: 'edited outside Kiln' }).getByRole('button', { name: 'Compare', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1 of 1 file differ.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep these changes' }).click();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(toast).toContainText('kept the Claude copy as a new draft');
    const detail = await page.evaluate(id => window.kiln.call<any>('items.read', { id }), itemId);
    expect(detail.revision.summary).toBe('Kept changes from the Claude copy');
    expect(detail.revision.content).toContain('Another local note.');
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('with the flags off an outdated copy still reads Installed and the edited copy has no Keep button', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-install-updates-off-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const env = desktopEnv(root); delete (env as Record<string, string | undefined>).KILN_EXPERIMENTS;
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  try {
    await setUp(page, home);
    const toggles = page.getByRole('group', { name: 'Installed for' });
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toContainText('Installed');
    await expect(page.locator('.install-mark.outdated')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Update installs/ })).toHaveCount(0);
    await expect(page.locator('.detail-actions').getByRole('button', { name: 'Installed', exact: true })).toBeVisible();
    await toggles.getByRole('button', { name: /^Claude/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edited copy in Claude' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reinstall approved version' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Keep these changes' })).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
