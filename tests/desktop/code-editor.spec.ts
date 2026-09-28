import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

const content = '---\nname: code-editor-skill\ndescription: Use when testing the code editor.\n---\n\n# Code editor\n\nRead [the guide](references/guide.md).\n';
const guide = 'Guide\r\nline two\r\n';
const logo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString('base64');
const read = (page: Page, id: string) => page.evaluate(async id => (window as any).kiln.call('items.read', { id }), id) as Promise<{ item: { revision: string; title: string; tags: string[]; collection: string; licence: string }; revision: { content: string; files: Record<string, string>; summary: string } }>;
const open = (page: Page, id: string) => page.evaluate(id => { location.hash = `item=${id}`; }, id);
const row = (page: Page, title: string) => page.locator('.item-card').filter({ hasText: title });
/** The text in a CodeMirror editor, line by line (it is a contenteditable, not a textarea). */
const text = (editor: Locator) => editor.evaluate(node => Array.from(node.querySelectorAll('.cm-line'), line => line.textContent).join('\n'));

test('item editor: CodeMirror with live checks, Ctrl+F/H/S, bundled text files, fields in the private draft, Discard asks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-code-editor-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_HOME: home, KILN_DESKTOP_DATA: path.join(root, 'profile') } });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    const skill = await page.evaluate(async ({ content, guide, logo }) => (window as any).kiln.call('items.create', { kind: 'skill', title: 'Code editor skill', content, collection: 'Personal', tags: [], source: '', licence: 'Personal', files: { 'references/guide.md': btoa(guide), 'assets/logo.png': logo } }), { content, guide, logo }) as { id: string };
    const other = await page.evaluate(async () => (window as any).kiln.call('items.create', { kind: 'prompt', title: 'Other prompt', content: 'Plain prompt.', collection: 'Personal', tags: [], source: '', licence: 'Personal', files: {} })) as { id: string };
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    await row(page, 'Code editor skill').click();
    await page.getByRole('button', { name: 'Edit text', exact: true }).click();

    // Content is a CodeMirror editor in place, under the one save bar.
    const form = page.getByRole('form', { name: 'Edit SKILL.md' });
    const editor = form.getByRole('textbox', { name: 'Content', exact: true });
    await expect(editor).toHaveClass(/cm-content/);
    await expect(form.locator('textarea')).toHaveCount(0);
    await expect(form.locator('.item-code .cm-lineNumbers')).toBeVisible();
    await expect(form.getByText('SKILL.md checks pass')).toBeVisible();
    // Opening the editor without changing anything is not an unsaved draft; Done closes it.
    await expect(form.getByText('Unsaved changes')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Done' })).toBeVisible();
    expect(await page.evaluate(id => localStorage.getItem(`kiln-draft:${id}`), skill.id)).toBeNull();

    // A bad name shows a live frontmatter problem with its line before saving; fixing it clears the problem.
    await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End');
    await page.keyboard.type(' Bad');
    const problems = form.locator('.code-diagnostics');
    await expect(problems).toContainText('Needs attention before approval');
    await expect(problems).toContainText('Skill name must be lowercase words separated by hyphens');
    await expect(problems.getByRole('button', { name: 'Line 2' })).toBeVisible();
    await expect(form.locator('.item-code .cm-kiln-problem')).toHaveCount(1);
    await expect(form.getByText('Unsaved changes')).toBeVisible();
    await page.screenshot({ path: 'test-results/code-editor-item.png' });
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await expect(problems).toHaveCount(0);
    await expect(form.getByText('SKILL.md checks pass')).toBeVisible();

    // Inside the editor Ctrl+F is CodeMirror's find: the item stays open instead of going to the library's query bar.
    await page.keyboard.press('Control+f');
    await expect(form.locator('.item-code .cm-search')).toBeVisible();
    await expect(form.locator('.item-code .cm-search input[name=search]')).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Code editor skill', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search library' })).toHaveCount(0);
    await page.keyboard.press('Control+h');
    await expect(form.locator('.item-code .cm-search input[name=replace]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(form.locator('.item-code .cm-search')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Code editor skill', exact: true })).toBeVisible();

    await editor.click(); await page.keyboard.press('Control+End');
    await page.keyboard.type('Edited in CodeMirror.');

    // Files: text files open in the editor under their row; the PNG stays as it is; new text files join the draft.
    const files = page.getByRole('region', { name: 'Files' });
    const logoRow = files.locator('.bundled-entry').filter({ hasText: 'assets/logo.png' });
    await expect(logoRow).toContainText('kept as it is');
    await expect(logoRow.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    await expect(files.getByRole('button', { name: 'Remove', exact: true }).first()).toBeDisabled();
    await files.getByRole('button', { name: 'Edit references/guide.md' }).click();
    const file = page.getByRole('textbox', { name: 'references/guide.md content' });
    await file.click(); await page.keyboard.press('Control+End');
    await page.keyboard.type('More guidance.');
    await expect(files.locator('.bundled-entry').filter({ hasText: 'references/guide.md' })).toContainText('edited');
    await files.getByRole('button', { name: 'Add a file' }).click();
    await files.getByLabel('Relative path').fill('../escape.md');
    await files.getByRole('button', { name: 'New text file' }).click();
    await expect(files.getByRole('alert')).toContainText('Use a relative path');
    await expect(files.getByRole('button', { name: 'Choose file…' })).toBeDisabled();
    await files.getByLabel('Relative path').fill('references/extra.md');
    await files.getByRole('button', { name: 'New text file' }).click();
    await expect(page.getByRole('textbox', { name: 'references/extra.md content' })).toBeFocused();
    await page.keyboard.type('Extra notes.');
    await expect(files.locator('.bundled-entry').filter({ hasText: 'references/extra.md' })).toContainText('new');
    await page.screenshot({ path: 'test-results/code-editor-files.png' });

    // Ctrl+S in a file's editor saves everything as one revision.
    const before = (await read(page, skill.id)).item.revision;
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await read(page, skill.id)).item.revision).not.toBe(before);
    const saved = await read(page, skill.id);
    expect(saved.revision.content).toBe(content + 'Edited in CodeMirror.');
    expect(Buffer.from(saved.revision.files['references/guide.md'], 'base64').toString()).toBe(guide + 'More guidance.');
    expect(Buffer.from(saved.revision.files['references/extra.md'], 'base64').toString()).toBe('Extra notes.');
    expect(saved.revision.files['assets/logo.png']).toBe(logo);
    await expect(page.locator('.item-editor')).toHaveCount(0);
    expect(await page.evaluate(id => localStorage.getItem(`kiln-draft:${id}`), skill.id)).toBeNull();

    // Every field is kept in the private draft and comes back after switching items; the library marks the draft.
    await page.getByRole('button', { name: 'Edit text', exact: true }).click();
    await form.getByLabel('Title', { exact: true }).fill('Renamed in the draft');
    await form.getByLabel('Tags', { exact: true }).fill('alpha, beta');
    await form.getByLabel('Collection', { exact: true }).fill('Work');
    await form.getByLabel('Source', { exact: true }).fill('https://example.com/skill');
    await form.getByLabel('Licence', { exact: true }).fill('MIT');
    await form.getByLabel('What changed? (optional)').fill('Renamed');
    // The rail's organisation waits for the editor meanwhile.
    await expect(page.getByRole('complementary', { name: 'Item status and organisation' }).getByLabel('Collection')).toBeDisabled();
    await open(page, other.id);
    await expect(page.getByRole('heading', { name: 'Other prompt', exact: true })).toBeVisible();
    await page.locator('.item-bar-back').click();
    await expect(row(page, 'Code editor skill').locator('.lib-draft')).toBeVisible();
    await expect(row(page, 'Other prompt').locator('.lib-draft')).toHaveCount(0);
    await row(page, 'Code editor skill').click();
    await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Renamed in the draft');
    await expect(form.getByLabel('Tags', { exact: true })).toHaveValue('alpha, beta');
    await expect(form.getByLabel('Collection', { exact: true })).toHaveValue('Work');
    await expect(form.getByLabel('Licence', { exact: true })).toHaveValue('MIT');

    // Discard asks first; Keep editing keeps everything.
    await form.getByRole('button', { name: 'Discard local draft' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Discard your local draft?');
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(form.getByLabel('Title', { exact: true })).toHaveValue('Renamed in the draft');
    await form.getByRole('button', { name: 'Discard local draft' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard draft' }).click();
    await expect(page.locator('.item-editor')).toHaveCount(0);
    expect(await page.evaluate(id => localStorage.getItem(`kiln-draft:${id}`), skill.id)).toBeNull();
    expect((await read(page, skill.id)).item.title).toBe('Code editor skill');

    // Saving the fields: one revision with the new title, tags, source and licence, and the item moved to Work.
    await page.getByRole('button', { name: 'Edit text', exact: true }).click();
    await form.getByLabel('Title', { exact: true }).fill('Renamed skill');
    await form.getByLabel('Tags', { exact: true }).fill('alpha, beta');
    await form.getByLabel('Collection', { exact: true }).fill('Work');
    await form.getByLabel('Licence', { exact: true }).fill('MIT');
    await form.getByRole('button', { name: 'Save revision' }).click();
    await expect.poll(async () => (await read(page, skill.id)).item.title).toBe('Renamed skill');
    const renamed = await read(page, skill.id);
    expect(renamed.item.tags).toEqual(['alpha', 'beta']);
    expect(renamed.item.collection).toBe('Work');
    expect(renamed.item.licence).toBe('MIT');
    await page.locator('.item-bar-back').click();
    await expect(row(page, 'Renamed skill').locator('.lib-draft')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('config files: the plain editor and Raw are CodeMirror, Ctrl+F finds inside and Ctrl+S saves', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-code-editor-config-'));
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Instructions\n\nBe brief.\n');
  const app = await electron.launch({ args: ['.'], env: { ...desktopEnv(root), KILN_HOME: home, KILN_DESKTOP_DATA: path.join(root, 'profile') } });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('button', { name: 'Config files', exact: true }).click();
    // A Markdown instruction file: the plain editor.
    await page.getByLabel('Filter config files').fill('claude CLAUDE.md');
    await page.locator('.cfg-file').filter({ hasText: /^CLAUDE\.md/ }).first().click();
    const markdown = page.getByRole('textbox', { name: 'CLAUDE.md content', exact: true });
    await expect(markdown).toHaveClass(/cm-content/);
    await expect(page.locator('.cfg-main textarea')).toHaveCount(0);
    await markdown.click();
    await page.keyboard.press('Control+f');
    await expect(page.locator('.home-code .cm-search input[name=search]')).toBeFocused();
    await page.keyboard.press('Escape');
    await markdown.click(); await page.keyboard.press('Control+End');
    await page.keyboard.type('Cite sources.\n');
    await expect(page.getByText('1 change', { exact: true })).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe('# Instructions\n\nBe brief.\nCite sources.\n');
    await expect(page.getByText('1 change', { exact: true })).toHaveCount(0);

    // Claude settings: Raw is CodeMirror too, and Ctrl+S saves from it.
    await page.getByLabel('Filter config files').fill('claude settings.json');
    await page.locator('.cfg-file').filter({ hasText: /^settings\.json/ }).first().click();
    await page.getByRole('button', { name: 'Create from template', exact: true }).click();
    await page.getByRole('tab', { name: 'Raw', exact: true }).click();
    const config = page.getByRole('textbox', { name: 'settings.json content', exact: true });
    await expect(config).toHaveClass(/cm-content/);
    await expect.poll(() => text(config)).toBe('{}\n');
    await config.click(); await page.keyboard.press('Control+a');
    await page.keyboard.type('{"hooks":{}}');
    await expect(page.getByText('1 change', { exact: true })).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    await page.screenshot({ path: 'test-results/code-editor-config.png' });
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
