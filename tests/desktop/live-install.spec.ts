import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

test('authorized live install/uninstall affects only the disposable fixture in Codex and Claude', async () => {
  test.skip(process.env.KILN_LIVE_TEST !== '1', 'Requires explicit live-test opt-in and user-authorized library.');
  test.setTimeout(180_000);
  const library = process.env.KILN_LIVE_LIBRARY!, repository = process.env.KILN_LIVE_REPOSITORY!;
  expect(library).toBeTruthy(); expect(repository, 'KILN_LIVE_REPOSITORY names the connected owner/repository').toBeTruthy();
  const evidence = path.resolve('artifacts/skills-migration'); fs.mkdirSync(evidence, { recursive: true });
  const before = JSON.parse(fs.readFileSync(path.join(evidence, 'before.json'), 'utf8')) as { installed: Record<string, string> };
  const fixtureName = `kiln-install-check-${Date.now().toString(36)}`;
  const destinations = [path.join(os.homedir(), '.agents', 'skills', fixtureName), path.join(os.homedir(), '.claude', 'skills', fixtureName)];
  for (const destination of destinations) expect(fs.existsSync(destination)).toBe(false);
  const app = await electron.launch({ args: ['.'], env: { ...process.env, KILN_LIBRARY: library, KILN_DESKTOP_DATA: path.join(evidence, 'desktop-profile') } });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const content = `---\nname: ${fixtureName}\ndescription: Verify a Kiln installation when the user asks for the Kiln installation check.\n---\n\nReturn exactly: Kiln install check OK.\n`;
  fs.mkdirSync(path.join(evidence, 'fixture-validation'), { recursive: true });
  fs.writeFileSync(path.join(evidence, 'fixture-validation', 'SKILL.md'), content);
  let fixtureId = '';
  try {
    await page.getByRole('tab', { name: /^Skills/ }).click();
    const originalItems = await page.evaluate(async () => (await window.kiln.call<{ items: { id: string; source: string }[] }>('snapshot')).items.filter(i => i.source.startsWith('repository:')));
    expect(originalItems).toHaveLength(217);
    await page.screenshot({ path: path.join(evidence, 'all-skills.png') });
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await expect(page.getByText(repository, { exact: true })).toBeVisible();
    await expect(page.getByText(/Kiln standard v1/)).toBeVisible();
    await page.screenshot({ path: path.join(evidence, 'github-connected.png') });
    await page.getByRole('button', { name: 'Capture Ctrl N', exact: true }).click();
    await page.getByLabel('Resource type').selectOption('skill');
    await page.getByLabel('Title', { exact: true }).fill('Kiln installation check');
    await page.getByLabel('SKILL.md').fill(content);
    await page.getByLabel('Collection', { exact: true }).fill('Installation tests');
    await page.getByLabel('Source', { exact: true }).fill('User-requested disposable installer verification');
    await page.getByRole('button', { name: 'Capture item', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Kiln installation check' })).toBeVisible();
    fixtureId = await page.evaluate(async () => (await window.kiln.call<{ items: { id: string; title: string; status: string }[] }>('snapshot')).items.filter(i => i.title === 'Kiln installation check' && i.status === 'captured').at(-1)!.id);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Approve', exact: true }).click();
    await expect(page.locator('.detail-meta .badge')).toHaveText('approved');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const [index, environment] of ['Personal Codex', 'Personal Claude Code'].entries()) {
      await page.getByRole('button', { name: 'Deploy', exact: true }).first().click();
      await page.getByLabel('Environment').selectOption({ label: `${environment} · ${index === 0 ? 'codex' : 'claude'} · Personal` });
      await page.getByRole('button', { name: 'Preview deployment' }).click();
      expect(fs.existsSync(destinations[index])).toBe(false);
      await page.getByRole('button', { name: 'Confirm & apply snapshot' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(fs.readFileSync(path.join(destinations[index], 'SKILL.md'), 'utf8')).toBe(content);
    }
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'deployments', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Uninstall skill', exact: true })).toHaveCount(2);
    await page.screenshot({ path: path.join(evidence, 'test-skill-installed.png') });
    for (let index = 0; index < 2; index++) {
      await page.getByRole('button', { name: 'Uninstall skill', exact: true }).first().click();
      await page.getByRole('button', { name: 'Confirm uninstall', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    for (const destination of destinations) expect(fs.existsSync(destination)).toBe(false);
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'content', exact: true }).click();
    await page.getByRole('button', { name: 'Move to archived' }).click();
    for (const [relative, expected] of Object.entries(before.installed)) {
      if (relative.endsWith(':link')) expect(fs.readlinkSync(path.join(os.homedir(), relative.slice(0, -5)))).toBe(expected);
      else expect(createHash('sha256').update(fs.readFileSync(path.join(os.homedir(), relative))).digest('hex')).toBe(expected);
    }
    expect(errors).toEqual([]);
    const result = { fixtureId, fixtureName, destinations, installedAndVerified: true, uninstalledAndVerified: true, existingEntriesVerifiedUnchanged: Object.keys(before.installed).length, githubConnectionVerified: repository, catalogSkillsVerified: 217, completedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(evidence, 'live-install-result.json'), JSON.stringify(result, null, 2));
    await page.getByRole('tab', { name: /^Skills/ }).click();
    await page.getByRole('button', { name: /build-knowledge-system/ }).first().click();
    await page.getByRole('navigation', { name: 'Item details' }).getByRole('button', { name: 'overview', exact: true }).click();
    await page.screenshot({ path: path.join(evidence, 'migrated-library.png') });
  } finally {
    // Cleanup goes through the same guarded domain operation, only for this fixture.
    if (fixtureId) await page.evaluate(async id => {
      const snapshot = await window.kiln.call<{ receipts: { id: string; itemId: string; hash: string; status: string; destination: string; createdAt: string }[] }>('snapshot');
      const own = snapshot.receipts.filter(r => r.itemId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const destination of new Set(own.map(r => r.destination))) {
        const receipt = own.filter(r => r.destination === destination).at(-1)!;
        if (receipt.status === 'applied') await window.kiln.call('deploy.uninstall', { receiptId: receipt.id, expectState: receipt.hash, confirm: true });
      }
    }, fixtureId).catch(error => console.error('Fixture cleanup needs attention:', error));
    await app.close();
  }
});
