import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

// Experimental projectInstalls ("Install into project folders").
const skill = `---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff.\n`;

test('install into a chosen project folder, see it under Projects, remove it, forget the project, and share projects with the Test dialog', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-project-installs-'));
  const project = path.join(root, 'Web app'); fs.mkdirSync(project);
  const configured = path.join(root, 'Config project'); fs.mkdirSync(configured);
  const copy = path.join(project, '.claude', 'skills', 'careful-review', 'SKILL.md');
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_EXPERIMENTS: 'projectInstalls' } });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('tab', { name: /^All/ })).toBeVisible();
    await page.evaluate(async ({ skill, configured }) => {
      await window.kiln.call('items.create', { title: 'Careful review', kind: 'skill', content: skill });
      await window.kiln.call('home.addProject', { path: configured });
    }, { skill, configured });
    await page.reload();
    await page.getByRole('tab', { name: /^Skills/ }).click();
    await page.locator('.item-card').filter({ hasText: 'Careful review' }).click();
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'installs', exact: true }).click();
    const projects = page.locator('.project-copies');
    await expect(projects.getByText('Not installed in any project yet.')).toBeVisible();

    // The header's More menu offers it too; the Installs tab button opens the same dialog.
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog; }, project);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Install into project…' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Install into project' })).toBeVisible();
    const choices = dialog.getByRole('radiogroup', { name: 'Project' });
    await expect(choices.getByText('Config project', { exact: true })).toBeVisible();
    await expect(choices.getByText('Known from config files')).toBeVisible();
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(choices.getByRole('radio', { name: /Web app/ })).toBeChecked();
    await dialog.getByRole('radiogroup', { name: 'Location' }).getByRole('radio', { name: /Claude/ }).check();
    const preview = dialog.getByLabel('Preview');
    await expect(preview).toContainText(path.join(project, '.claude', 'skills', 'careful-review'));
    await expect(preview).toContainText('Nothing is there yet');
    await expect(preview).toContainText('adds this folder to your projects as “Web app”');
    await expect(preview).toContainText('not approved yet');
    await page.screenshot({ path: 'test-results/project-installs-dialog.png' });
    await dialog.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Careful review: installed in Web app (Claude). Web app is now one of your projects.');
    expect(fs.readFileSync(copy, 'utf8')).toBe(skill);

    // The copy is grouped under Projects, not with the personal copies.
    const group = projects.locator('.project-group').filter({ hasText: 'Web app' });
    await expect(group.locator('.installation-row')).toContainText('Claude');
    await expect(group.locator('.installation-row .badge')).toHaveText('installed');
    await expect(page.locator('.content-section').filter({ hasText: 'Where this skill is installed' }).locator('.installation-row')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/project-installs-tab.png' });

    // Forget refuses while Kiln's copy is there.
    await projects.getByRole('button', { name: 'Install into project…' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radiogroup', { name: 'Project' }).getByText('1 Kiln copy')).toBeVisible();
    await dialog.getByRole('button', { name: 'Forget Web app' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Kiln still manages a copy in this folder (Careful review)');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Remove goes through the same dialog as personal copies.
    await group.getByRole('button', { name: 'Remove' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Remove from Web app · Claude' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('removed from Web app · Claude');
    expect(fs.existsSync(copy)).toBe(false);
    await expect(projects.getByText('Not installed in any project yet.')).toBeVisible();

    // The project installed into, and the Config files project, are offered for experiments.
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    dialog = page.getByRole('dialog');
    const selector = dialog.getByLabel('Project / repository', { exact: true });
    await expect(selector.locator('option', { hasText: project })).toHaveCount(1);
    await expect(selector.locator('option', { hasText: configured })).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close dialog' }).click();

    // With no copies left the project can be forgotten; the folder itself is untouched.
    await projects.getByRole('button', { name: 'Install into project…' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Forget Web app' }).click();
    await expect(dialog.getByRole('radiogroup', { name: 'Project' }).getByText('Web app', { exact: true })).toHaveCount(0);
    expect(fs.existsSync(project)).toBe(true);
    expect(await page.evaluate(() => window.kiln.call<any[]>('targets.list'))).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('with the flag off there is no Install into project and the Test dialog lists enrolled projects only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-project-installs-off-'));
  const configured = path.join(root, 'Config project'); fs.mkdirSync(configured);
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('tab', { name: /^All/ })).toBeVisible();
    await page.evaluate(async ({ skill, configured }) => {
      await window.kiln.call('items.create', { title: 'Careful review', kind: 'skill', content: skill });
      await window.kiln.call('home.addProject', { path: configured });
    }, { skill, configured });
    await page.reload();
    await page.getByRole('tab', { name: /^Skills/ }).click();
    await page.locator('.item-card').filter({ hasText: 'Careful review' }).click();
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'installs', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Install receipts' })).toBeVisible();
    await expect(page.locator('.project-copies')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Install into project…' })).toHaveCount(0);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Install into a project folder…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Install into project…' })).toHaveCount(0);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    const selector = page.getByRole('dialog').getByLabel('Project / repository', { exact: true });
    await expect(selector.locator('option')).toHaveCount(1);
    await expect(page.getByRole('dialog').getByRole('radiogroup')).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
