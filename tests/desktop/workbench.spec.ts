import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';
const executable = process.env.KILN_WORKBENCH_EXE ? { executablePath: process.env.KILN_WORKBENCH_EXE } : { args: ['.'] };

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
async function createItem(page: Page, input: { kind: string; title: string; content: string }) {
  await page.evaluate(async input => { await (window as any).kiln.call('items.create', { ...input, collection: 'Personal', tags: [], files: {}, source: '', licence: 'Unknown' }); }, input);
  await page.getByRole('button', { name: 'Refresh library' }).click();
  await page.getByRole('button', { name: new RegExp(input.title) }).click();
}

test('real desktop capture → copy → trial → approval → deploy → edit → rollback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln desktop ü '));
  const target = path.join(root, 'agent project'); fs.mkdirSync(target);
  const app = await electron.launch({ ...executable, env: desktopEnv(root) });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible({ timeout: 60000 });
    const content = '---\nname: desktop-review\ndescription: Review a supplied change for defects.\n---\n\n# Procedure\nRead the supplied diff. Verify claims.';
    await createItem(page, { kind: 'skill', title: 'Desktop review skill', content });
    await expect(page.getByRole('heading', { name: 'Desktop review skill' })).toBeVisible();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(content);
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await page.getByRole('button', { name: 'Manual handoff instead', exact: true }).click();
    await page.getByLabel('Representative task').fill('Review a sample diff with a known off-by-one error.');
    await page.getByLabel('Evaluation rubric', { exact: false }).fill('Find the seeded bug\nDo not invent facts');
    await page.getByRole('button', { name: 'Prepare trial' }).click();
    await expect(page.getByRole('heading', { name: 'Your trial is ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Copy handoff', exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('known off-by-one');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: /trials/ }).click();
    await page.getByRole('button', { name: 'Record result', exact: true }).click();
    await page.getByLabel('What happened?').fill('Found the known boundary error with a concrete fix.');
    await page.getByLabel('Output transcript (stored only on this machine)').fill('Observed output: the loop includes an extra element.');
    await page.getByRole('button', { name: 'Save judgement' }).click();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Approve', exact: true }).click();
    await expect(page.locator('.detail-meta .badge')).toHaveText('approved');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Machines' }).click();
    await page.getByRole('button', { name: 'Enroll project folder', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Test Codex project');
    await page.getByLabel('Allowed root').fill(target);
    await page.getByRole('dialog').getByRole('button', { name: 'Enroll environment', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'installs', exact: true }).click();
    await page.getByRole('button', { name: 'Install into a project folder…', exact: true }).click();
    await page.getByRole('button', { name: 'Preview install' }).click();
    const destination = path.join(target, '.agents', 'skills', 'desktop-review', 'SKILL.md');
    expect(fs.existsSync(destination)).toBe(false);
    await page.getByRole('button', { name: 'Confirm & install' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0); expect(fs.readFileSync(destination, 'utf8')).toBe(content);
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'content', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Content', { exact: true }).fill(content + '\nUnapproved change.');
    await page.getByLabel('What changed?').fill('Test approval integrity');
    await page.getByRole('button', { name: 'Save revision' }).click();
    await expect(page.locator('.detail-meta .badge')).not.toHaveText('approved');
    expect(fs.readFileSync(destination, 'utf8')).toBe(content);
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'installs', exact: true }).click();
    await page.getByRole('button', { name: 'Review rollback' }).click();
    await page.getByRole('button', { name: 'Confirm rollback' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0); expect(fs.existsSync(destination)).toBe(false);
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'overview', exact: true }).click();
    await page.screenshot({ path: 'test-results/workbench.png' });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined');
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('palette keyboard copy, Escape clipboard preservation, persisted reopening and hostile preview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln palette '));
  const env = desktopEnv(root);
  let app = await electron.launch({ ...executable, env });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Capture your first item', exact: true })).toBeVisible({ timeout: 60000 });
    await createItem(page, { kind: 'prompt', title: 'Make the next step clear', content: 'Explain the next step clearly.' });
    await expect(page.getByRole('heading', { name: 'Make the next step clear' })).toBeVisible();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Approve', exact: true }).click();
    await expect(page.locator('.detail-meta .badge')).toHaveText('approved');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const approved = await page.evaluate(async () => {
      const snapshot = await window.kiln.call<{ approvals: { note: string; evidence: string[] }[] }>('snapshot');
      return snapshot.approvals[0];
    });
    expect(approved.note).toBe('Approved by clicking Approve in Kiln.');
    expect(approved.evidence).toEqual([]);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Unapprove', exact: true }).click();
    await expect(page.locator('.detail-meta .badge')).not.toHaveText('approved');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Approve', exact: true }).click();
    await expect(page.locator('.detail-meta .badge')).toHaveText('approved');
    await app.close(); app = await electron.launch({ ...executable, env }); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: /Make the next step clear/ })).toBeVisible();
    await app.evaluate(({ clipboard }) => clipboard.writeText('Do not change this on Escape'));
    await page.getByRole('button', { name: /Quick search/ }).click();
    const palette = await app.waitForEvent('window');
    await expect(palette.getByRole('combobox', { name: 'Quick search' })).toBeVisible();
    await palette.getByRole('combobox').fill('clear');
    await expect(palette.getByRole('option')).toHaveCount(1);
    await palette.keyboard.press('Escape');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Do not change this on Escape');
    await createItem(page, { kind: 'prompt', title: 'Untrusted markup', content: '<img src=x onerror="window.compromised=true"><script>window.compromised=true</script>' });
    await expect(page.getByRole('heading', { name: 'Untrusted markup' })).toBeVisible();
    await expect(page.locator('.content-preview')).toContainText('<script>');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('.markdown-content')).toBeVisible();
    expect(await page.evaluate(() => Boolean((window as unknown as { compromised?: boolean }).compromised))).toBe(false);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});


test('delete started experiments from both lists and keep them deleted after reopening', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln delete trials '));
  const env = desktopEnv(root);
  let app = await electron.launch({ ...executable, env });
  try {
    let page = await app.firstWindow();
    await page.evaluate(async () => {
      const item = await window.kiln.call<{ id: string; revision: string }>('items.create', { title: 'Delete experiment fixture', kind: 'prompt', content: 'Test' });
      for (let i = 0; i < 2; i++) await window.kiln.call('trials.create', { id: item.id, revision: item.revision, provider: 'manual', task: 'Disposable trial', rubric: ['Observe output'], case: 'typical' });
    });
    await page.getByRole('button', { name: 'Refresh library' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Experiments', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete experiment', exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: 'Delete experiment', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Delete experiment', exact: true })).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('button', { name: /Delete experiment fixture/ }).click();
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: /trials/ }).click();
    await page.getByRole('button', { name: 'Delete experiment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete experiment', exact: true })).toHaveCount(0);
    await app.close(); app = await electron.launch({ ...executable, env }); page = await app.firstWindow();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Experiments', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'A good prompt earns your trust.' })).toBeVisible();
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
