import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HomeFiles } from '../packages/home/service';
import { WorkbenchError } from '../packages/domain/errors';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln home '));
  const home = path.join(root, 'home ü'); fs.mkdirSync(home);
  const documents = path.join(home, 'Documents', 'PowerShell');
  const home7 = { host: path.join(documents, 'Microsoft.PowerShell_profile.ps1'), all: path.join(documents, 'profile.ps1') };
  const probed: string[] = [];
  const files = new HomeFiles({ home, privateRoot: path.join(root, 'private'), platform: 'win32', probe: async shell => { probed.push(shell); return shell === 'pwsh' ? home7 : null; } });
  return { root, home, home7, files, probed, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const hasCode = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.code === code;

test('config files validate before writing, preserve backups, and discover project hooks', async () => {
  const f = fixture();
  try {
    const created = await f.files.save({ key: 'claude-settings', expect: null, content: '{"hooks":{},"permissions":{"deny":["Read(.env)"]}}\n' });
    await assert.rejects(f.files.save({ key: created.key, expect: created.hash, content: '{invalid' }), hasCode('INVALID_CONFIG'));
    assert.equal((await f.files.read(created.key)).content, created.content);
    await f.files.save({ key: created.key, expect: created.hash, content: '{}\n' });
    assert.equal((await f.files.backups(created.key)).length, 1);
    await assert.rejects(f.files.save({ key: 'codex-settings', expect: null, content: 'broken = [' }), hasCode('INVALID_CONFIG'));
    assert.equal((await f.files.read('codex-settings')).exists, false);
    const project = path.join(f.root, 'project'); fs.mkdirSync(path.join(project, '.github', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, '.github', 'hooks', 'session.json'), '{"version":1,"hooks":{}}');
    f.files.addProject({ path: project }); f.files.addProject({ path: project });
    const entries = (await f.files.list()).files;
    assert.equal(entries.filter(e => e.path === path.join(project, '.github', 'hooks', 'session.json')).length, 1);
    const settings = entries.find(e => e.path === path.join(project, '.claude', 'settings.local.json'))!;
    assert.match(settings.scope!, /Project/); assert.equal(settings.exists, false);
    await f.files.save({ key: settings.key, expect: null, content: settings.template! });
    assert.deepEqual(JSON.parse(fs.readFileSync(settings.path, 'utf8')), {});
    const vscode = entries.find(e => e.path === path.join(project, '.vscode', 'settings.json'))!;
    await f.files.save({ key: vscode.key, expect: null, content: '{ // comment\n "editor.tabSize": 2,\n}\n' });
  } finally { f.close(); }
});

test('config directory overrides are honored and discovery never creates files', async () => {
  const f = fixture();
  try {
    const config = path.join(f.root, 'custom-codex');
    const files = new HomeFiles({ home: f.home, privateRoot: path.join(f.root, 'private'), env: { CODEX_HOME: config }, probe: async () => null });
    assert.equal((await files.list()).files.find(e => e.key === 'codex-settings')!.path, path.join(config, 'config.toml'));
    assert.equal(fs.existsSync(config), false);
  } finally { f.close(); }
});

test('lists the agent instruction files and shell profiles, asking each shell only once', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.home, '.claude')); fs.writeFileSync(path.join(f.home, '.claude', 'CLAUDE.md'), '@~/AGENTS.md\n');
    const first = await f.files.list(); const second = await f.files.list();
    assert.deepEqual(f.probed.sort(), ['powershell', 'pwsh']);
    for (const key of ['claude-global', 'agents-home', 'codex-global', 'claude-settings', 'codex-settings', 'codex-hooks', 'copilot-settings', 'pwsh-host', 'powershell-host']) assert.ok(first.files.some(x => x.key === key), key);
    assert.equal(second.files.length, first.files.length);
    const claude = first.files.find(x => x.key === 'claude-global')!;
    assert.equal(claude.exists, true); assert.equal(claude.size, 13); assert.match(claude.hash!, /^[a-f0-9]{64}$/);
    assert.equal(first.files.find(x => x.key === 'agents-home')!.exists, false);
    assert.equal(first.files.find(x => x.key === 'pwsh-host')!.path, f.home7.host);
    // Windows PowerShell 5.1 falls back to its documented location when the shell could not be asked.
    assert.equal(first.files.find(x => x.key === 'powershell-host')!.path, path.join(f.home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'));
    // The all-hosts profile appears only once it exists.
    fs.mkdirSync(path.dirname(f.home7.all), { recursive: true }); fs.writeFileSync(f.home7.all, '# all hosts');
    assert.ok((await f.files.list()).files.some(x => x.key === 'pwsh-all'));
  } finally { f.close(); }
});

