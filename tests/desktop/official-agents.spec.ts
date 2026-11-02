import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

test('Settings offers official CLI installation and updates, shows versions without paths, and retries failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-official-clients-'));
  const app = await electron.launch({ args: ['.'], env: desktopEnv(root) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Settings & repository' })).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('kiln:call');
      let codex = '0.162.1', claude = '', failedOnce = false;
      const providers = () => ['codex', 'claude', 'copilot'].map(id => ({ id, label: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'GitHub Copilot', available: id === 'codex' || Boolean(id === 'claude' && claude), executable: '/hidden/executable/path', version: id === 'codex' ? `codex-cli ${codex}` : claude, personalRoot: '/unused', skillsRoot: '/unused/skills', modes: ['manual'], authentication: 'owned by official client' }));
      ipcMain.removeHandler('kiln:call');
      ipcMain.handle('kiln:call', async (event, method, args) => {
        if (method === 'providers.detect') return { ok: true, data: providers() };
        if (method === 'agent.models') return { ok: true, data: [] };
        if (method === 'providers.updates') return { ok: true, data: [{ provider: 'codex', latestVersion: '0.163.0', updateAvailable: codex !== '0.163.0' }, { provider: 'claude', latestVersion: '2.9.0', updateAvailable: false }] };
        if (method === 'providers.install') {
          if (args.provider === 'claude' && !failedOnce) { failedOnce = true; return { ok: false, error: { code: 'INSTALL_FAILED', message: 'Fixture download failed; retry' } }; }
          if (args.provider === 'codex') codex = '0.163.0'; else claude = '2.9.0 (Claude Code)';
          return { ok: true, data: providers() };
        }
        return original(event, method, args);
      });
    });
    await page.reload();
    await page.getByRole('button', { name: 'Settings & repository' }).click();
    const card = page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Official agents', exact: true }) });
    await expect(card).toContainText('codex-cli 0.162.1');
    await expect(card.getByText('/hidden/executable/path')).toHaveCount(0);
    await expect(page.getByLabel('Codex model', { exact: true })).toHaveValue('gpt-6.1-sol');
    await expect(page.getByLabel('Reasoning effort', { exact: true })).toHaveValue('xhigh');
    await expect(page.getByRole('combobox', { name: 'CLI commit messages', exact: true })).toHaveValue('gpt-6-luna');
    await expect(page.getByLabel('Commit message effort', { exact: true })).toHaveValue('low');
    await card.getByRole('button', { name: 'Update to 0.163.0' }).click();
    await expect(card).toContainText('codex-cli 0.163.0');
    await expect(card.getByRole('button', { name: 'Update to 0.163.0' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Install Claude Code' }).click();
    await expect(card.getByRole('alert')).toContainText('Fixture download failed');
    await card.getByRole('button', { name: 'Install Claude Code' }).click();
    await expect(card).toContainText('2.9.0 (Claude Code)');
    await expect(card.getByRole('button', { name: 'Install Claude Code' })).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
