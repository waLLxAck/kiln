import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { desktopDefines } from '../../apps/desktop/build-flags';
import { desktopEnv } from './fixture';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
async function openSkillInstalls(page: Page) {
  await page.evaluate(() => window.kiln.call('items.create', { kind: 'skill', title: 'review', content: '---\nname: review\ndescription: Review a change\n---\nRead the diff.', collection: 'Personal' }));
  await page.getByRole('button', { name: 'Refresh library' }).click();
  await page.locator('.item-card', { hasText: 'review' }).click();
  await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'installs', exact: true }).click();
}

test('development builds keep the full Machines section', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-machines-dev-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await nav(page).getByRole('button', { name: 'Machines' }).click();
    await expect(page.getByRole('heading', { name: 'This machine' })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: 'This machine' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Recover interrupted local installs' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await nav(page).getByRole('button', { name: 'Library', exact: true }).click();
    await openSkillInstalls(page);
    await expect(page.getByRole('button', { name: 'Install a specific revision…' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Selected item' }).getByText(/Machines/)).toHaveCount(0);
    await expect(page.getByText('Check live drift in Machines')).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
