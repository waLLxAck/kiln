import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { desktopEnv, readyLibrary } from './fixture';

const skill = '---\nname: from-the-laptop\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff.\n';
/** Kiln's own CLI (built by npm run build) on another clone: a second machine approving and pushing. Like any machine, it pulls first. */
function approveOnLaptop(root: string, library: string, title: string) {
  execFileSync('git', ['-C', library, 'pull', '-q', '--ff-only'], { windowsHide: true });
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [path.resolve('dist/cli/workbench.cjs'), '--library', library, '--local', path.join(root, 'private-laptop'), ...args], { encoding: 'utf8', windowsHide: true })).data;
  const file = path.join(root, 'skill.md'); fs.writeFileSync(file, skill);
  const item = cli('items', 'create', '--title', title, '--kind', 'skill', '--file', file);
  const input = path.join(root, 'approve.json'); fs.writeFileSync(input, JSON.stringify({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' }));
  return cli('approvals', 'approve', '--human-reviewed', '--input', input) as { commit: string };
}

test('background sync: the status bar shows new GitHub commits and pulls them; offline is quiet', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-auto-sync-'));
  const library = readyLibrary(root);
  execFileSync('git', ['-C', library, 'push', '-q', '-u', 'origin', 'HEAD'], { windowsHide: true });
  const other = path.join(root, 'other'); execFileSync('git', ['clone', '-q', path.join(root, 'origin.git'), other], { windowsHide: true });
  const env = { ...desktopEnv(root, library), KILN_DESKTOP_DATA: path.join(root, 'profile'), KILN_SYNC_INTERVAL_MS: '1500' };
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Refresh library', exact: true }).waitFor();
    const repo = page.getByRole('button', { name: /^Repository:/ });
    await expect(repo).toContainText('main');
    await expect(repo).toContainText('Up to date');

    expect(approveOnLaptop(root, other, 'From the laptop').commit).toBeTruthy();
    // The next background fetch finds it, without anyone asking.
    await expect(repo).toHaveAccessibleName('Repository: 1 new on GitHub');
    await repo.click();
    const popover = page.getByRole('dialog', { name: 'Sync with GitHub' });
    await expect(popover).toContainText('Checked GitHub');
    await expect(popover).toContainText('1 new on GitHub');
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(repo).toBeFocused();

    // Settings says the same, once.
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await expect(page.locator('.connected-repo')).toContainText('1 new on GitHub');

    await page.locator('.status-bar').getByRole('button', { name: 'Pull', exact: true }).click();
    await expect(page.getByText('Pulled 1 change from GitHub')).toBeVisible();
    await expect(repo).toHaveAccessibleName('Repository: Up to date');
    await expect(page.locator('.connected-repo')).toContainText('nothing new on GitHub');
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await expect(page.getByText('From the laptop')).toBeVisible();

    // Offline is shown quietly, never as an error.
    execFileSync('git', ['-C', library, 'remote', 'set-url', 'origin', path.join(root, 'missing.git')], { windowsHide: true });
    await expect(repo).toHaveAccessibleName('Repository: Offline');
    await expect(page.locator('.global-error')).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
