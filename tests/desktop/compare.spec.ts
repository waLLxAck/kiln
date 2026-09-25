import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('comparing a CRLF folder copy shows only the real change, with the differing words marked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln compare '));
  const target = path.join(root, 'agent project'); fs.mkdirSync(target);
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible();
    const lines = ['---', 'name: desktop-review', 'description: Review a supplied change for defects.', '---', '', '# Procedure', ...Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: read the supplied diff and verify every claim.`), 'Present the parent execution proof and pause for human approval.', 'Complete when the human decision is recorded.'];
    const library = lines.join('\n') + '\n';
    const folder = lines.map(l => l.startsWith('Present') ? 'Present the parent execution proof and wait for human approval.' : l).join('\r\n') + '\r\n';
    await page.evaluate(async content => { await (window as any).kiln.call('items.create', { kind: 'skill', title: 'Desktop review skill', content, collection: 'Personal', tags: [], files: {}, source: '', licence: 'Unknown' }); }, library);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Machines' }).click();
    await page.getByRole('button', { name: 'Enroll project folder', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Test Codex project');
    await page.getByLabel('Allowed root').fill(target);
    await page.getByRole('dialog').getByRole('button', { name: 'Enroll environment', exact: true }).click();
    const destination = path.join(target, '.agents', 'skills', 'desktop-review'); fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'SKILL.md'), folder);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.getByRole('button', { name: /Desktop review skill/ }).click();
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'installs', exact: true }).click();
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('1 of 1 file differ.')).toBeVisible();
    const diff = dialog.locator('.diff');
    await expect(diff.locator('pre.removed')).toHaveCount(1);
    await expect(diff.locator('pre.added')).toHaveCount(1);
    await expect(diff.locator('pre.removed mark')).toHaveText(['wait']);
    await expect(diff.locator('pre.added mark')).toHaveText(['pause']);
    await expect(diff.locator('.diff-note')).toContainText('the installed copy CRLF, the approved version LF');
    const collapsed = diff.locator('pre.collapsed');
    await expect(collapsed).toHaveText(/33 unchanged lines/);
    await page.screenshot({ path: 'test-results/compare-crlf.png' });
    await collapsed.click();
    await expect(diff.locator('pre.collapsed')).toHaveCount(0);
    await expect(diff.getByText('Step 1: read the supplied diff and verify every claim.')).toBeVisible();
    // A copy that differs only by line endings says so instead of showing an empty or all-red diff.
    fs.writeFileSync(path.join(destination, 'SKILL.md'), library.replace(/\n/g, '\r\n'));
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.diff-note')).toContainText('Only line endings differ: the installed copy uses CRLF, the approved version uses LF.');
    await expect(page.getByRole('dialog').locator('.diff pre.removed, .diff pre.added')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/compare-line-endings.png' });
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
