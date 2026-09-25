import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchError } from '../packages/domain/errors';
import { noLinks, systemLink } from '../packages/storage/files';
import { commonBinFolders, desktopPath, mergePath, parseShellPath } from '../packages/providers/path';
import { configCatalog, editorConfigRoot } from '../packages/home/catalog';

test('the desktop PATH on macOS and Linux prefers the login shell, keeps the inherited PATH and adds the usual CLI folders', async () => {
  const mac = await desktopPath('darwin', '/Users/ada', '/usr/bin:/bin', async () => '/Users/ada/.nvm/versions/node/v24/bin:/usr/bin');
  assert.deepEqual(mac.split(':').slice(0, 4), ['/Users/ada/.nvm/versions/node/v24/bin', '/usr/bin', '/bin', '/opt/homebrew/bin']);
  for (const dir of ['/usr/local/bin', '/Users/ada/.local/bin', '/Users/ada/.npm-global/bin', '/Users/ada/.claude/local']) assert.ok(mac.split(':').includes(dir), dir);
  assert.equal(new Set(mac.split(':')).size, mac.split(':').length, 'no repeated folders');
  // A shell that fails or times out still leaves a usable PATH.
  const linux = await desktopPath('linux', '/home/ada', '/usr/bin', async () => null);
  assert.equal(linux.split(':')[0], '/usr/bin');
  assert.ok(linux.split(':').includes('/home/linuxbrew/.linuxbrew/bin') && !linux.includes('/opt/homebrew'));
  // Windows keeps its PATH untouched and never asks a shell.
  assert.equal(await desktopPath('win32', 'C:\\Users\\ada', 'C:\\Windows', async () => { throw new Error('not called'); }), 'C:\\Windows');
  assert.deepEqual(commonBinFolders('C:\\Users\\ada', 'win32'), []);
});

test('the login shell PATH is read between markers, ignoring what startup files print', () => {
  assert.equal(parseShellPath('Welcome!\n__KILN_PATH__\nHOME=/Users/ada\nPATH=/opt/homebrew/bin:/usr/bin\nMANPATH=/x\n__KILN_PATH__\nbye'), '/opt/homebrew/bin:/usr/bin');
  assert.equal(parseShellPath('PATH=/wrong\n__KILN_PATH__\nHOME=/x\n__KILN_PATH__\n'), null);
  assert.equal(parseShellPath('no markers PATH=/usr/bin'), null);
  assert.equal(mergePath(['/a:/b', undefined, null, ':/b:/c:'], ':'), '/a:/b:/c');
});

test('VS Code user settings are found where each platform keeps them', () => {
  assert.equal(editorConfigRoot('C:\\Users\\ada', { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'win32'), 'C:\\Users\\ada\\AppData\\Roaming');
  assert.equal(editorConfigRoot('C:\\Users\\ada', {}, 'win32'), null);
  assert.equal(editorConfigRoot('/Users/ada', {}, 'darwin'), path.join('/Users/ada', 'Library', 'Application Support'));
  assert.equal(editorConfigRoot('/home/ada', {}, 'linux'), path.join('/home/ada', '.config'));
  assert.equal(editorConfigRoot('/home/ada', { XDG_CONFIG_HOME: '/home/ada/.xdg' }, 'linux'), '/home/ada/.xdg');
  const settings = (platform: NodeJS.Platform) => configCatalog('/home/ada', [], {}, platform).find(entry => entry.key === 'vscode-settings')?.path;
  assert.equal(settings('linux'), path.join('/home/ada', '.config', 'Code', 'User', 'settings.json'));
  assert.equal(settings('darwin'), path.join('/home/ada', 'Library', 'Application Support', 'Code', 'User', 'settings.json'));
  assert.equal(settings('win32'), undefined);
});

test('links the operating system owns above the home folder are accepted; links the user made are still rejected', { skip: process.platform === 'win32' && 'Windows has no such system links, and creating symlinks needs privileges there' }, () => {
  assert.equal(systemLink('/var', 'darwin', '/Users/ada'), true);
  assert.equal(systemLink('/tmp', 'darwin', '/Users/ada'), true);
  assert.equal(systemLink('/var', 'linux', '/home/ada'), false);
  assert.equal(systemLink('/home', 'linux', '/home/ada'), true, 'an ancestor of home, as with /home -> /var/home');
  assert.equal(systemLink('/home/ada', 'linux', '/home/ada'), true, 'home itself');
  assert.equal(systemLink('/home/ada/skills', 'linux', '/home/ada'), false, 'inside home');
  assert.equal(systemLink('/home/other', 'linux', '/home/ada'), false);
  assert.equal(systemLink('/var', 'win32', '/var/home/ada'), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-links-'));
  const previous = process.env.HOME;
  try {
    fs.mkdirSync(path.join(root, 'var', 'home', 'ada', 'real'), { recursive: true });
    fs.symlinkSync(path.join(root, 'var', 'home'), path.join(root, 'home'));
    fs.symlinkSync(path.join(root, 'var', 'home', 'ada', 'real'), path.join(root, 'var', 'home', 'ada', 'linked'));
    process.env.HOME = path.join(root, 'home', 'ada');
    assert.doesNotThrow(() => noLinks(path.join(root, 'home', 'ada', '.kiln', 'library')));
    assert.throws(() => noLinks(path.join(root, 'home', 'ada', 'linked', 'file.md')), (error: unknown) => error instanceof WorkbenchError && error.code === 'SYMLINK_REJECTED');
  } finally {
    process.env.HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
