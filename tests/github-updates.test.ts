import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GitHubUpdates, latestRelease, RELEASES, type Updater } from '../packages/updates/github';
import { installerPattern } from '../packages/updates/service';
import { WorkbenchError } from '../packages/domain/errors';

/** What a followed redirect looks like: the final URL is the tag page. */
const redirect = (tag: string) => async () => ({ status: 200, url: `${RELEASES}/tag/${tag}`, headers: { get: () => null } });
const noUpdater = async (): Promise<Updater> => { throw new Error('the download path must not load electron-updater'); };

test('the latest release comes from the /releases/latest redirect, not the rate-limited API', async () => {
  let asked: { url: string; method: string } | undefined;
  const fetcher = async (url: string, init: { method: string }) => { asked = { url, method: init.method }; return redirect('v0.20.0')(); };
  assert.deepEqual(await latestRelease(fetcher), { version: '0.20.0', url: `${RELEASES}/tag/v0.20.0` });
  assert.deepEqual(asked, { url: `${RELEASES}/latest`, method: 'HEAD' });
  assert.deepEqual(await latestRelease(async () => ({ status: 302, url: `${RELEASES}/latest`, headers: { get: (name: string) => name === 'location' ? `${RELEASES}/tag/v1.2.3` : null } })), { version: '1.2.3', url: `${RELEASES}/tag/v1.2.3` }, 'an unfollowed redirect still names the tag');
  assert.equal(await latestRelease(async () => ({ status: 404, url: `${RELEASES}/latest`, headers: { get: () => null } })), null, 'no releases yet');
  assert.deepEqual(await latestRelease(redirect('2.0.0')), { version: '2.0.0', url: `${RELEASES}/tag/2.0.0` }, 'the link keeps the tag as published');
  // Electron's net.fetch reports an empty URL after a redirect: that must read as a failure, never as "up to date".
  await assert.rejects(latestRelease(async () => ({ status: 200, url: '', headers: { get: () => null } })), /without naming the latest release/);
  await assert.rejects(latestRelease(redirect('nightly')), /without naming the latest release/);
});

test('a copy that cannot replace itself only reports the release; checks share one request and failures are reported', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; await new Promise(r => setTimeout(r, 5)); return redirect('v0.20.0')(); };
  const updates = new GitHubUpdates('0.19.1', 'download', () => {}, fetcher, noUpdater);
  await Promise.all([updates.check('a'), updates.check('b')]);
  assert.equal(requests, 1, 'overlapping checks make one request');
  assert.deepEqual(updates.status().available, { version: '0.20.0', path: `${RELEASES}/tag/v0.20.0` });
  assert.ok(updates.status().checkedAt);
  await assert.rejects(updates.download('0.20.0'), (error: unknown) => error instanceof WorkbenchError && error.code === 'UPDATE_UNSUPPORTED');
  const current = new GitHubUpdates('0.20.0', 'download', () => {}, fetcher, noUpdater);
  await current.check('same'); assert.equal(current.status().available, null, 'the running version is not an update');
  const offline = new GitHubUpdates('0.19.1', 'download', () => {}, async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); }, noUpdater);
  await offline.check('offline'); assert.match(offline.status().error, /Could not reach GitHub: getaddrinfo ENOTFOUND/); assert.equal(offline.status().available, null);
});

test('an installable copy downloads only when asked, shows progress, and restarts silently into the new version', async () => {
  const events = new EventEmitter(); let downloads = 0, installed: [boolean, boolean] | undefined, loads = 0;
  const updater = { checkForUpdates: async () => ({ updateInfo: { version: '0.20.0' } }), downloadUpdate: async () => { downloads++; }, quitAndInstall: (silent: boolean, run: boolean) => { installed = [silent, run]; }, on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener) } as unknown as Updater;
  const updates = new GitHubUpdates('0.19.1', 'app', () => {}, redirect('v0.20.0'), async () => { loads++; return updater; });
  await updates.check('startup');
  assert.equal(updates.status().available?.version, '0.20.0'); assert.equal(downloads, 0, 'checking never downloads');
  await assert.rejects(updates.download('0.21.0'), (error: unknown) => error instanceof WorkbenchError && error.code === 'UPDATE_CHANGED');
  await updates.download('0.20.0');
  assert.equal(downloads, 1); assert.deepEqual(updates.status().stage, { state: 'preparing', version: '0.20.0', progress: 0 });
  events.emit('download-progress', { percent: 42.7 }); assert.deepEqual(updates.status().stage, { state: 'preparing', version: '0.20.0', progress: 42 });
  events.emit('update-downloaded', { version: '0.20.0' }); assert.deepEqual(updates.status().stage, { state: 'ready', version: '0.20.0' });
  await updates.check('timer'); assert.equal(updates.status().stage.state, 'ready', 'a waiting update is not disturbed by the timer');
  let quitting = false;
  await updates.restart(() => { quitting = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(quitting, true); assert.deepEqual(installed, [true, true]); assert.equal(loads, 1, 'electron-updater is loaded once');
});

test('a failed download can be retried', async () => {
  const events = new EventEmitter(); let attempt = 0;
  const updater = { checkForUpdates: async () => ({ updateInfo: { version: '0.20.0' } }), downloadUpdate: async () => { if (++attempt === 1) throw new Error('socket hang up'); }, quitAndInstall: () => {}, on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener) } as unknown as Updater;
  const updates = new GitHubUpdates('0.19.1', 'app', () => {}, redirect('v0.20.0'), async () => updater);
  await updates.check('startup'); await updates.download('0.20.0'); await new Promise(r => setImmediate(r));
  assert.deepEqual(updates.status().stage, { state: 'failed', message: 'socket hang up' });
  await updates.download('0.20.0'); assert.equal(updates.status().stage.state, 'preparing');
});

test('the developer folder watcher accepts installer names from before and after 0.20.0', () => {
  assert.equal(installerPattern.exec('Kiln Setup 0.19.1.exe')?.[1], '0.19.1');
  assert.equal(installerPattern.exec('Kiln-Setup-0.20.0.exe')?.[1], '0.20.0');
  assert.equal(installerPattern.exec('Kiln-Setup-0.20.0.exe.blockmap'), null);
});
