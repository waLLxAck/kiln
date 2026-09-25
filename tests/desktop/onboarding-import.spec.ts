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
