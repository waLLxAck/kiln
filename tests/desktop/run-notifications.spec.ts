import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopEnv } from './fixture';

/**
 * A stand-in `claude` on PATH. A run whose material says HOLD-<name> waits until the test writes <release>/<name>, then passes,
 * so the test decides when each run finishes. No real agent is contacted.
 */
function fakeClaude(root: string) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--version')) { console.log('9.9.9 (fake Claude Code)'); process.exit(0); }
let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'system', subtype: 'init', model: 'fake-model', session_id: '00000000-0000-4000-8000-000000000001' });
  const name = (input.match(/HOLD-(\\w+)/) || [])[1];
  const finish = () => emit({ type: 'result', is_error: false, result: '', structured_output: { output: 'FAKE OUTPUT', judgement: 'pass', note: 'It worked.' }, usage: { input_tokens: 10, output_tokens: 5 } });
  if (!name) return finish();
  const timer = setInterval(() => { if (fs.existsSync(path.join(process.env.KILN_FAKE_RELEASE, name))) { clearInterval(timer); finish(); } }, 100);
});
`, { mode: 0o755 });
  return bin;
}
const api = (page: Page, method: string, args?: unknown) => page.evaluate(([m, a]) => (window as any).kiln.call(m, a), [method, args] as const);
async function launch(root: string, experiments?: string) {
  const release = path.join(root, 'release'); fs.mkdirSync(release);
  const env = { ...desktopEnv(root), KILN_DESKTOP_DATA: path.join(root, 'desktop'), KILN_FAKE_RELEASE: release, PATH: `${fakeClaude(root)}${path.delimiter}${process.env.PATH}`, ...(experiments ? { KILN_EXPERIMENTS: experiments } : {}) };
  const app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: 'Refresh library', exact: true })).toBeVisible();
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox; });
  const items: Record<string, string> = {};
  for (const name of ['Alpha', 'Beta', 'Gamma']) items[name] = (await api(page, 'items.create', { title: `${name} fixture`, kind: 'prompt', content: `Summarise this. HOLD-${name}` }) as { id: string }).id;
  await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
  const start = async (name: string) => { const job = await api(page, 'agent.start', { id: items[name], kind: 'trial', provider: 'claude' }); await page.evaluate(() => window.dispatchEvent(new CustomEvent('kiln:agent-started'))); return job as { id: string; status: string }; };
  const release_ = (name: string) => fs.writeFileSync(path.join(release, name), '');
  const status = async (id: string) => (await api(page, 'agent.jobs') as { id: string; status: string }[]).find(j => j.id === id)?.status;
  return { app, page, items, start, release: release_, status };
}
const heading = (page: Page) => page.locator('.detail-heading h1');
const activeTab = (page: Page) => page.locator('.detail-tabs button.active');
/** Stub desktop notifications in main: record them instead of showing, and say whether the window is in front. */
const stubNotifications = (app: ElectronApplication, focused: boolean) => app.evaluate(({ BrowserWindow, Notification }, focused) => {
  const state = globalThis as any; state.notices ??= [];
  Notification.isSupported = () => true;
  Notification.prototype.show = function (this: Electron.Notification) { state.notices.push(this); };
  const main = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('#palette'))!;
  main.isFocused = () => focused; // The test machine's window manager decides real focus, so pin it.
}, focused);
const noticeTitles = (app: ElectronApplication) => app.evaluate(() => ((globalThis as any).notices ?? []).map((n: Electron.Notification) => n.title));

test('runNotifications: runs list with Cancel, a queue beyond two runs, a toast with Open result, and a notification while Kiln is behind', async () => {
  test.skip(process.platform === 'win32', 'The fake Claude Code CLI is a POSIX script');
  test.setTimeout(150_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-run-notifications-ui-'));
  const { app, page, start, release, status } = await launch(root, 'runNotifications');
  try {
    await stubNotifications(app, true);
    await start('Alpha');
    const pill = page.getByRole('button', { name: /Claude Code working/ });
    await pill.click();
    const runs = page.getByRole('dialog', { name: 'Agent runs' });
    await expect(runs).toBeVisible();
    const alpha = runs.getByRole('listitem', { name: 'Experiment · Alpha fixture' });
    await expect(alpha.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(alpha).toContainText('Claude Code');
    await page.keyboard.press('Escape');
    await expect(runs).toHaveCount(0);
    await expect(pill).toBeFocused();

    // A third run waits for a free slot instead of being refused, and starts by itself when one frees.
    await start('Beta');
    const gamma = await start('Gamma');
    expect(gamma.status).toBe('queued');
    await expect(pill).toContainText('· 1 queued');
    await pill.click();
    const gammaRow = runs.getByRole('listitem', { name: 'Experiment · Gamma fixture' });
    await expect(gammaRow.locator('.badge')).toHaveText('queued');
    await expect(gammaRow).toContainText('Waiting for a free slot');
    await expect(gammaRow.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Focused window: no desktop notification, a toast with Open result instead; the undo and message toasts are left alone.
    release('Alpha');
    const toast = page.locator('.run-toast');
    await expect(toast).toContainText('Experiment passed · Alpha fixture', { timeout: 30_000 });
    await expect.poll(() => status(gamma.id), { timeout: 30_000 }).toBe('running');
    expect(await noticeTitles(app)).toEqual([]);
    await toast.getByRole('button', { name: 'Open result' }).click();
    await expect(heading(page)).toHaveText('Alpha fixture');
    await expect(activeTab(page)).toHaveText(/trials/);
    await expect(toast).toHaveCount(0);

    // Behind another window: the notification says what finished, and clicking it opens the result.
    await stubNotifications(app, false);
    release('Beta');
    await expect.poll(() => noticeTitles(app), { timeout: 30_000 }).toEqual(['Experiment passed · Beta fixture']);
    await app.evaluate(() => { const notices = (globalThis as any).notices; notices.at(-1).emit('click'); });
    await expect(heading(page)).toHaveText('Beta fixture');
    await expect(activeTab(page)).toHaveText(/trials/);
    await stubNotifications(app, true);

    // The recent runs button stays once nothing is running, and lists what finished.
    release('Gamma');
    await expect(toast).toContainText('Experiment passed · Gamma fixture', { timeout: 30_000 });
    await expect(pill).toHaveCount(0);
    await page.getByRole('button', { name: 'Recent runs' }).click();
    await expect(runs.getByRole('list', { name: 'Finished runs' }).getByRole('listitem')).toHaveCount(3);
    await expect(runs.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await runs.getByRole('listitem', { name: 'Experiment · Gamma fixture' }).getByRole('button', { name: 'Open' }).click();
    await expect(heading(page)).toHaveText('Gamma fixture');
    expect(await noticeTitles(app)).toEqual(['Experiment passed · Beta fixture']);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('runNotifications off: the pill opens the first run, a third run is refused, and no toast or notification appears', async () => {
  test.skip(process.platform === 'win32', 'The fake Claude Code CLI is a POSIX script');
  test.setTimeout(120_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-run-notifications-off-'));
  const { app, page, items, start, release, status } = await launch(root);
  try {
    await stubNotifications(app, false);
    const alpha = await start('Alpha'); await start('Beta');
    const refused = await page.evaluate(async id => { try { await (window as any).kiln.call('agent.start', { id, kind: 'trial', provider: 'claude' }); return ''; } catch (error) { return String(error); } }, items.Gamma);
    expect(refused).toMatch(/Two agent runs are active/);
    const pill = page.getByRole('button', { name: /Claude Code working/ });
    await pill.click();
    await expect(page.getByRole('dialog', { name: 'Agent runs' })).toHaveCount(0);
    await expect(heading(page)).toHaveText(/Alpha fixture|Beta fixture/);
    release('Alpha'); release('Beta');
    await expect.poll(() => status(alpha.id), { timeout: 30_000 }).toBe('completed');
    await expect(pill).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    await expect(page.locator('.run-toast')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Recent runs' })).toHaveCount(0);
    expect(await noticeTitles(app)).toEqual([]);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
