import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserSources } from '../packages/providers/browsers';
import { OfficialClients, isNewerClient } from '../packages/providers/clients';
import type { Provider } from '../packages/protocol/schema';
import { Workbench } from '../packages/domain/workbench';
import { findExecutable } from '../packages/providers/service';

test('browser discovery includes existing profiles across platforms and excludes missing profiles', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-browsers-'));
  const make = (file: string) => { fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), ''); };
  try {
    assert.deepEqual(browserSources(home, 'linux', {}), []);
    make('.config/google-chrome/Default/Preferences'); make('.mozilla/firefox/personal/prefs.js');
    make('.config/chromium/not-a-profile/file.txt');
    let sources = browserSources(home, 'linux', {});
    assert.deepEqual(sources.map(s => s.id), ['chrome', 'firefox']);
    assert.equal(sources[0].profiles[0].path, path.join(home, '.config/google-chrome/Default'));
    fs.rmSync(path.join(home, '.mozilla/firefox/personal'), { recursive: true });
    assert.deepEqual(browserSources(home, 'linux', {}).map(s => s.id), ['chrome']);
    make('Local/Microsoft/Edge/User Data/Profile 1/Preferences');
    sources = browserSources(home, 'win32', { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') });
    assert.deepEqual(sources.map(s => s.id), ['edge']);
    make('Library/Application Support/Google/Chrome/Default/Preferences'); make('Library/Cookies/Cookies.binarycookies');
    assert.deepEqual(browserSources(home, 'darwin', {}).map(s => s.id), ['chrome', 'safari']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('client update checks compare numeric versions, cache metadata, and tolerate an offline registry', async () => {
  const providers = [{ id: 'codex', available: true, version: 'codex-cli 0.162.1' }, { id: 'claude', available: true, version: '2.9.0 (Claude Code)' }] as Provider[];
  let calls = 0;
  const manager = new OfficialClients({ detect: async () => providers, fetch: async url => {
    calls++; return Response.json({ version: String(url).includes('@openai') ? '0.163.0' : '2.9.0' });
  } });
  assert.deepEqual((await manager.updates()).map(u => u.updateAvailable), [true, false]);
  await manager.updates(); assert.equal(calls, 2);
  await manager.updates(true); assert.equal(calls, 4);
  assert.equal(isNewerClient('0.162.0', 'codex-cli 0.163.0-alpha.1'), false);
  assert.equal(isNewerClient('0.163.0', 'codex-cli 0.163.0-alpha.1'), true);
  assert.equal(isNewerClient('0.163.0', 'Unknown'), false);
  const offline = new OfficialClients({ detect: async () => providers, fetch: async () => { throw new Error('Offline'); } });
  assert.ok((await offline.updates()).every(u => u.error && !u.updateAvailable));
});

test('installation uses only official scripts, refreshes PATH and detection, and cleans downloaded scripts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-install-'));
  try {
    for (const platform of ['linux', 'win32'] as const) {
      for (const provider of ['codex', 'claude'] as const) {
        const env = { PATH: '/original', LOCALAPPDATA: path.join(home, 'Local') };
        let reset = false, ran = false, scriptFile = '';
        const stateFile = path.join(home, `${platform}-${provider}.json`);
        const manager = new OfficialClients({ home, platform, env, stateFile, reset: () => { reset = true; }, detect: async () => [{ id: provider, available: ran && reset, version: '1.0.0' }] as Provider[],
          fetch: async url => {
            assert.equal(String(url), `${provider === 'codex' ? 'https://chatgpt.com/codex' : 'https://claude.ai'}/install.${platform === 'win32' ? 'ps1' : 'sh'}`);
            return new Response('# official installer fixture '.repeat(4));
          },
          run: async (executable, args, options) => {
            scriptFile = args.at(-1)!; assert.ok(fs.existsSync(scriptFile));
            assert.equal(options.cwd, home); assert.equal(options.env?.CODEX_NON_INTERACTIVE, '1');
            if (platform === 'win32') { assert.match(executable, /powershell.exe$/); assert.ok(args.includes('-NonInteractive')); }
            else assert.equal(executable, provider === 'claude' ? '/bin/bash' : '/bin/sh');
            ran = true; return { code: 0, output: '', stdout: '', stderr: '', timedOut: false, cancelled: false };
          } });
        assert.ok((await manager.install({ provider, confirm: true }))[0].available);
        assert.ok(env.PATH.includes(platform === 'win32' ? 'OpenAI' : '.local'));
        assert.equal(fs.existsSync(scriptFile), false);
        assert.ok(fs.existsSync(stateFile));
        if (platform === 'linux') {
          fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
          const restarted = { PATH: '/original' };
          new OfficialClients({ env: restarted, stateFile, platform, reset: () => {} });
          assert.ok(restarted.PATH.startsWith(path.join(home, '.local', 'bin')));
        }
      }
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('installer failures preserve the existing PATH and reject invalid providers before fetching', async () => {
  const env = { PATH: '/original' }; let calls = 0;
  const manager = new OfficialClients({ env, fetch: async () => { calls++; return new Response('Bad download', { status: 503 }); } });
  await assert.rejects(manager.install({ provider: 'copilot', confirm: true }));
  assert.equal(calls, 0);
  await assert.rejects(manager.install({ provider: 'codex', confirm: true }), /download/);
  assert.equal(env.PATH, '/original');
  const invalid = new OfficialClients({ fetch: async () => new Response('<!doctype html><html>Unavailable</html>'.repeat(4)), run: async () => { throw new Error('Must not execute HTML'); } });
  await assert.rejects(invalid.install({ provider: 'codex', confirm: true }), /invalid/);
});

test('Windows detects a newly installed native CLI ahead of an older npm shim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-cli-path-'));
  try {
    const old = path.join(root, 'npm'), native = path.join(root, 'native');
    fs.mkdirSync(old); fs.mkdirSync(native);
    fs.writeFileSync(path.join(old, 'codex.cmd'), ''); fs.writeFileSync(path.join(native, 'codex.exe'), '');
    assert.equal(findExecutable('codex', `${old};${native}`, 'win32'), path.join(native, 'codex.exe'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('new defaults migrate prior defaults once and preserve custom choices and explicit catalog selection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-defaults-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  try {
    let settings = wb.settings();
    assert.equal(settings.theme, 'dark'); assert.equal(settings.codexModel, 'gpt-6.1-sol'); assert.equal(settings.codexEffort, 'xhigh');
    assert.equal(settings.commitModel, 'gpt-6-luna'); assert.equal(settings.commitEffort, 'low');
    fs.writeFileSync(path.join(wb.local, 'settings.json'), JSON.stringify({ theme: 'light', codexModel: '', codexEffort: '', commitModel: 'gpt-5.6-luna', commitEffort: 'medium' }));
    settings = wb.settings(); assert.equal(settings.codexModel, 'gpt-6.1-sol'); assert.equal(settings.commitEffort, 'low'); assert.equal(settings.theme, 'light');
    wb.saveSettings({ ...settings, codexModel: '', codexEffort: '' });
    assert.equal(wb.settings().codexModel, '', 'explicit catalog default remains selectable after migration');
    wb.saveSettings({ ...settings, codexModel: 'custom', codexEffort: 'medium', commitModel: 'custom-commit', commitEffort: 'high' });
    assert.equal(wb.settings().codexModel, 'custom'); assert.equal(wb.settings().commitEffort, 'high');
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
