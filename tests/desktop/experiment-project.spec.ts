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
    // Tests opens the experiments grid; Run options… opens the full run dialog from there.
    await page.getByRole('button', { name: 'Open tests', exact: true }).click();
    await page.getByRole('button', { name: 'Run options…', exact: true }).click();
    const selector = page.getByLabel('Project / repository', { exact: true });
    await expect(selector).toHaveValue('');
    await selector.selectOption(project); await expect(selector).toHaveValue(project);
    await app.evaluate(({ dialog }, browsed) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [browsed] })) as typeof dialog.showOpenDialog; }, browsed);
    await page.getByRole('button', { name: 'Choose project folder…', exact: true }).click();
    await expect(selector).toHaveValue(browsed);
    // The grid's own run bar (open while nothing is tested) sits inert behind the modal; this is the dialog's handoff.
    await page.getByRole('dialog').getByRole('button', { name: 'Manual handoff instead', exact: true }).click();
    await expect(selector).toHaveValue(browsed);
    await page.getByLabel('Representative task', { exact: true }).fill('Review the entry point');
    await page.getByLabel('Evaluation rubric', { exact: true }).fill('Identify missing error handling');
    await page.getByRole('button', { name: 'Prepare trial', exact: false }).click();
    await expect(page.getByRole('dialog')).toContainText(browsed);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    // The prepared handoff sits in the grid's Manual column until its result is recorded.
    const grid = page.getByRole('region', { name: 'Experiments', exact: true });
    await expect(grid.getByRole('columnheader', { name: /Manual/ })).toBeVisible();
    await expect(grid.getByText('Waiting for result').first()).toBeVisible();
    await page.getByRole('button', { name: 'Run options…', exact: true }).click();
    await selector.selectOption(project);
    fs.rmdirSync(project);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
    await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('missing or unreadable');
    const jobs = await page.evaluate(() => (window as any).kiln.call('agent.jobs'));
    expect(jobs).toHaveLength(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the experiments grid runs from an inline bar with the project fixed by its column, and adds projects by folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-grid-ui-'));
  const project = path.join(root, 'my-game'); fs.mkdirSync(project);
  const browsed = path.join(root, 'orders-api'); fs.mkdirSync(browsed);
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'desktop') } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    await page.evaluate(async ({ project }) => {
      const api = (window as any).kiln.call;
      await api('targets.enroll', { name: 'my-game', root: project, provider: 'codex', scope: 'project' });
      await api('items.create', { title: 'Grid experiment fixture', kind: 'prompt', content: 'Review this repository.' });
    }, { project });
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await page.getByText('Grid experiment fixture', { exact: true }).first().click();
    // A prompt's primary action is Copy, so its tests open from the rail's Tests section.
    await page.getByRole('button', { name: 'Open tests', exact: true }).click();
    const grid = page.getByRole('region', { name: 'Experiments', exact: true });
    // With nothing tested yet the run bar is already open, with a project choice.
    await expect(grid.getByText('No experiments yet')).toBeVisible();
    const bar = grid.getByRole('region', { name: 'Run an experiment' });
    await expect(bar.getByLabel('Project', { exact: true })).toHaveValue('isolated');
    await app.evaluate(({ dialog }, browsed) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [browsed] })) as typeof dialog.showOpenDialog; }, browsed);
    await bar.getByRole('button', { name: 'Choose folder…', exact: true }).click();
    await expect(bar.getByLabel('Project', { exact: true })).toHaveValue(`path:${browsed}`);
    // A missing folder is rejected before anything runs, through the same start call as the dialog.
    fs.rmdirSync(browsed);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
    await bar.getByLabel('What should it try? (optional)').fill('Check the entry point');
    await bar.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(bar.getByRole('alert')).toContainText('missing or unreadable');
    expect(await page.evaluate(() => (window as any).kiln.call('agent.jobs'))).toHaveLength(0);
    // The bar's manual handoff prepares a disposable trial, which lands in the Manual column.
    await bar.getByRole('button', { name: 'Manual handoff instead', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Representative task', { exact: true }).fill('Disposable trial');
    await page.getByRole('dialog').getByLabel('Evaluation rubric', { exact: true }).fill('Observe output');
    await page.getByRole('button', { name: 'Prepare trial', exact: false }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(grid.getByRole('columnheader', { name: /Manual/ })).toBeVisible();
    // Add project… offers enrolled projects; picking one adds its column and arms the bar on that cell.
    await grid.getByRole('button', { name: 'Add project…' }).click();
    await page.getByRole('menuitem', { name: /my-game/ }).click();
    await expect(grid.getByRole('columnheader', { name: /my-game/ })).toBeVisible();
    await expect(grid.getByRole('region', { name: 'Run an experiment' })).toContainText('my-game');
    // The prepared handoff is selected: its panel records a result and deletes the experiment.
    await grid.getByRole('button', { name: /on Manual: waiting for result/ }).click();
    await expect(grid.getByRole('button', { name: 'Record result', exact: true })).toBeVisible();
    await grid.getByRole('button', { name: 'Delete experiment', exact: true }).click();
    await expect(grid.getByText('No experiments yet')).toBeVisible();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
