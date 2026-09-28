import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

// Update installed copies (one update path for the item page, a location and Machines) and keep changes made outside Kiln.
const skill = (body: string) => `---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\n${body}\n`;
const api = <T,>(page: Page, method: string, args?: unknown) => page.evaluate(([m, a]) => (window as any).kiln.call(m, a), [method, args] as const) as Promise<T>;
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
/** Saves `content` as the item's next revision; `approve` approves it, `pass` records a passing manual experiment on it. */
async function revise(page: Page, id: string, content: string, { approve = false, pass = false } = {}) {
  const detail = await api<any>(page, 'items.read', { id });
  const next = await api<{ revision: string }>(page, 'items.update', { id, expect: detail.item.revision, summary: 'Next version', value: { ...detail.revision, collection: detail.item.collection, content } });
  if (approve) await api(page, 'approvals.approve', { id, revision: next.revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' });
  if (pass) {
    const { trial } = await api<{ trial: { id: string } }>(page, 'trials.create', { id, revision: next.revision, provider: 'manual', task: 'Review a small diff', rubric: ['Finds the bug'], case: 'typical' });
    await api(page, 'trials.finish', { id: trial.id, judgement: 'pass', note: 'Found it.', output: 'Found the off-by-one.' });
  }
  await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
}

/** Two personal locations with the skill installed in both at revision one, then revision two approved and the Claude copy edited by hand. */
async function setUp(page: Page, home: string) {
  await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
  const itemId = await page.evaluate(async ({ home, one }) => {
    const call = (window as any).kiln.call;
    const targets = [];
    for (const provider of ['codex', 'claude']) targets.push(await call('targets.enroll', { name: provider, provider, root: home, scope: 'personal' }));
    const item = await call('items.create', { title: 'Careful review', kind: 'skill', content: one });
    for (const target of targets) await call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
    return item.id as string;
  }, { home, one: skill('Version one.') });
  await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
  await page.getByText('Careful review', { exact: true }).first().click();
  await revise(page, itemId, skill('Version two.'), { approve: true });
  fs.appendFileSync(path.join(home, '.claude', 'skills', 'careful-review', 'SKILL.md'), 'Edited in the Claude folder.\n');
  await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
  return itemId;
}

test('outdated copies show Update on their location and under Installs, update from the location, the header and Machines, and edited copies are skipped, kept and adopted', async () => {
  test.setTimeout(120_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-install-updates-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const agents = path.join(home, '.agents', 'skills', 'careful-review', 'SKILL.md'), claude = path.join(home, '.claude', 'skills', 'careful-review', 'SKILL.md');
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const itemId = await setUp(page, home);
    const installs = page.getByRole('region', { name: 'Installs', exact: true });
    const toggles = installs.getByRole('group', { name: 'Installed for' });
    const toast = page.locator('.toast');
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toContainText('Update');
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toHaveAttribute('title', /newer version is approved/);
    await expect(toggles.getByRole('button', { name: /^Claude/ })).toContainText('edited');
    await expect(installs.getByRole('button', { name: /^Installs/ })).toContainText('1 changed · 1 update available');
    // A copy edited outside Kiln is a problem on disk, so resolving it comes before updating.
    await expect(page.getByRole('button', { name: 'Resolve 1 changed copy' })).toBeVisible();
    await page.screenshot({ path: 'test-results/install-updates-outdated.png' });

    // The outdated location offers Update, with Remove beside it.
    await toggles.getByRole('button', { name: /^Agents/ }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Update available in Agents' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toast).toContainText('Updated Agents to revision');
    await expect(toast).toContainText('New agent sessions pick up the change.');
    expect(fs.readFileSync(agents, 'utf8')).toBe(skill('Version two.'));
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toContainText('Installed');
    await expect(installs.getByRole('button', { name: /^Installs/ })).not.toContainText('update available');

    // Keep the Claude edits as a draft of the same item, then approve: the folder is adopted as it is and Agents follows.
    const edited = fs.readFileSync(claude, 'utf8'), inode = fs.statSync(claude).ino;
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
    expect(fs.readFileSync(claude, 'utf8')).toBe(edited);
    expect(fs.statSync(claude).ino).toBe(inode);
    expect(fs.readFileSync(agents, 'utf8')).toBe(edited);
    expect(await api<any[]>(page, 'items.list', {})).toHaveLength(1);

    // A passing draft of an installed skill: the header approves it and updates every copy Kiln installed.
    await revise(page, itemId, skill('Version four.'), { pass: true });
    await page.getByRole('button', { name: 'Approve & update installs' }).click();
    await expect(toast).toContainText('Approved revision');
    await expect(toast).toContainText('Updated Agents and Claude to revision');
    expect(fs.readFileSync(agents, 'utf8')).toBe(skill('Version four.'));
    expect(fs.readFileSync(claude, 'utf8')).toBe(skill('Version four.'));

    // A newer approval: the header's primary action is Update installs (N).
    await revise(page, itemId, skill('Version five.'), { approve: true });
    await expect(installs.getByRole('button', { name: /^Installs/ })).toContainText('2 updates available');
    await page.getByRole('button', { name: 'Update installs (2)' }).click();
    await expect(toast).toContainText('Updated Agents and Claude to revision');
    await expect(page.getByRole('button', { name: /^Update installs/ })).toHaveCount(0);
    expect(fs.readFileSync(claude, 'utf8')).toBe(skill('Version five.'));

    // Machines' Update all outdated goes through the same update: the edited Claude copy is skipped and named, never overwritten.
    await revise(page, itemId, skill('Version six.'), { approve: true });
    fs.appendFileSync(claude, 'Another local note.\n');
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await nav(page, 'Machines');
    await expect(page.getByRole('button', { name: 'Careful review in Agents: Outdated' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Careful review in Claude: Changed outside Kiln' })).toBeVisible();
    await page.getByRole('button', { name: 'Update all outdated' }).click();
    await expect(toast).toContainText('Updated Careful review in Agents to the approved revision. Skipped Careful review in Claude (edited outside Kiln).');
    await expect(page.getByRole('button', { name: 'Careful review in Agents: Installed' })).toBeVisible();
    expect(fs.readFileSync(agents, 'utf8')).toBe(skill('Version six.'));
    expect(fs.readFileSync(claude, 'utf8')).toContain('Another local note.');

    // Compare (here from the Machines cell) offers Keep too.
    await page.getByRole('button', { name: 'Careful review in Claude: Changed outside Kiln' }).click();
    await page.getByRole('dialog', { name: 'Careful review in Claude' }).getByRole('button', { name: 'Compare…' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1 of 1 file differ.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep these changes' }).click();
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(toast).toContainText('kept the Claude copy as a new draft');
    const detail = await api<any>(page, 'items.read', { id: itemId });
    expect(detail.revision.summary).toBe('Kept changes from the Claude copy');
    expect(detail.revision.content).toContain('Another local note.');
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
