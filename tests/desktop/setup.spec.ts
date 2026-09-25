import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readyLibrary } from './fixture';

test('a library without a GitHub repository lands on setup; connecting a Kiln repository opens the workbench', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-setup-'));
  const plain = path.join(root, 'plain library');
  const app = await electron.launch({ ...(process.env.KILN_SETUP_EXE ? { executablePath: process.env.KILN_SETUP_EXE } : { args: ['.'] }), env: { ...process.env, KILN_LIBRARY: plain, KILN_LOCAL: path.join(root, 'private'), KILN_PLAIN_COMMITS: '1' } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Set up your Kiln repository' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your Kiln repository', exact: true })).toBeVisible();
    // The workbench itself is not reachable until a repository is connected.
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    const snapshot = await page.evaluate(async () => await (window as any).kiln.call('snapshot', {}));
    expect(snapshot.repository).toEqual({ standard: false, dedicated: false, git: false, remote: false, ready: false });

    const github = await page.evaluate(() => window.kiln.call<{ authenticated: boolean }>('github.status'));
    if (github.authenticated) {
      const found = await page.evaluate(() => window.kiln.call<{ dedicated: boolean; repo: { nameWithOwner: string } } | null>('github.defaultRepository'));
      if (found?.dedicated) {
        await expect(page.getByText('Your Kiln repository was found')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Use this repository', exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Create new' })).toHaveCount(0);
        await page.screenshot({ path: 'artifacts/setup-existing-repository.png' });
        await page.getByRole('button', { name: 'Use something else' }).click();
        await expect(page.getByRole('tab', { name: 'Create new' })).toBeVisible();
        await expect(page.getByLabel('Repository name', { exact: true })).toHaveValue('my-kiln-2');
      }
    }

    // Attaching a ready repository (what "Open a folder here" does after the native picker) makes Kiln usable.
    const library = readyLibrary(root);
    await page.evaluate(async root => { await (window as any).kiln.call('desktop.attach', { root }); }, library);
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await expect(page.getByRole('heading', { name: 'Kiln repository' })).toBeVisible();
    // The fixture's initial commit was never pushed; the card says so and Push now sends it.
    await expect(page.getByText('1 commit not on GitHub yet')).toBeVisible();
    await page.getByRole('button', { name: 'Push now' }).click();
    await expect(page.getByText('up to date with GitHub')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect a different repository…' })).toBeVisible();
    await page.getByRole('button', { name: 'Connect a different repository…' }).click();
    await expect(page.getByRole('heading', { name: 'Your Kiln repository is ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Start using Kiln' }).click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
