import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { desktopEnv, readyLibrary } from './fixture';

test('217 skills: import preview stays responsive, panels resize, stalls are logged', async () => {
  test.setTimeout(120_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-performance-'));
  // A Kiln repository, plus a separate skills repository with 217 skills to import from.
  const library = readyLibrary(root);
  const skills = path.join(root, 'skills'); fs.mkdirSync(skills);
  for (let i = 0; i < 217; i++) {
    const folder = path.join(skills, `skill-${i}`); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: skill-${i}\ndescription: Performance fixture\n---\n# Skill ${i}\n\nFollow the procedure.\n`);
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', skills, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL', ...args], { windowsHide: true });
  git('init'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Fixture');
  const local = path.join(root, 'private');
  const app = await electron.launch({ ...(process.env.KILN_PERFORMANCE_EXE ? { executablePath: process.env.KILN_PERFORMANCE_EXE } : { args: ['.'] }), env: desktopEnv(root, library) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('separator', { name: 'Resize sidebar', exact: true })).toBeVisible();
    const handle = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
    await handle.focus(); await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '270');
    const list = page.getByRole('separator', { name: 'Resize skill list' });
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + 3, box.y + 80); await page.mouse.down(); await page.mouse.move(box.x + 63, box.y + 80); await page.mouse.up();
    await expect(list).toHaveAttribute('aria-valuenow', '680');
    await page.reload(); await expect(handle).toHaveAttribute('aria-valuenow', '270');
    await expect(list).toHaveAttribute('aria-valuenow', '680');
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    await app.evaluate(() => { (globalThis as any).testTicks = 0; (globalThis as any).testTimer = setInterval(() => (globalThis as any).testTicks++, 20); });
    await page.getByRole('button', { name: 'Import from a skills repository…' }).click();
    await page.getByLabel('Folder', { exact: true }).fill(skills);
    await page.getByRole('button', { name: 'Read skills', exact: true }).click();
    // The import dialog is modal, so reach the theme button directly: the point is that the renderer answers while the plan is computed.
    await page.getByRole('button', { name: 'Toggle theme' }).dispatchEvent('click');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 400 });
    await expect(page.getByRole('button', { name: 'Import 217 skills', exact: true })).toBeVisible();
    expect(await app.evaluate(() => (globalThis as any).testTicks)).toBeGreaterThan(2);
    await page.getByRole('button', { name: 'Import 217 skills', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 60000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('tab', { name: /^Skills/ }).click();
    await expect(page.locator('.item-card')).toHaveCount(217);
    await page.locator('.item-card').first().click();
    await expect(page.getByRole('button', { name: 'Open editor', exact: false })).toBeVisible();
    await page.evaluate(() => { const end = performance.now() + 1800; while (performance.now() < end) { /* Deliberate renderer stall. */ } });
    const file = path.join(local, 'desktop', 'logs', 'performance.jsonl');
    await expect.poll(() => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').toContain('renderer.stall');
    const logs = fs.readFileSync(file, 'utf8');
    expect(logs).toContain('repository.migrationPlan'); expect(logs).toContain('durationMs');
    expect(logs).not.toContain('Follow the procedure');
    await page.screenshot({ path: 'artifacts/performance-217-skills-dark.png', animations: 'disabled' });
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    await page.screenshot({ path: 'artifacts/performance-217-skills.png', animations: 'disabled' });
    await app.evaluate(() => clearInterval((globalThis as any).testTimer));
  } finally { await app.close(); }
});
