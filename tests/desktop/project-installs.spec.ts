import { test, expect, _electron as electron, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

// Install into project folders: one project dialog, opened from the item rail's Installs section and from Machines' Add project….
const skill = `---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff.\n`;
const api = <T,>(page: Page, method: string, args?: unknown) => page.evaluate(([m, a]) => (window as any).kiln.call(m, a), [method, args] as const) as Promise<T>;
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();

test('install into a chosen project from the rail, see it under Projects and as a Machines column, update, remove, forget, add it back from Machines, and test in it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-project-installs-'));
  const project = path.join(root, 'Web app'); fs.mkdirSync(project);
  const configured = path.join(root, 'Config project'); fs.mkdirSync(configured);
  const copy = path.join(project, '.claude', 'skills', 'careful-review', 'SKILL.md');
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    const item = await api<{ id: string; revision: string }>(page, 'items.create', { title: 'Careful review', kind: 'skill', content: skill });
    await api(page, 'home.addProject', { path: configured });
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await page.getByText('Careful review', { exact: true }).first().click();
    const installs = page.getByRole('region', { name: 'Installs', exact: true });
    await expect(installs.getByRole('heading', { name: 'Projects' })).toHaveCount(0);
    // Install into project… is the rail's; the ⋯ menu doesn't repeat it.
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /Install into (a )?project/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog; }, project);
    await installs.getByRole('button', { name: 'Install into project…' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Install into project' })).toBeVisible();
    const choices = dialog.getByRole('radiogroup', { name: 'Project' });
    await expect(choices.getByText('Config project', { exact: true })).toBeVisible();
    await expect(choices.getByText('Known from config files')).toBeVisible();
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(choices.getByRole('radio', { name: /Web app/ })).toBeChecked();
    await dialog.getByRole('radiogroup', { name: 'Location' }).getByRole('radio', { name: /Claude/ }).check();
    const preview = dialog.getByLabel('Preview', { exact: true });
    await expect(preview).toContainText(path.join(project, '.claude', 'skills', 'careful-review'));
    await expect(preview).toContainText('Nothing is there yet');
    await expect(preview).toContainText('adds this folder to your projects as “Web app”');
    await expect(preview).toContainText('not approved yet');
    await page.screenshot({ path: 'test-results/project-installs-dialog.png' });
    await dialog.getByRole('button', { name: 'Install', exact: true }).click();
    const toast = page.locator('.toast');
    await expect(toast).toContainText('Careful review: installed in Web app (Claude). Web app is now one of your projects.');
    expect(fs.readFileSync(copy, 'utf8')).toBe(skill);

    // The copy is listed under Projects in the rail, with one action.
    const row = installs.locator('.rail-item').filter({ hasText: 'Web app · Claude' });
    await expect(installs.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(row).toContainText('installed by Kiln');
    await expect(row.getByRole('button', { name: 'Remove' })).toBeVisible();
    await page.screenshot({ path: 'test-results/project-installs-rail.png' });

    // In Machines the project is this machine's column (location key project:Web app:claude).
    await nav(page, 'Machines');
    await expect(page.getByRole('columnheader', { name: /Web app · Claude/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Careful review in Web app · Claude: Installed' })).toBeVisible();

    // A newer approved revision: the project copy is outdated in the rail and in Machines, and Update comes from its row.
    await nav(page, 'Library');
    await page.getByText('Careful review', { exact: true }).first().click();
    const detail = await api<any>(page, 'items.read', { id: item.id });
    const next = await api<{ revision: string }>(page, 'items.update', { id: item.id, expect: detail.item.revision, summary: 'Version two', value: { ...detail.revision, collection: detail.item.collection, content: skill + 'Check the tests.\n' } });
    await api(page, 'approvals.approve', { id: item.id, revision: next.revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' });
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await expect(installs.getByRole('button', { name: /^Installs/ })).toContainText('1 update available');
    await nav(page, 'Machines');
    await expect(page.getByRole('button', { name: 'Careful review in Web app · Claude: Outdated' })).toBeVisible();
    await nav(page, 'Library');
    await page.getByText('Careful review', { exact: true }).first().click();
    await expect(row).toContainText('update available');
    await expect(page.getByRole('button', { name: 'Update installs (1)' })).toBeVisible();
    await row.getByRole('button', { name: 'Update' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Update available in Web app · Claude' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(toast).toContainText('Careful review: Updated Web app to revision');
    expect(fs.readFileSync(copy, 'utf8')).toBe(skill + 'Check the tests.\n');
    await expect(row).toContainText('installed by Kiln');

    // Forget refuses while Kiln's copy is there.
    await installs.getByRole('button', { name: 'Install into project…' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radiogroup', { name: 'Project' }).locator('.project-choice').filter({ hasText: 'Web app' })).toContainText('1 Kiln copy');
    await dialog.getByRole('button', { name: 'Forget Web app' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Kiln still manages a copy in this folder (Careful review)');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Remove goes through the same dialog as personal copies.
    await row.getByRole('button', { name: 'Remove' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Remove from Web app · Claude' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(toast).toContainText('removed from Web app · Claude');
    expect(fs.existsSync(copy)).toBe(false);
    await expect(installs.getByRole('heading', { name: 'Projects' })).toHaveCount(0);

    // The project installed into, and the Config files project, are offered for experiments.
    await page.getByRole('button', { name: 'Open tests', exact: true }).click();
    await page.getByRole('button', { name: 'Run options…' }).click();
    dialog = page.getByRole('dialog', { name: 'Run an experiment' });
    const selector = dialog.getByLabel('Project / repository', { exact: true });
    await expect(selector.locator('option', { hasText: project })).toHaveCount(1);
    await expect(selector.locator('option', { hasText: configured })).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Content', exact: true }).click();

    // With no copies left the project can be forgotten; the folder itself is untouched.
    await installs.getByRole('button', { name: 'Install into project…' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Forget Web app' }).click();
    await expect(dialog.getByRole('radiogroup', { name: 'Project' }).getByText('Web app', { exact: true })).toHaveCount(0);
    expect(fs.existsSync(project)).toBe(true);
    expect(await api<any[]>(page, 'targets.list')).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Machines' Add project… is the same dialog without an item: it adds the folder for a location and writes nothing into it.
    // (Removing the copy above left the empty .claude/skills folders it was in; adding must not change anything.)
    const contents = () => fs.readdirSync(project, { recursive: true }).map(String).sort();
    const before = contents();
    await nav(page, 'Machines');
    await page.getByRole('button', { name: 'Add project…' }).first().click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add project' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(dialog.getByRole('radiogroup', { name: 'Project' }).getByRole('radio', { name: /Web app/ })).toBeChecked();
    await expect(dialog.getByLabel('Preview', { exact: true })).toContainText('Nothing is written into it until you install something');
    await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
    await expect(toast).toContainText('Web app is now one of your projects (Agents)');
    await expect(page.getByRole('button', { name: 'Careful review in Web app: Not installed' })).toBeVisible();
    expect(contents()).toEqual(before);
    expect(contents().some(name => name.includes('careful-review'))).toBe(false);
    await page.getByRole('button', { name: 'Add project…' }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('radiogroup', { name: 'Project' }).getByRole('radio', { name: /Web app/ }).check();
    await expect(dialog.getByRole('button', { name: 'Already added' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
