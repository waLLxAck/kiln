import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopEnv } from './fixture';

test('query tokens, Ctrl+A and the right-click menu remove copies across locations and preserve excluded items', async () => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-bulk-ui-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const app = await electron.launch({ ...(process.env.KILN_BULK_EXE ? { executablePath: process.env.KILN_BULK_EXE } : { args: ['.'] }), env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('combobox', { name: 'Search library' })).toBeVisible();
    await page.evaluate(async home => {
      await window.kiln.call('targets.enroll', { name: 'Shared', provider: 'codex', root: home, scope: 'personal' });
      for (let n = 0; n < 13; n++) await window.kiln.call('items.create', { title: `Skill ${n}`, kind: 'skill', tags: [n === 12 ? 'keep' : 'remove'], content: `---\nname: bulk-${n}\ndescription: Review changes\n---\nRead carefully.\n` });
    }, home);
    for (let n = 0; n < 13; n++) for (const folder of ['.agents', '.copilot']) {
      const destination = path.join(home, folder, 'skills', `bulk-${n}`); fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'SKILL.md'), `---\nname: bulk-${n}\ndescription: Review changes\n---\nRead carefully.\n`);
    }
    await page.reload();
    const menuItem = (name: RegExp | string) => page.getByRole('menuitem', { name });
    const card = (title: string) => page.locator('.item-card', { hasText: new RegExp(`${title}(?!\\d)`) });
    const bar = page.getByRole('combobox', { name: 'Search library' });
    const filter = async (typed: string) => { await bar.fill(typed); await bar.press('Enter'); await bar.press('Escape'); };
    const focus = async (title: string) => { await card(title).focus(); };
    // Filters are tokens in the query bar: typing facet:value and Enter adds the matching suggestion as a chip.
    await filter('provider:copilot');
    await filter('tag:remove');
    await expect(page.getByRole('button', { name: 'Remove tag: remove' })).toBeVisible();
    await expect(page.locator('.item-card')).toHaveCount(12);
    // Ctrl+A picks every filtered row, including those below the scroll; a filter change drops the selection.
    await focus('Skill 11');
    await page.keyboard.press('Control+a');
    await expect(page.getByText('12 selected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove tag: remove' }).click();
    await filter('tag:keep');
    await expect(page.locator('.item-card')).toHaveCount(1);
    await expect(page.getByText('12 selected', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Remove tag: keep' }).click();
    await filter('tag:remove');
    await focus('Skill 11');
    await page.keyboard.press('Control+a');
    await card('Skill 0').click({ modifiers: ['Control'] });
    await expect(page.getByText('11 selected', { exact: true })).toBeVisible();
    await focus('Skill 11');
    await page.keyboard.press('Control+a');
    await expect(page.getByText('12 selected', { exact: true })).toBeVisible();
    // Two or more picked rows bring up the bulk bar above the table.
    await expect(page.getByRole('toolbar', { name: '12 items selected' }).getByRole('button', { name: /^Remove local copies/ })).toBeVisible();
    await page.screenshot({ path: 'artifacts/bulk-selection.png' });
    // Right-click on a picked row acts on the whole selection through the ordinary context menu.
    await card('Skill 5').click({ button: 'right' });
    await expect(page.getByRole('menu').getByText('12 items selected', { exact: true })).toBeVisible();
    await menuItem(/^Remove local copies/).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('24 local copies', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(fs.existsSync(path.join(home, '.agents/skills/bulk-0/SKILL.md'))).toBe(true);
    await focus('Skill 11');
    await page.keyboard.press('Control+a');
    await card('Skill 5').click({ button: 'right' });
    await menuItem(/^Remove local copies/).click();
    await dialog.getByRole('button', { name: 'Remove 24 local copies', exact: true }).click();
    await expect(dialog.getByText('24 handled; 0 skipped.', { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: 'artifacts/bulk-removal.png' });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    for (let n = 0; n < 13; n++) for (const folder of ['.agents', '.copilot']) expect(fs.existsSync(path.join(home, folder, 'skills', `bulk-${n}`))).toBe(n === 12);
    const snapshot = await page.evaluate(() => window.kiln.call<any>('snapshot'));
    expect(snapshot.items).toHaveLength(13);
    expect(snapshot.items.every((item: any) => item.deletedAt === null)).toBe(true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
