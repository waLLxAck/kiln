import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../../packages/domain/workbench';
import { desktopEnv, readyLibrary } from './fixture';

const skill = (name: string) => `---\nname: ${name}\ndescription: Review changes carefully\n---\nRead the diff.\n`;
function writeSkill(home: string, provider: string, name: string) {
  const folder = path.join(home, `.${provider}/skills`, name);
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'SKILL.md'), skill(name));
}

test('enabled locations populate the library at startup and live, without importing or refreshing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-discovery-ui-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const library = readyLibrary(root), env = desktopEnv(root, library);
  const wb = new Workbench(library, env.KILN_LOCAL);
  wb.enroll({ name: 'Agents', provider: 'codex', root: home, scope: 'personal' }); wb.close();
  writeSkill(home, 'agents', 'already-here'); writeSkill(home, 'claude', 'disabled-location');
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.item-card').filter({ hasText: 'already-here' })).toBeVisible();
    await expect(page.locator('.item-card').filter({ hasText: 'disabled-location' })).toHaveCount(0);
    writeSkill(home, 'agents', 'just-created');
    await expect(page.locator('.item-card').filter({ hasText: 'just-created' })).toBeVisible();
    fs.mkdirSync(path.join(home, '.codex/agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex/agents/helper.toml'), 'name = "live-helper"\ndescription = "Help review"\ndeveloper_instructions = "Read carefully"\n');
    await expect(page.locator('.item-card').filter({ hasText: 'live-helper' })).toBeVisible();
    await page.evaluate(home => window.kiln.call('targets.enroll', { name: 'Claude', provider: 'claude', root: home, scope: 'personal' }), home);
    await expect(page.locator('.item-card').filter({ hasText: 'disabled-location' })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
    const snapshot = await page.evaluate(() => window.kiln.call<any>('snapshot'));
    expect(snapshot.items).toHaveLength(4);
    expect(snapshot.approvals).toHaveLength(0);
    expect(snapshot.items.every((item: any) => item.status === 'captured')).toBe(true);
    expect(fs.readFileSync(path.join(home, '.agents/skills/just-created/SKILL.md'), 'utf8')).toBe(skill('just-created'));

    // Changing libraries replaces the watcher and keeps discovery history scoped to that library.
    const secondHome = path.join(root, 'second-home'); fs.mkdirSync(secondHome);
    const secondLibrary = readyLibrary(root, 'second-library');
    const second = new Workbench(secondLibrary, env.KILN_LOCAL);
    second.enroll({ name: 'Agents', provider: 'codex', root: secondHome, scope: 'personal' }); second.close();
    await page.evaluate(root => window.kiln.call('desktop.attach', { root }), secondLibrary);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
    writeSkill(home, 'agents', 'old-location');
    writeSkill(secondHome, 'agents', 'new-library-skill');
    await expect(page.locator('.item-card').filter({ hasText: 'new-library-skill' })).toBeVisible();
    const attached = await page.evaluate(() => window.kiln.call<any>('snapshot'));
    expect(attached.items.map((item: any) => item.title)).toEqual(['new-library-skill']);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
