import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { desktopEnv, readyLibrary } from './fixture';

const skill = '---\nname: from-the-laptop\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff.\n';
/** Kiln's own CLI (built by npm run build) on another clone: a second machine approving and pushing. */
function approveOnLaptop(root: string, library: string, title: string) {
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [path.resolve('dist/cli/workbench.cjs'), '--library', library, '--local', path.join(root, 'private-laptop'), ...args], { encoding: 'utf8', windowsHide: true })).data;
  const file = path.join(root, 'skill.md'); fs.writeFileSync(file, skill);
  const item = cli('items', 'create', '--title', title, '--kind', 'skill', '--file', file);
  const input = path.join(root, 'approve.json'); fs.writeFileSync(input, JSON.stringify({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' }));
  return cli('approvals', 'approve', '--human-reviewed', '--input', input) as { commit: string };
}

test('background sync: off shows the branch and never fetches; on shows new GitHub commits and pulls them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-auto-sync-'));
  const library = readyLibrary(root);
  execFileSync('git', ['-C', library, 'push', '-q', '-u', 'origin', 'HEAD'], { windowsHide: true });
  const other = path.join(root, 'other'); execFileSync('git', ['clone', '-q', path.join(root, 'origin.git'), other], { windowsHide: true });
  const env = { ...desktopEnv(root, library), KILN_DESKTOP_DATA: path.join(root, 'profile'), KILN_SYNC_INTERVAL_MS: '1500' };
  delete (env as Record<string, string | undefined>).KILN_EXPERIMENTS;
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.locator('.item-list').waitFor();
    await expect(page.locator('.git-indicator')).toHaveText('main');
    await expect(page.locator('.sync-indicator')).toHaveCount(0);

    expect(approveOnLaptop(root, other, 'From the laptop').commit).toBeTruthy();
    // Several fetch intervals pass with the switch off: nothing reaches out to GitHub.
    await page.waitForTimeout(4000);
    expect(fs.existsSync(path.join(library, '.git', 'FETCH_HEAD'))).toBe(false);
    await expect(page.locator('.git-indicator')).toHaveText('main');

    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await page.getByRole('region', { name: 'Experimental features' }).getByRole('switch', { name: 'Background sync with GitHub' }).click();
    const pill = page.getByRole('button', { name: '1 new on GitHub' });
    await expect(pill).toBeVisible();
    await expect(page.locator('.connected-repo')).toContainText('1 new on GitHub');
    await pill.click();
    await expect(page.getByRole('dialog', { name: 'Sync with GitHub' })).toContainText('Checked GitHub');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Sync with GitHub' })).toHaveCount(0);

    await page.locator('.sync-indicator').getByRole('button', { name: 'Pull', exact: true }).click();
    await expect(page.getByText('Pulled 1 change from GitHub')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Up to date' })).toBeVisible();
    await expect(page.locator('.connected-repo')).toContainText('nothing new on GitHub');
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await expect(page.getByRole('button', { name: /From the laptop/ })).toBeVisible();

    // Offline is shown quietly, never as an error.
    execFileSync('git', ['-C', library, 'remote', 'set-url', 'origin', path.join(root, 'missing.git')], { windowsHide: true });
    await expect(page.getByRole('button', { name: 'Offline' })).toBeVisible();
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
