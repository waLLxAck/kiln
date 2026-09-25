import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

test('experiments offer enrolled projects and browsing, preserve manual selection, and reject a missing project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-project-ui-'));
  const project = path.join(root, 'Project one'); fs.mkdirSync(project);
  const browsed = path.join(root, 'Browsed repository'); fs.mkdirSync(browsed);
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'desktop') } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    await page.evaluate(async ({ project }) => {
      const api = (window as any).kiln.call;
      await api('targets.enroll', { name: 'Project one', root: project, provider: 'codex', scope: 'project' });
      await api('items.create', { title: 'Project experiment fixture', kind: 'prompt', content: 'Review this repository.' });
    }, { project });
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await page.getByText('Project experiment fixture', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    const selector = page.getByLabel('Project / repository', { exact: true });
    await expect(selector).toHaveValue('');
    await selector.selectOption(project); await expect(selector).toHaveValue(project);
    await app.evaluate(({ dialog }, browsed) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [browsed] })) as typeof dialog.showOpenDialog; }, browsed);
    await page.getByRole('button', { name: 'Choose project folder…', exact: true }).click();
    await expect(selector).toHaveValue(browsed);
    await page.getByRole('button', { name: 'Manual handoff instead', exact: true }).click();
    await expect(selector).toHaveValue(browsed);
    await page.getByLabel('Representative task', { exact: true }).fill('Review the entry point');
    await page.getByLabel('Evaluation rubric', { exact: true }).fill('Identify missing error handling');
    await page.getByRole('button', { name: 'Prepare trial', exact: false }).click();
    await expect(page.getByRole('dialog')).toContainText(browsed);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await selector.selectOption(project);
    fs.rmdirSync(project);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
    await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('missing or unreadable');
    const jobs = await page.evaluate(() => (window as any).kiln.call('agent.jobs'));
    expect(jobs).toHaveLength(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
