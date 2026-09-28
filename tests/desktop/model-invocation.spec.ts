import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

// Model invocation from the library: one click edits the skill, keeps its approval, updates the installed copies, and the
// session-start estimate drops.
const skill = '---\nname: careful-review\ndescription: Review a change for correctness and clear evidence before it is merged.\n---\n\n# Procedure\nRead the diff.\n';
const api = <T,>(page: Page, method: string, args?: unknown) => page.evaluate(([m, a]) => (window as any).kiln.call(m, a), [method, args] as const) as Promise<T>;
/** The Claude Code estimate the status bar shows, in tokens. */
async function claudeTokens(page: Page) {
  const text = await page.locator('.status-item.context').textContent() ?? '';
  const value = text.match(/Claude ≈ ([\d.]+)(k?)/); expect(value, text).not.toBeNull();
  return Number(value![1]) * (value![2] ? 1000 : 1);
}

test('Invoked by in the library turns model invocation off: the installed front-matter changes, the item stays approved, installed and matching, and Session start drops', async () => {
  test.setTimeout(120_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-model-invocation-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const claudeCopy = path.join(home, '.claude', 'skills', 'careful-review'), agentsCopy = path.join(home, '.agents', 'skills', 'careful-review');
  // KILN_HOME: the session-start estimate reads this home's client folders, not the real one.
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_HOME: home } });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    const itemId = await page.evaluate(async ({ home, skill }) => {
      const call = (window as any).kiln.call;
      const targets = [];
      for (const provider of ['codex', 'claude']) targets.push(await call('targets.enroll', { name: provider, provider, root: home, scope: 'personal' }));
      const item = await call('items.create', { title: 'careful-review', kind: 'skill', content: skill });
      await call('approvals.approve', { id: item.id, revision: item.revision, reviewer: 'tester', scope: 'Code review', note: 'ok', waivedChecks: 'test' });
      for (const target of targets) await call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });
      return item.id as string;
    }, { home, skill });
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();

    // The column shows who may invoke it, and Session start counts its description.
    const head = page.locator('.lib-row.head');
    await expect(head.getByRole('columnheader', { name: 'Invoked by' })).toBeVisible();
    const toggle = page.locator('.item-card').filter({ hasText: 'careful-review' }).getByRole('button', { name: 'Model can invoke careful-review' });
    await expect(toggle).toHaveText('Model & you');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.status-item.context')).toContainText('Claude ≈');
    const before = await claudeTokens(page);
    expect(before).toBeGreaterThan(0);

    // One click: the skill's own files change, the approval is carried over and both copies are updated.
    await toggle.click();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('careful-review: model invocation turned off; approval carried over, as only the flag changed.');
    await expect(toast).toContainText('New agent sessions pick up the change.');
    await expect(toggle).toHaveText('You only');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(fs.readFileSync(path.join(claudeCopy, 'SKILL.md'), 'utf8')).toBe(skill.replace('merged.\n---', 'merged.\ndisable-model-invocation: true\n---'));
    expect(fs.readFileSync(path.join(agentsCopy, 'agents', 'openai.yaml'), 'utf8')).toBe('policy:\n  allow_implicit_invocation: false\n');
    const copies = await api<{ state: string; matches: boolean; outdated?: boolean }[]>(page, 'deploy.installations', { itemId });
    expect(copies.map(c => [c.state, c.matches, c.outdated ?? false])).toEqual([['installed', true, false], ['installed', true, false]]);
    const row = page.locator('.item-card').filter({ hasText: 'careful-review' });
    await expect(row.locator('.col-status')).toContainText('Approved');
    await expect(row.locator('.col-installed')).toContainText('2 of 2');
    await expect(row.locator('.col-installed')).not.toContainText(/changed|update/);

    // Session start drops, and the breakdown lists the skill as not loaded, with the switch to turn it back on.
    await expect.poll(() => claudeTokens(page)).toBeLessThan(before);
    await page.locator('.status-item.context').click();
    const breakdown = page.getByRole('dialog', { name: 'What loads at session start' });
    await expect(breakdown.getByRole('tab', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'true');
    await breakdown.getByText('1 not loaded').click();
    const hidden = breakdown.locator('.ctx-row.off').filter({ hasText: 'careful-review' });
    await expect(hidden).toContainText('You only: disable-model-invocation');
    await breakdown.getByRole('tab', { name: /Codex/ }).click();
    await breakdown.getByText('1 not loaded').click();
    await expect(breakdown.locator('.ctx-row.off').filter({ hasText: 'careful-review' })).toContainText('allow_implicit_invocation: false');
    await page.keyboard.press('Escape');
    await expect(breakdown).toHaveCount(0);

    // is:user-only finds it; the item page says it once, in words.
    const bar = page.getByRole('combobox', { name: 'Search library' });
    await bar.fill('is:user-only'); await bar.press('Enter'); await bar.press('Escape');
    await expect(page.locator('.item-card .item-title')).toHaveText(['careful-review']);
    await page.locator('.item-card').filter({ hasText: 'careful-review' }).click();
    await expect(page.locator('.item-props')).toContainText('Model can invoke');
    await expect(page.locator('.item-props')).toContainText('no (you only)');
    const installs = page.getByRole('region', { name: 'Installs', exact: true });
    await expect(installs.getByRole('button', { name: 'Model can invoke careful-review' })).toHaveText('You only');
    await expect(installs.getByRole('button', { name: /^Installs/ })).toContainText('2 installed');

    // Back on from the breakdown: the original bytes return and so does the estimate.
    await page.locator('.status-item.context').click();
    await breakdown.getByText('1 not loaded').click();
    await breakdown.getByRole('button', { name: 'Model can invoke careful-review' }).click();
    await expect(toast).toContainText('model invocation turned on');
    expect(fs.readFileSync(path.join(claudeCopy, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fs.existsSync(path.join(agentsCopy, 'agents'))).toBe(false);
    await expect.poll(() => claudeTokens(page)).toBe(before);
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
