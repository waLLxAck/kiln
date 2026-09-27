import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
const content = '---\nname: code-editor-skill\ndescription: Use when testing the code editor.\n---\n\n# Code editor\n\nRead [the guide](references/guide.md).\n';
const guide = 'Guide\r\nline two\r\n';
const logo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString('base64');
const read = (page: Page, id: string) => page.evaluate(async id => (window as any).kiln.call('items.read', { id }), id) as Promise<{ item: { revision: string; title: string }; revision: { content: string; files: Record<string, string> } }>;
const row = (page: Page, title: string) => page.locator('.item-card').filter({ hasText: title });

test('code editor: CodeMirror for items and config files, live checks, Ctrl+S, bundled files and kept drafts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-code-editor-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const env = { ...desktopEnv(root), KILN_HOME: home, KILN_DESKTOP_DATA: path.join(root, 'profile'), KILN_EXPERIMENTS: 'codeEditor' };
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.locator('.item-list').waitFor();
    const skill = await page.evaluate(async ({ content, guide, logo }) => (window as any).kiln.call('items.create', { kind: 'skill', title: 'Code editor skill', content, collection: 'Personal', tags: [], source: '', licence: 'Personal', files: { 'references/guide.md': btoa(guide), 'assets/logo.png': logo } }), { content, guide, logo }) as { id: string };
    await page.evaluate(async () => (window as any).kiln.call('items.create', { kind: 'prompt', title: 'Other prompt', content: 'Plain prompt.', collection: 'Personal', tags: [], source: '', licence: 'Personal', files: {} }));
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await row(page, 'Code editor skill').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    // Content is a CodeMirror editor, not a textarea.
    const editor = page.getByRole('textbox', { name: 'Content', exact: true });
    await expect(editor).toHaveClass(/cm-content/);
    await expect(page.locator('.item-code-form textarea')).toHaveCount(0);
    await expect(page.locator('.item-code .cm-lineNumbers')).toBeVisible();
    await expect(page.getByText('SKILL.md checks pass')).toBeVisible();
    // Opening the editor without changing anything is not an unsaved draft.
    await expect(page.getByText('unsaved changes')).toHaveCount(0);

    // A bad name shows a live frontmatter warning with its line before saving; fixing it clears the warning.
    await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End');
    await page.keyboard.type(' Bad');
    const problems = page.locator('.code-diagnostics');
    await expect(problems).toContainText('Skill name must be lowercase words separated by hyphens');
    await expect(problems.getByRole('button', { name: 'Line 2' })).toBeVisible();
    await expect(page.locator('.item-code .cm-kiln-problem')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/code-editor-item.png' });
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await expect(problems).toHaveCount(0);
    await expect(page.getByText('SKILL.md checks pass')).toBeVisible();

    // Ctrl+F opens CodeMirror's find inside the editor and leaves library search alone; Ctrl+H goes to replace.
    await page.keyboard.press('Control+f');
    await expect(page.locator('.item-code .cm-search')).toBeVisible();
    await expect(page.locator('.item-code .cm-search input[name=search]')).toBeFocused();
    await expect(page.getByLabel('Search library')).not.toBeFocused();
    await page.keyboard.press('Control+h');
    await expect(page.locator('.item-code .cm-search input[name=replace]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.item-code .cm-search')).toHaveCount(0);

    await editor.click(); await page.keyboard.press('Control+End');
    await page.keyboard.type('Edited in CodeMirror.');

    // Bundled text files open in the editor; the PNG stays binary and untouched.
    const bundled = page.getByRole('region', { name: 'Bundled files in this draft' });
    await expect(bundled.getByRole('button', { name: /assets\/logo\.png/ })).toBeDisabled();
    await bundled.getByRole('button', { name: /references\/guide\.md/ }).click();
    const file = page.getByRole('textbox', { name: 'references/guide.md content' });
    await file.click(); await page.keyboard.press('Control+End');
    await page.keyboard.type('More guidance.');
    await expect(bundled.getByRole('button', { name: /references\/guide\.md/ })).toContainText('edited');
    const before = (await read(page, skill.id)).item.revision;
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await read(page, skill.id)).item.revision).not.toBe(before);
    const saved = await read(page, skill.id);
    expect(saved.revision.content).toBe(content + 'Edited in CodeMirror.');
    expect(Buffer.from(saved.revision.files['references/guide.md'], 'base64').toString()).toBe(guide + 'More guidance.');
    expect(saved.revision.files['assets/logo.png']).toBe(logo);
    await expect(page.locator('.item-code-form')).toHaveCount(0);
    expect(await page.evaluate(id => localStorage.getItem(`kiln-draft:${id}`), skill.id)).toBeNull();

    // Metadata edits are kept in the private draft and come back after switching items; the list marks the draft.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Renamed in the draft');
    await page.getByLabel('Tags', { exact: true }).fill('alpha, beta');
    await page.getByLabel('Licence', { exact: true }).fill('MIT');
    await row(page, 'Other prompt').click();
    await expect(page.getByRole('heading', { name: 'Other prompt' })).toBeVisible();
    await expect(row(page, 'Code editor skill').locator('.lib-draft')).toBeVisible();
    await expect(row(page, 'Other prompt').locator('.lib-draft')).toHaveCount(0);
    await row(page, 'Code editor skill').click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Renamed in the draft');
    await expect(page.getByLabel('Tags', { exact: true })).toHaveValue('alpha, beta');
    await expect(page.getByLabel('Licence', { exact: true })).toHaveValue('MIT');

    // Discarding the draft asks first.
    await page.getByRole('button', { name: 'Discard local draft' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Discard your local draft?');
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Renamed in the draft');
    await page.getByRole('button', { name: 'Discard local draft' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard draft' }).click();
    await expect(page.locator('.item-code-form')).toHaveCount(0);
    await expect(row(page, 'Code editor skill').locator('.lib-draft')).toHaveCount(0);
    expect((await read(page, skill.id)).item.title).toBe('Code editor skill');

    // Config files use CodeMirror too, and Ctrl+S still saves.
    await page.getByRole('button', { name: 'Config files', exact: true }).click();
    await page.getByLabel('Filter config files').fill('claude settings.json');
    await page.locator('.item-card').filter({ hasText: 'settings.json' }).first().click();
    await page.getByRole('button', { name: 'Create file', exact: true }).click();
    const config = page.getByRole('textbox', { name: 'settings.json content', exact: true });
    await expect(config).toHaveClass(/cm-content/);
    await expect(page.locator('.home-editor-wrap textarea')).toHaveCount(0);
    await config.click(); await page.keyboard.press('Control+a');
    await page.keyboard.type('{"hooks":{}}');
    await expect(page.getByText('unsaved changes')).toBeVisible();
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    await expect(page.getByText('unsaved changes')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/code-editor.png' });

    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('code editor off: plain textareas, library Ctrl+F and no draft marks; switching it on applies live', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-code-editor-off-'));
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');
  const env = { ...desktopEnv(root), KILN_HOME: home, KILN_DESKTOP_DATA: path.join(root, 'profile') };
  delete (env as Record<string, string | undefined>).KILN_EXPERIMENTS;
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.locator('.item-list').waitFor();
    await page.evaluate(async content => (window as any).kiln.call('items.create', { kind: 'skill', title: 'Plain skill', content, collection: 'Personal', tags: [], source: '', licence: 'Personal', files: {} }), content);
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await row(page, 'Plain skill').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const plain = page.getByLabel('Content', { exact: true });
    await expect(plain).toHaveValue(content);
    expect(await plain.evaluate(node => node.tagName)).toBe('TEXTAREA');
    await expect(page.locator('.cm-editor')).toHaveCount(0);
    await plain.fill(content + 'Draft text.');
    await plain.focus(); await page.keyboard.press('Control+f');
    await expect(page.getByLabel('Search library')).toBeFocused();
    await expect(page.locator('.lib-draft')).toHaveCount(0);
    // The plain editor still writes the original draft format.
    const id = await page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('kiln-draft:'))!.slice('kiln-draft:'.length));
    expect(Object.keys(JSON.parse((await page.evaluate(id => localStorage.getItem(`kiln-draft:${id}`), id))!)).sort()).toEqual(['base', 'content']);
    await page.getByRole('button', { name: 'Config files', exact: true }).click();
    await page.getByLabel('Filter config files').fill('claude settings.json');
    await page.locator('.item-card').filter({ hasText: 'settings.json' }).first().click();
    await expect(page.getByRole('textbox', { name: 'settings.json content', exact: true })).toHaveValue('{}\n');
    expect(await page.getByRole('textbox', { name: 'settings.json content', exact: true }).evaluate(node => node.tagName)).toBe('TEXTAREA');

    // Turning the switch on changes the editors without a restart, and the draft typed without it carries over.
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await page.getByRole('region', { name: 'Experimental features' }).getByRole('switch', { name: 'Code editor' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Library', exact: true }).click();
    await expect(row(page, 'Plain skill').locator('.lib-draft')).toBeVisible();
    await row(page, 'Plain skill').click();
    await expect(page.getByRole('textbox', { name: 'Content', exact: true })).toHaveClass(/cm-content/);
    await expect(page.getByRole('textbox', { name: 'Content', exact: true })).toContainText('Draft text.');
    expect(errors).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