test('creates, saves with a stale-hash guard, keeps a backup, and preserves CRLF and BOM', async () => {
  const f = fixture();
  try {
    const missing = await f.files.read('agents-home');
    assert.equal(missing.exists, false); assert.equal(missing.hash, null);
    await assert.rejects(f.files.save({ key: 'agents-home', expect: 'not-null', content: 'x' }), hasCode('FILE_CHANGED'));
    const created = await f.files.save({ key: 'agents-home', expect: null, content: '# Agents\n' });
    assert.equal(created.exists, true); assert.equal(fs.readFileSync(created.path, 'utf8'), '# Agents\n');
    assert.deepEqual(await f.files.backups('agents-home'), []); // Creating a file has nothing to keep.
    // A file written by PowerShell 5.1: BOM plus CRLF. Saving from the LF editor text keeps both.
    fs.mkdirSync(path.dirname(f.home7.host), { recursive: true }); fs.writeFileSync(f.home7.host, '﻿Set-Alias ll Get-ChildItem\r\nfunction p { git pull }\r\n');
    const profile = await f.files.read('pwsh-host');
    assert.equal(profile.bom, true); assert.equal(profile.eol, 'crlf'); assert.equal(profile.content, 'Set-Alias ll Get-ChildItem\nfunction p { git pull }\n');
    await assert.rejects(f.files.save({ key: 'pwsh-host', expect: created.hash, content: 'x' }), hasCode('FILE_CHANGED'));
    const saved = await f.files.save({ key: 'pwsh-host', expect: profile.hash, content: profile.content + 'function s { git status }\n' });
    assert.deepEqual([...fs.readFileSync(saved.path).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(fs.readFileSync(saved.path, 'utf8'), '﻿Set-Alias ll Get-ChildItem\r\nfunction p { git pull }\r\nfunction s { git status }\r\n');
    const kept = await f.files.backups('pwsh-host');
    assert.equal(kept.length, 1); assert.match(kept[0].name, /\.ps1$/); assert.ok(!Number.isNaN(Date.parse(kept[0].at)));
    assert.equal((await f.files.backup({ key: 'pwsh-host', name: kept[0].name })).content, profile.content);
    // Saving identical bytes keeps nothing new.
    await f.files.save({ key: 'pwsh-host', expect: saved.hash, content: saved.content });
    assert.equal((await f.files.backups('pwsh-host')).length, 1);
    // Restoring keeps the version being replaced, so it is reversible.
    const restored = await f.files.restore({ key: 'pwsh-host', name: kept[0].name, expect: saved.hash });
    assert.equal(restored.content, profile.content); assert.equal((await f.files.backups('pwsh-host')).length, 2);
    await assert.rejects(f.files.backup({ key: 'pwsh-host', name: '../../etc' }), hasCode('INVALID_PATH'));
  } finally { f.close(); }
});

test('any text file can be added to the list and forgotten again without touching it', async () => {
  const f = fixture();
  try {
    const project = path.join(f.root, 'project'); fs.mkdirSync(project);
    const file = path.join(project, 'CLAUDE.md'); fs.writeFileSync(file, '# Project rules\n');
    await assert.rejects(async () => f.files.add({ path: path.join(project, 'missing.md') }), hasCode('INVALID_FILE'));
    fs.writeFileSync(path.join(project, 'tool.exe'), 'MZ'); await assert.rejects(async () => f.files.add({ path: path.join(project, 'tool.exe') }), hasCode('INVALID_FILE'));
    const { key } = f.files.add({ path: file }); f.files.add({ path: process.platform === 'win32' ? file.toUpperCase() : file });
    const listed = (await f.files.list()).files.filter(x => x.kind === 'custom');
    assert.equal(listed.length, 1); assert.equal(listed[0].key, key); assert.equal(listed[0].removable, true); assert.equal(listed[0].label, 'CLAUDE.md');
    const content = await f.files.read(key);
    await f.files.save({ key, expect: content.hash, content: '# Project rules\nBe brief.\n' });
    assert.equal((await f.files.backups(key)).length, 1);
    await assert.rejects(f.files.remove({ key: 'claude-global' }), hasCode('NOT_REMOVABLE'));
    await f.files.remove({ key });
    assert.equal((await f.files.list()).files.some(x => x.key === key), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '# Project rules\nBe brief.\n');
    await assert.rejects(f.files.read(key), hasCode('FILE_UNKNOWN'));
  } finally { f.close(); }
});
