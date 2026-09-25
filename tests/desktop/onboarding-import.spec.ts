import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('setup imports skills and agents and opens a current, bulk-manageable library without a reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-onboarding-import-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.agents/skills/.system/review'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents/skills/.system/review/SKILL.md'), '---\nname: review\ndescription: Review code\n---\nRead the diff.');
  fs.mkdirSync(path.join(home, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/agents/reviewer.md'), '---\nname: reviewer\ndescription: Review code\n---\nRead the diff.');
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_HOME: home } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await page.getByRole('button', { name: 'Connect a different repository…' }).click();
    await expect(page.getByRole('heading', { name: /Choose your providers and folders/ })).toBeVisible();
    await page.getByRole('button', { name: 'Import my installed skills', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1 of 1 selected')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import 1', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('1 skill imported as drafts.', { exact: true })).toBeVisible();
    await expect(page.getByTestId('manage-sources'), 'a nested .system skill is not where Kiln installs, so no folder is offered').toHaveCount(0);
    await page.getByRole('button', { name: 'Import my agents', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1 selected', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Import 1', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Review and bulk manage my library' }).click();
    await expect(page.locator('.item-card')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: /^Skills\s*1$/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Agents\s*1$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
    await expect(page.locator('.item-card')).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.kiln.call<any>('snapshot'));
    expect(snapshot.items.every((item: any) => Boolean(item.deletedAt))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents/skills/.system/review/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude/agents/reviewer.md'))).toBe(true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('after importing installed skills, one click manages their folders without touching them, and the copies show as found', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-onboarding-manage-'));
  const home = path.join(root, 'home');
  const write = (folder: string, name: string) => { fs.mkdirSync(path.join(home, folder, name), { recursive: true }); fs.writeFileSync(path.join(home, folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo the ${name} task.`); };
  write('.claude/skills', 'review'); write('.agents/skills', 'deploy');
  const listing = () => { const files: Record<string, string> = {}; const walk = (dir: string) => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else files[path.relative(home, full)] = fs.readFileSync(full, 'utf8'); } }; walk(path.join(home, '.claude/skills')); walk(path.join(home, '.agents/skills')); return files; };
  const before = listing();
  // Providers find personal folders through the home folder, so point it at the fixture as the screenshots do.
  const identity = { GIT_AUTHOR_NAME: 'Kiln Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Kiln Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), ...identity, HOME: home, USERPROFILE: home, KILN_HOME: home } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await page.getByRole('button', { name: 'Connect a different repository…' }).click();
    await expect(page.getByRole('checkbox', { name: 'Manage Claude' })).not.toBeChecked();
    await page.getByRole('button', { name: 'Import my installed skills', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('2 of 2 selected')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import 2', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const prompt = page.getByTestId('manage-sources');
    await expect(prompt.getByText('Manage these folders so Kiln can show the copies already there')).toBeVisible();
    await expect(prompt.locator('code')).toHaveText([path.join(home) + '/.agents/skills', path.join(home) + '/.claude/skills']);
    expect((await page.evaluate(() => window.kiln.call<any>('snapshot'))).targets).toHaveLength(0);
    await prompt.getByRole('button', { name: 'Manage the Agents and Claude folders' }).click();
    await expect(prompt).toHaveCount(0);
    await expect(page.getByText(/Kiln now manages .* Nothing was installed or changed/)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Manage Claude' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Manage Agents' })).toBeChecked();
    expect(listing(), 'managing a folder installs and changes nothing').toEqual(before);
    await page.getByRole('button', { name: 'Start using Kiln' }).click();
    await expect(page.locator('.item-card')).toHaveCount(2);
    await expect(page.locator('.install-mark.found')).toHaveCount(2);
    await expect(page.locator('.install-mark.off')).toHaveCount(2);
    expect(listing()).toEqual(before);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the import list skips folders that only hold skills, and two different skills with one name show where each came from', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-import-names-'));
  const home = path.join(root, 'home');
  const write = (folder: string, body: string) => { fs.mkdirSync(path.join(home, folder), { recursive: true }); fs.writeFileSync(path.join(home, folder, 'SKILL.md'), `---\nname: skill-creator\ndescription: Create skills\n---\n${body}`); };
  write('.claude/skills/synced/0c6f2e1a/skill-creator', 'Synced version.');
  write('.codex/skills/.system/skill-creator', 'Codex system version.');
  fs.mkdirSync(path.join(home, '.claude/skills/empty'), { recursive: true });
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_HOME: home, HOME: home, USERPROFILE: home } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Import my installed skills', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('2 of 2 selected')).toBeVisible();
    await expect(dialog.getByText('No SKILL.md inside; skipped.')).toHaveCount(1);
    await expect(dialog.locator('.inventory-list b')).toHaveText(['empty', 'skill-creator', 'skill-creator']);
    await dialog.getByRole('button', { name: 'Import 2', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const rows = page.locator('.item-card');
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('.lib-sub')).toHaveText([/from ~\/.(claude\/skills\/synced\/0c6f2e1a|codex\/skills\/.system)\/skill-creator/, /from ~\/.(claude\/skills\/synced\/0c6f2e1a|codex\/skills\/.system)\/skill-creator/]);
    await rows.filter({ hasText: '.system' }).click();
    await expect(page.getByRole('article', { name: 'Selected item' }).locator('.detail-source')).toHaveText('from ~/.codex/skills/.system/skill-creator');
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('an agents collection with a remembered skill tab opens All without a ghost Skills zero tab', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-empty-kind-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('tab', { name: /^All/ })).toBeVisible();
    await page.evaluate(async () => {
      await window.kiln.call('items.create', { kind: 'agent', title: 'Reviewer', content: 'Review.', agent: { provider: 'claude', filename: 'reviewer.md' }, collection: 'Agents' });
      localStorage.setItem('kiln-view-memory', JSON.stringify({ location: { section: 'library', collection: 'Agents', tab: 'skill' }, sections: {}, views: {} }));
    });
    await page.reload();
    await expect(page.getByRole('tab', { name: /^All\s*1$/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /^Skills/ })).toHaveCount(0);
    await expect(page.locator('.item-card')).toHaveCount(1);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
