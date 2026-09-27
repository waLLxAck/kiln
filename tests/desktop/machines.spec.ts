import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { desktopDefines } from '../../apps/desktop/build-flags';
import { execFileSync } from 'node:child_process';
import { desktopEnv, readyLibrary } from './fixture';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
async function openSkillInstalls(page: Page) {
  await page.evaluate(() => window.kiln.call('items.create', { kind: 'skill', title: 'review', content: '---\nname: review\ndescription: Review a change\n---\nRead the diff.', collection: 'Personal' }));
  await page.getByRole('button', { name: 'Refresh library' }).click();
  await page.locator('.item-card', { hasText: 'review' }).click();
  // Installs are a section of the item page's rail; there is no tab to open.
  await expect(page.getByRole('region', { name: 'Installs' })).toBeVisible();
}

test('development builds keep the full Machines section', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-machines-dev-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await nav(page).getByRole('button', { name: 'Machines' }).click();
    await expect(page.getByRole('tab', { name: /This machine/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /All machines/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Report now' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enroll project folder', exact: true })).toBeVisible();
    await expect(page.getByText('Coming soon')).toHaveCount(0);
    await nav(page).getByRole('button', { name: 'Library', exact: true }).click();
    await openSkillInstalls(page);
    await expect(page.getByText('Check live drift in Machines')).toBeVisible();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a public build shows Machines as coming soon, with nothing that leads into it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-machines-public-'));
  // The same app with its renderer rebuilt as release.yml builds it (KILN_PUBLIC_BUILD=1). The main process and CLI are shared.
  const appDir = path.join(root, 'app');
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.copyFileSync('package.json', path.join(appDir, 'package.json'));
  fs.cpSync('dist/desktop', path.join(appDir, 'dist', 'desktop'), { recursive: true });
  fs.symlinkSync(path.resolve('dist/cli'), path.join(appDir, 'dist', 'cli'), 'junction');
  fs.symlinkSync(path.resolve('assets'), path.join(appDir, 'assets'), 'junction');
  await build({ configFile: path.resolve('vite.config.ts'), logLevel: 'error', define: desktopDefines({ KILN_PUBLIC_BUILD: '1' }), build: { outDir: path.join(appDir, 'dist', 'renderer'), emptyOutDir: true } });
  const app = await electron.launch({ args: [appDir], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(nav(page).getByRole('button', { name: 'Machines' })).toContainText('Soon');
    await nav(page).getByRole('button', { name: 'Machines' }).click();
    await expect(page.getByText('Coming soon', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Every place your skills are installed, in one view' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enroll project folder' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /This machine/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Recover interrupted installs' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await nav(page).getByRole('button', { name: 'Library', exact: true }).click();
    await openSkillInstalls(page);
    await expect(page.getByRole('button', { name: 'Install a specific revision…' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Selected item' }).getByText(/Machines/)).toHaveCount(0);
    await expect(page.getByText('Check live drift in Machines')).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the matrix shows this machine live and another machine from its report, and marks travel through GitHub', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-machines-fleet-'));
  const library = readyLibrary(root), origin = path.join(root, 'origin.git'), home = path.join(root, 'home'); fs.mkdirSync(home);
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
  /** Runs a step on the other machine (tests/desktop/second-machine.ts) and returns its JSON output. */
  const studio = (step: 'setup' | 'sync') => JSON.parse(execFileSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('tests/desktop/second-machine.ts'), clone, path.join(root, 'studio', 'private'), studioHome, step], { encoding: 'utf8' }).trim().split('\n').at(-1)!);
  const clone = path.join(root, 'studio', 'library'), studioHome = path.join(root, 'studio', 'home');
  try {
    const page = await app.firstWindow();
    const content = '---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\nRead the diff.';
    const itemId = await page.evaluate(async ({ content, home }) => {
      const item = await window.kiln.call<{ id: string; revision: string }>('items.create', { kind: 'skill', title: 'Careful review', content, collection: 'Personal' });
      await window.kiln.call('approvals.approve', { id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', evidence: [], waivedChecks: 'Fixture' });
      await window.kiln.call('targets.enroll', { name: 'Claude skills', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
      return item.id;
    }, { content, home });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await nav(page).getByRole('button', { name: 'Machines' }).click();
    const cell = page.getByRole('button', { name: 'Careful review in Claude: Not installed' });
    await cell.click();
    await expect(page.getByRole('dialog', { name: 'Careful review in Claude' })).toContainText('Not installed here');
    await page.getByRole('button', { name: 'Install…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Careful review in Claude: Installed' })).toBeVisible();
    await expect(page.getByText(/Shared (just now|\d+ min ago)/)).toBeVisible({ timeout: 20_000 });

    // Another machine: a clone of the same "GitHub" with its own private data, reporting an Agents folder.
    execFileSync('git', ['clone', '-q', origin, clone]); fs.mkdirSync(studioHome, { recursive: true });
    const studioId = (studio('setup') as { id: string }).id;

    // Reopening Machines fetches (at most once a minute), so reopen after a fresh start of the view.
    await app.close();
    const again = await electron.launch({ args: ['.'], env: desktopEnv(root, library) });
    try {
      const view = await again.firstWindow();
      await nav(view).getByRole('button', { name: 'Machines' }).click();
      await view.getByRole('tab', { name: /studio-pc/ }).click();
      await view.getByRole('button', { name: 'Careful review in Agents: Not installed' }).click();
      await view.getByRole('button', { name: 'Mark for studio-pc' }).click();
      await expect(view.getByRole('button', { name: 'Careful review in Agents: Marked, not installed yet' })).toBeVisible();
      await expect.poll(() => { try { return JSON.parse(execFileSync('git', ['-C', origin, 'show', `main:workbench/machines/${studioId}.json`], { encoding: 'utf8' })).wanted[itemId]; } catch { return null; } }, { timeout: 20_000 }).toEqual(['agents']);
      await view.getByRole('tab', { name: /All machines/ }).click();
      await expect(view.getByRole('button', { name: 'Careful review on studio-pc: marked' })).toBeVisible();
      await view.screenshot({ path: 'test-results/machines-fleet.png' });
    } finally { await again.close(); }

    // On the other machine, syncing installs what was marked there, without creating an approval.
    const synced = studio('sync') as { location?: string; result: string }[];
    expect(synced.find(r => r.location === 'agents')?.result).toBe('installed approved revision');
    expect(fs.existsSync(path.join(studioHome, '.agents', 'skills', 'careful-review', 'SKILL.md'))).toBe(true);
  } finally { await app.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
});
