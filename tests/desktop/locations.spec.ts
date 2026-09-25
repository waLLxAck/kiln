import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('shared locations, native copies and cleanup are clear in Settings and Library', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-locations-ui-'));
  const home = path.join(root, 'home');
  const shared = path.join(home, '.agents/skills/review');
  const native = path.join(home, '.codex/skills/review');
  const claude = path.join(home, '.claude/skills');
  for (const dir of [shared, native, claude]) fs.mkdirSync(dir, { recursive: true });
  const content = '---\nname: review\ndescription: Review changes carefully\n---\nRead the diff.\n';
  fs.writeFileSync(path.join(shared, 'SKILL.md'), content);
  fs.writeFileSync(path.join(native, 'SKILL.md'), content + 'Different native copy.');
  const broken = path.join(claude, 'gone'); fs.symlinkSync(path.join(home, 'missing'), broken, 'junction');
  fs.mkdirSync(path.join(claude, 'empty'));
  const app = await electron.launch({ ...(process.env.KILN_LOCATIONS_EXE ? { executablePath: process.env.KILN_LOCATIONS_EXE } : { args: ['.'] }), env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('tab', { name: /^All/ })).toBeVisible();
    const item = await page.evaluate(async ({ home, content }) => {
      for (const provider of ['codex', 'claude']) await window.kiln.call('targets.enroll', { name: provider, provider, root: home, scope: 'personal' });
      return window.kiln.call<any>('items.create', { title: 'Review', kind: 'skill', content });
    }, { home, content });
    await page.reload();
    await page.getByRole('button', { name: 'Settings & repository', exact: true }).click();
    await expect(page.getByLabel('Manage Agents', { exact: true })).toBeChecked();
    const card = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Skill & agent locations' }) });
    await expect(card.getByText(`${home}/.agents/skills`, { exact: true })).toBeVisible();
    await expect(card.getByText(`${home}/.codex/agents`, { exact: true })).toBeVisible();
    await expect(card.getByText(`${home}/.claude/agents`, { exact: true })).toBeVisible();
    await expect(card.getByText('unavailable', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/locations-settings.png' });
    await card.getByRole('button', { name: 'Find skills and agents not in the library' }).nth(1).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Broken link: its destination no longer exists.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove broken link', exact: true }).click();
    await expect.poll(() => fs.lstatSync(broken, { throwIfNoEntry: false })).toBeUndefined();
    await dialog.getByRole('button', { name: 'Remove empty folder', exact: true }).click();
    await expect.poll(() => fs.existsSync(path.join(claude, 'empty'))).toBe(false);
    await page.screenshot({ path: 'artifacts/locations-cleanup.png' });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: /^Library/ }).click();
    await page.getByRole('tab', { name: /^Skills/ }).click();
    await page.locator('.item-card').filter({ hasText: 'Review' }).click();
    await page.getByRole('button', { name: 'installs', exact: true }).click();
    const toggles = page.getByRole('group', { name: 'Installed for' });
    await expect(toggles.getByRole('button', { name: /^Agents/ })).toBeVisible();
    await expect(toggles.getByRole('button', { name: /^Claude/ })).toBeVisible();
    await expect(toggles.getByRole('button')).toHaveCount(2);
    await page.getByText('Client-specific copies (1)', { exact: true }).click();
    await expect(page.locator('.other-copies').getByText(native, { exact: true })).toBeVisible();
    await page.screenshot({ path: 'artifacts/locations-library.png' });
    const copies = await page.evaluate(id => window.kiln.call<any[]>('deploy.installations', { itemId: id }), item.id);
    expect(copies.map(i => i.location).sort()).toEqual(['agents', 'codex']);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
