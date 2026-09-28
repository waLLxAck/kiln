import { test, expect, _electron as electron, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

/** The text in a CodeMirror editor, line by line: it is a contenteditable, so it has no value. */
const text = (editor: Locator) => editor.evaluate(node => Array.from(node.querySelectorAll('.cm-line'), line => line.textContent).join('\n'));

test('config editor creates settings, edits permissions and hooks, rejects bad JSON, restores backups and finds project hooks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-config-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const project = path.join(root, 'project'); fs.mkdirSync(path.join(project, '.github', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(project, '.github', 'hooks', 'session.json'), '{"version":1,"hooks":{}}');
  const app = await electron.launch({ ...(process.env.KILN_CONFIG_EXE ? { executablePath: process.env.KILN_CONFIG_EXE } : { args: ['.'] }), env: { ...desktopEnv(root), KILN_HOME: home } });
  const page = await app.firstWindow();
  try {
    await page.getByRole('button', { name: 'Config files', exact: true }).click();
    const settingsFile = path.join(home, '.claude', 'settings.json');
    // A missing file sits under "N not created"; filtering opens that list.
    await page.getByLabel('Filter config files').fill('claude settings.json');
    await page.locator('.cfg-file').filter({ hasText: /^settings\.json/ }).first().click();
    await page.getByRole('button', { name: 'Create from template', exact: true }).click();
    await expect.poll(() => fs.existsSync(settingsFile) && fs.readFileSync(settingsFile, 'utf8')).toBe('{}\n');
    // Permissions: add a rule in a column, with format and duplicate checks, then save.
    await expect(page.getByRole('tab', { name: /Permissions/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Add Deny rule').fill('npm test');
    await page.getByLabel('Add Deny rule').press('Enter');
    await expect(page.getByText(/Use Tool or Tool\(pattern\)/)).toBeVisible();
    await page.getByLabel('Add Deny rule').fill('Read(.env)');
    await page.getByLabel('Add Deny rule').press('Enter');
    await expect(page.getByText('1 change', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual({ permissions: { deny: ['Read(.env)'] } });
    await page.getByLabel('Add Allow rule').fill('Read(.env)');
    await page.getByLabel('Add Allow rule').press('Enter');
    await expect(page.getByText('Already in Deny')).toBeVisible();
    await page.getByLabel('Add Allow rule').fill('');
    // Hooks: add a row; it lands in the same JSON.
    await page.getByRole('tab', { name: /Hooks/ }).click();
    await page.getByLabel('New hook event').fill('Stop');
    await page.getByLabel('New hook command').fill('echo done');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'echo done' })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] });
    // Raw: broken JSON turns the structured tabs off and is refused on save.
    await page.getByRole('tab', { name: 'Raw', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'settings.json content', exact: true });
    await expect(editor).toHaveClass(/cm-content/);
    await expect.poll(() => text(editor)).toContain('"Read(.env)"');
    await editor.fill('{broken');
    await expect(page.getByRole('tab', { name: /Permissions/ })).toBeDisabled();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(/Configuration was not saved/)).toBeVisible();
    expect(fs.readFileSync(settingsFile, 'utf8')).toContain('Read(.env)');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    // A chip's menu moves a rule to another column.
    await page.getByRole('tab', { name: /Permissions/ }).click();
    await page.getByRole('button', { name: 'Read(.env), Deny rule' }).click();
    await page.getByRole('menuitem', { name: 'Move to Ask' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).permissions).toEqual({ deny: [], ask: ['Read(.env)'] });
    // The backups menu restores the first version, the template.
    await page.getByRole('button', { name: /3 backups/ }).click();
    await page.locator('.cfg-backup').last().getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('tab', { name: 'Raw', exact: true }).click();
    await expect.poll(() => text(editor)).toBe('{}\n');
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
    await page.getByRole('button', { name: 'Add project folder', exact: true }).click();
    await page.getByLabel('Filter config files').fill('session.json');
    await page.locator('.cfg-file').filter({ hasText: 'session.json' }).click();
    await expect.poll(() => text(page.getByRole('textbox', { name: 'session.json content' }))).toBe('{"version":1,"hooks":{}}');
    await expect(page.getByRole('button', { name: 'Copy to library', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/config-files.png' });
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
