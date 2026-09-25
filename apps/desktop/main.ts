import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, screen, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { AgentConsent, agentConsentDetail, usesAgent } from './agent-consent';
import { Backend } from './backend';
import { createDiagnostics } from './diagnostics';
import type { Revision, UpdateStatus } from '../../packages/protocol/schema';

import { invariant, WorkbenchError } from '../../packages/domain/errors';
import { idSchema, hashSchema } from '../../packages/protocol/schema';
import { resolveVariables } from '../../packages/domain/content';
import { atomicWrite, noLinks, now, readJson, writeJson } from '../../packages/storage/files';
import { defaultLibrary, privateRoot, selectLibrary } from '../../packages/storage/config';
import { InstallerUpdates, installerPattern as INSTALLER, newerVersion } from '../../packages/updates/service';
import { desktopPath } from '../../packages/providers/path';

protocol.registerSchemesAsPrivileged([{ scheme: 'kiln', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.KILN_LOCAL || process.env.KILN_DESKTOP_DATA) {
  const isolatedUserData = process.env.KILN_DESKTOP_DATA ?? path.join(process.env.KILN_LOCAL!, 'desktop');
  fs.mkdirSync(isolatedUserData, { recursive: true }); app.setPath('userData', isolatedUserData);
}
let main: BrowserWindow;
let palette: BrowserWindow | undefined;
let tray: Tray;
let backend: Backend;
let local = '';
let canonical = '';
const diagnostics = createDiagnostics(path.join(app.getPath('userData'), 'logs'));
const log = diagnostics.log;
const agentConsent = new AgentConsent(path.join(app.getPath('userData'), 'agent-consent.json'));
const updates = new InstallerUpdates(path.join(app.getPath('userData'), 'updates'), app.getVersion(), log);
let quitting = false;
const devUrl = process.env.KILN_DEV_URL;
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', () => { main?.show(); main?.focus(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); backend?.close(); });

function createWindow(compact: boolean) {
  const window = new BrowserWindow({ width: compact ? 740 : 1440, height: compact ? 500 : 940, minWidth: compact ? 600 : 1000, minHeight: compact ? 350 : 650, show: false, icon: path.join(app.getAppPath(), 'assets/kiln.png'), title: 'Kiln', backgroundColor: '#f5f5f8', autoHideMenuBar: true, ...(compact ? { frame: false, resizable: false, skipTaskbar: true } : {}), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('unresponsive', () => log('window.unresponsive', { compact }));
  window.on('responsive', () => log('window.responsive', { compact }));
  window.webContents.on('render-process-gone', (_event, details) => log('renderer.gone', { compact, reason: details.reason, exitCode: details.exitCode }));
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  void window.loadURL(devUrl ? `${devUrl}${compact ? '/#palette' : ''}` : `kiln://app/index.html${compact ? '#palette' : ''}`);
  if (!compact) window.once('ready-to-show', () => window.show());
  return window;
}
function openPalette() {
  if (!palette || palette.isDestroyed()) palette = createWindow(true);
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  palette.setPosition(Math.round(area.x + (area.width - 740) / 2), Math.round(area.y + area.height * .2));
  palette.show(); palette.focus();
}
async function registerShortcut(shortcut: string) {
  const previous = (await backend.call('settings')).shortcut;
  globalShortcut.unregisterAll();
  let registered = false;
  try { registered = globalShortcut.register(shortcut, openPalette); } catch { /* Invalid accelerator is surfaced below. */ }
  if (!registered) {
    try { globalShortcut.register(previous, openPalette); } catch { /* Settings remain unchanged when neither shortcut is available. */ }
    throw new WorkbenchError('SHORTCUT_UNAVAILABLE', 'This shortcut is invalid or already in use. Choose another in Settings.');
  }
}
async function pickDirectory() { const result = await dialog.showOpenDialog(main, { properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0]; }
/** Newest installer in the update source (its top level or one folder down, matching `release/<version>/`) whose version is above the running app. Local files only; nothing is downloaded. */
/** Where this build was made, recorded by scripts/build.mjs. Lets the installed app default to that repository's release folder. */
function buildInfo(): { sourceRoot?: string; releaseDir?: string; commit?: string; builtAt?: string } {
  try { return readJson(path.join(app.getAppPath(), 'dist', 'build-info.json')) as ReturnType<typeof buildInfo>; } catch { return {}; }
}
/** The in-app updater runs the Windows NSIS installer. macOS and Linux builds are updated from the releases page instead. */
const updaterSupported = process.platform === 'win32';
function checkUpdate(): UpdateStatus {
  const current = app.getVersion(), status: UpdateStatus = { current, source: '', sourceKind: 'none', packaged: app.isPackaged, available: null, stage: updates.status(), commit: buildInfo().commit ?? '', supported: updaterSupported };
  if (!updaterSupported) return status;
  const file = path.join(local, 'settings.json'); const chosen = fs.existsSync(file) ? String((readJson(file) as { updateSource?: string }).updateSource ?? '') : '';
  // An explicit folder wins; otherwise the release folder of the repository this build came from; "off" disables checks.
  const source = chosen === 'off' ? '' : chosen || buildInfo().releaseDir || '';
  status.source = source; status.sourceKind = chosen === 'off' ? 'off' : chosen ? 'setting' : source ? 'build' : 'none'; if (!source) return status;
  try {
    if (!fs.existsSync(source)) return { ...status, error: 'The update folder does not exist.' };
    const candidates: { version: string; path: string }[] = [];
    const scan = (folder: string, depth: number) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isFile()) { const match = entry.name.match(INSTALLER); if (match) candidates.push({ version: match[1], path: full }); } else if (entry.isDirectory() && depth > 0 && !entry.isSymbolicLink()) scan(full, depth - 1); } };
    scan(source, 1);
    candidates.sort((a, b) => newerVersion(a.version, b.version) ? -1 : newerVersion(b.version, a.version) ? 1 : 0);
    status.available = candidates.find(c => newerVersion(c.version, current)) ?? null;
  } catch (error) { status.error = error instanceof Error ? error.message : String(error); }
  return status;
}
async function desktopCall(method: string, args: unknown, sender: BrowserWindow) {
  if (usesAgent(method, args)) await agentConsent.require(() => dialog.showMessageBox(sender, {
    type: 'warning', title: 'Using your agent CLI', message: 'Allow Kiln to run your installed agent CLI?',
    detail: agentConsentDetail(),
    buttons: ['Cancel', 'Agree and continue'], defaultId: 0, cancelId: 0, checkboxLabel: "Don’t show again", checkboxChecked: false,
  }));
  switch (method) {
    case 'desktop.resetAgentConsent': agentConsent.reset(); return true;
    case 'desktop.exportSession': {
      const { id } = z.object({ id: idSchema }).parse(args);
      const answer = await dialog.showMessageBox(sender, { type: 'warning', title: 'Export private conversation', message: 'This transcript may contain private messages, local paths and tool output.', detail: 'Exporting creates a separate file for you to review and share. It will not be added to your library or pushed to GitHub.', buttons: ['Cancel', 'Export conversation'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return null;
      const result = await dialog.showSaveDialog(sender, { defaultPath: 'kiln-conversation.jsonl', filters: [{ name: 'Session transcript', extensions: ['jsonl'] }] });
      if (result.canceled || !result.filePath) return null;
      const text = await backend.call<string>('rpc', 'agent.exportSession', { id });
      atomicWrite(result.filePath, text); return { destination: result.filePath };
    }
    case 'desktop.theme': { const value = z.object({ theme: z.enum(['light','dark','system']) }).parse(args); const file = path.join(local, 'settings.json'); const previous = fs.existsSync(file) ? readJson(file) as object : {}; writeJson(file, { ...previous, ...value }); return value; }
    case 'desktop.openUrl': {
      // Only the pages setup needs; everything else the user opens from their own items.
      const { url } = z.object({ url: z.string().url() }).parse(args);
      invariant(['https://cli.github.com/', 'https://github.com/'].some(prefix => url.startsWith(prefix)), 'INVALID_URL', 'Only GitHub pages can be opened from here.');
      await shell.openExternal(url); return true;
    }
    case 'desktop.openContentUrl': {
      const { url } = z.object({ url: z.string().url() }).parse(args);
      invariant(['https:', 'http:'].includes(new URL(url).protocol), 'INVALID_URL', 'Only web links can be opened.');
      await shell.openExternal(url); return true;
    }
    case 'desktop.agentSettings': { const value = z.object({ codexModel: z.string().max(80), codexEffort: z.string().max(20), commitModel: z.string().max(80).optional(), commitEffort: z.string().max(20).optional() }).parse(args); const file = path.join(local, 'settings.json'); const previous = fs.existsSync(file) ? readJson(file) as object : {}; writeJson(file, { ...previous, ...value }); return value; }
    case 'desktop.openAgentJob': { const { id } = z.object({ id: idSchema }).parse(args); const folder = path.join(local, 'agent-jobs', id); noLinks(folder); const error = await shell.openPath(folder); invariant(!error, 'OPEN_FAILED', error); return true; }
    case 'desktop.openLogs': { await diagnostics.flush(); const error = await shell.openPath(diagnostics.folder); invariant(!error, 'OPEN_FAILED', error); return true; }
    case 'desktop.telemetry': {
      const value = z.object({ event: z.enum(['renderer.stall', 'renderer.longTask', 'renderer.error', 'renderer.rejection', 'renderer.click']), durationMs: z.number().min(0).max(86400000).optional(), target: z.string().max(80).optional() }).parse(args);
      log(value.event, { durationMs: value.durationMs, target: value.target, window: sender === main ? 'main' : 'palette' }); return true;
    }
    case 'desktop.chooseDirectory': return pickDirectory();
    case 'desktop.updateCheck': return checkUpdate();
    case 'desktop.updateSource': {
      // Choose the folder to watch for installers; an empty choice clears it.
      // clear: back to the build's own release folder; off: stop checking; path: use that folder; otherwise ask.
      const value = z.object({ clear: z.boolean().default(false), off: z.boolean().default(false), path: z.string().min(1).max(1000).optional() }).parse(args ?? {});
      if (value.path) invariant(fs.existsSync(value.path) && fs.statSync(value.path).isDirectory(), 'INVALID_FOLDER', 'The update folder does not exist.');
      const chosen = value.off ? 'off' : value.clear ? '' : value.path ?? await pickDirectory(); if (chosen === null) return checkUpdate();
      const file = path.join(local, 'settings.json'); const previous = fs.existsSync(file) ? readJson(file) as object : {}; writeJson(file, { ...previous, updateSource: chosen }); return checkUpdate();
    }
    case 'desktop.updatePrepare': {
      invariant(updaterSupported, 'UPDATE_UNSUPPORTED', 'In-app updates are only available on Windows. Download the new version from the releases page.');
      const status = checkUpdate(); invariant(status.available, 'NO_UPDATE', 'No newer installer was found in the update folder.');
      const { version } = z.object({ version: z.string() }).parse(args);
      invariant(status.available.version === version, 'UPDATE_CHANGED', 'The available update changed. Check again before preparing it.');
      updates.prepare(status.available);
      return checkUpdate();
    }
    case 'desktop.updateRestart': {
      invariant(updaterSupported, 'UPDATE_UNSUPPORTED', 'In-app updates are only available on Windows. Download the new version from the releases page.');
      await updates.restart(installer => new Promise<void>((resolve, reject) => {
        const child = spawn(installer, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      }), () => { setTimeout(() => { quitting = true; app.quit(); }, 400); });
      return true;
    }
    case 'desktop.palette': openPalette(); return true;
    case 'desktop.hide': sender.hide(); return true;
    case 'desktop.workbench': {
      const { id } = z.object({ id: idSchema.optional() }).parse(args);
      if (id) {
        await backend.call('rpc', 'items.read', { id });
        await main.webContents.executeJavaScript(`location.hash = ${JSON.stringify('item=' + encodeURIComponent(id) + '&open=' + Date.now())}`);
      }
      main.show(); main.focus(); palette?.hide(); return true;
    }
    case 'desktop.attach': {
      const { root } = z.object({ root: z.string().min(1) }).parse(args); noLinks(root);
      ({ local, canonical } = await backend.call('attach', root)); selectLibrary(root);
      return backend.call('snapshot');
    }
    case 'desktop.copy': {
      const a = z.object({ id: idSchema, revision: hashSchema, variables: z.record(z.string(), z.string()).default({}) }).parse(args);
      const revision = await backend.call<Revision>('getRevision', a.id, a.revision); const text = resolveVariables(revision.content, a.variables);
      if (revision.kind === 'image') {
        const asset = Object.entries(revision.files).find(([name]) => /\.(png|jpe?g|gif|webp)$/i.test(name));
        invariant(asset, 'ASSET_MISSING', 'This item has no supported image.');
        const image = nativeImage.createFromBuffer(Buffer.from(asset[1], 'base64'));
        invariant(!image.isEmpty(), 'INVALID_IMAGE', 'The imported bytes are not a supported image.'); await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
      } else await clipboard.writeText(text);
      await backend.call('observe', { schemaVersion: 1, eventId: randomUUID(), itemId: a.id, revision: a.revision, kind: 'copied', source: 'kiln', confidence: 'observed', occurredAt: now() }); return true;
    }
    case 'desktop.copyTrial': {
      const { id } = z.object({ id: idSchema }).parse(args); const file = path.join(local, 'runs', id, 'prompt.md'); noLinks(file);
      invariant(fs.existsSync(file), 'LOCAL_OUTPUT_MISSING', 'This run folder belongs to another machine or was removed.');
      await clipboard.writeText(fs.readFileSync(file, 'utf8')); return true;
    }
    case 'desktop.copyConversion': {
      const a = z.object({ id: idSchema, revision: hashSchema }).parse(args);
      const revision = await backend.call<Revision>('getRevision', a.id, a.revision);
      await clipboard.writeText(`Use the source prompt from Kiln item ${a.id}, revision ${a.revision}. Propose a reusable skill with: name, description, trigger, required inputs, repeatable procedure, checks, limitations. Do not approve or install it.\n\n${revision.content}`);
      return true;
    }
    case 'desktop.openRun': {
      const { id } = z.object({ id: idSchema }).parse(args); const folder = path.join(local, 'runs', id); noLinks(folder);
      invariant(fs.existsSync(folder), 'LOCAL_OUTPUT_MISSING', 'This run folder is unavailable on this machine.');
      const error = await shell.openPath(folder); invariant(!error, 'OPEN_FAILED', error); return true;
    }
    case 'desktop.trialOutput': {
      const { id } = z.object({ id: idSchema }).parse(args); const folder = path.join(local, 'runs', id); noLinks(folder);
      const read = (name: string) => fs.existsSync(path.join(folder, name)) ? fs.readFileSync(path.join(folder, name), 'utf8') : '';
      return { output: read('output.md'), reference: read('output-reference.json'), prompt: read('prompt.md') };
    }
    case 'desktop.openItem': {
      const { id } = z.object({ id: idSchema }).parse(args); const revision = await backend.call<Revision>('getRevision', id);
      const firstLine = revision.content.trim().split('\n')[0];
      // Links always open in the browser; tools and resources distilled from videos do too when they lead with their URL.
      if (revision.kind === 'link' || (['tool', 'resource'].includes(revision.kind) && /^https?:\/\/\S+$/i.test(firstLine))) { const url = new URL(firstLine); invariant(['https:', 'http:'].includes(url.protocol), 'INVALID_URL', 'Only web URLs can be opened.'); await shell.openExternal(url.href); }
      else if (revision.kind === 'reference') { shell.showItemInFolder(await backend.call('referencePath', id)); }
      else if (['image', 'file'].includes(revision.kind)) {
        const asset = Object.entries(revision.files)[0]; invariant(asset, 'ASSET_MISSING', 'No imported asset is attached.');
        const file = path.join(local, 'previews', revision.hash, path.basename(asset[0])); atomicWrite(file, Buffer.from(asset[1], 'base64')); shell.showItemInFolder(file);
      } else shell.showItemInFolder(path.join(path.join(canonical, 'items', id), 'content.md'));
      await backend.call('observe', { schemaVersion: 1, eventId: randomUUID(), itemId: id, revision: revision.hash, kind: 'opened', source: 'kiln', confidence: 'observed', occurredAt: now() }); return true;
    }
    case 'desktop.importFile': {
      const { kind } = z.object({ kind: z.enum(['image', 'file', 'reference']) }).parse(args);
      const result = await dialog.showOpenDialog(main, { properties: ['openFile'], ...(kind === 'image' ? { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] } : {}) });
      return result.canceled ? null : backend.call('importFile', result.filePaths[0], kind);
    }
    case 'desktop.importResource': {
      const a = z.object({ root: z.string(), relative: z.string() }).parse(args);
      return backend.call('importResource', a.root, a.relative);
    }
    case 'desktop.addAttachment': {
      const a = z.object({ id: idSchema, expect: hashSchema, relative: z.string().min(1) }).parse(args);
      const result = await dialog.showOpenDialog(main, { properties: ['openFile'] });
      return result.canceled ? null : backend.call('addAttachment', a.id, a.expect, result.filePaths[0], a.relative);
    }
    case 'desktop.removeAttachment': {
      const a = z.object({ id: idSchema, expect: hashSchema, relative: z.string().min(1) }).parse(args);
      return backend.call('removeAttachment', a.id, a.expect, a.relative);
    }
    case 'desktop.importBundle': {
      const result = await dialog.showOpenDialog(main, { properties: ['openFile'], filters: [{ name: 'Kiln export', extensions: ['json'] }] });
      return result.canceled ? null : backend.call('importLibrary', result.filePaths[0]);
    }
    case 'desktop.export': {
      const result = await dialog.showSaveDialog(main, { defaultPath: `kiln-export-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Kiln export', extensions: ['json'] }] });
      return result.canceled || !result.filePath ? null : backend.call('exportLibrary', result.filePath);
    }
    case 'desktop.revealPath': {
      // Only paths inside an enrolled environment can be revealed; nothing is launched.
      const { path: target } = z.object({ path: z.string().min(1) }).parse(args); const targets = await backend.call<{ root: string }[]>('rpc', 'targets.list');
      invariant(targets.some(t => path.resolve(target).toLowerCase().startsWith(path.resolve(t.root).toLowerCase() + path.sep)), 'INVALID_PATH', 'This path is outside every enrolled environment.');
      invariant(fs.existsSync(target), 'OPEN_FAILED', 'This folder no longer exists.'); shell.showItemInFolder(path.resolve(target)); return true;
    }
    case 'desktop.chooseFile': {
      // Any text file on this machine can be added to the Config files tab; the picker is the only way to name one.
      const result = await dialog.showOpenDialog(main, { properties: ['openFile'], filters: [{ name: 'Text files', extensions: ['md', 'txt', 'ps1', 'psm1', 'json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sh'] }, { name: 'All files', extensions: ['*'] }] });
      return result.canceled ? null : result.filePaths[0];
    }
    case 'desktop.revealHomeFile': {
      // Only files the Config files tab lists can be revealed or opened; scripts are revealed, never run.
      const { key, open } = z.object({ key: z.string().min(1).max(120), open: z.boolean().default(false) }).parse(args);
      const file = await backend.call<{ path: string; exists: boolean }>('rpc', 'home.read', { key });
      invariant(file.exists, 'OPEN_FAILED', 'This file does not exist yet. Create it first.');
      if (open && /\.(md|txt|json|ya?ml|toml|ini|cfg|conf)$/i.test(file.path)) { const error = await shell.openPath(file.path); invariant(!error, 'OPEN_FAILED', error); }
      else shell.showItemInFolder(file.path);
      return true;
    }
    case 'desktop.openAttachment': {
      // Documents and images open in their default app; anything executable is only revealed in Explorer.
      const a = z.object({ id: idSchema, relative: z.string().min(1) }).parse(args); const revision = await backend.call<Revision>('getRevision', a.id);
      const content = revision.files[a.relative]; invariant(content, 'ASSET_MISSING', 'This file is not part of the current revision.');
      const file = path.join(local, 'previews', revision.hash, ...a.relative.split('/')); atomicWrite(file, Buffer.from(content, 'base64'));
      if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|pdf|txt|md|json|csv|ya?ml|toml)$/i.test(a.relative)) { const error = await shell.openPath(file); invariant(!error, 'OPEN_FAILED', error); }
      else shell.showItemInFolder(file);
      return true;
    }
    case 'desktop.settings': {
      const value = z.object({ shortcut: z.string().min(1), launchAtLogin: z.boolean(), theme: z.enum(['light', 'dark', 'system']), agentProvider: z.enum(['codex', 'claude']).default('codex') }).parse(args);
      await registerShortcut(value.shortcut); app.setLoginItemSettings({ openAtLogin: value.launchAtLogin }); return backend.call('saveSettings', { ...(await backend.call('settings')), ...value });
    }
    default: return backend.call('rpc', method, args);
  }
}

if (singleInstance) void app.whenReady().then(async () => {
  // Apps opened from the Dock, Finder or a desktop launcher get a minimal PATH; take the login shell's so codex, claude, git and gh are found.
  // Set before the backend worker starts, which copies the environment.
  if (app.isPackaged && process.platform !== 'win32') { process.env.PATH = await desktopPath(); log('path.resolved', { entries: process.env.PATH.split(':').length }); }
  // The CLI bundle is unpacked from the asar so a chat agent can run it with this executable acting as Node.
  backend = new Backend(defaultLibrary(), privateRoot(), log, { node: process.execPath, script: app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'cli', 'workbench.cjs') : path.join(app.getAppPath(), 'dist', 'cli', 'workbench.cjs') });
  ({ local, canonical } = await backend.call('paths'));
  log('app.started', { version: app.getVersion(), pid: process.pid });
  let tick = Date.now();
  setInterval(() => { const elapsed = Date.now() - tick; tick = Date.now(); if (elapsed > 1500) log('main.stall', { durationMs: elapsed - 1000 }); }, 1000).unref();
  setInterval(() => log('app.load', { memory: process.memoryUsage(), processes: app.getAppMetrics().map(p => ({ type: p.type, cpu: p.cpu.percentCPUUsage, memory: p.memory })) }), 15000).unref();
  protocol.handle('kiln', request => {
    const url = new URL(request.url); invariant(url.host === 'app', 'INVALID_ORIGIN', 'Unknown app origin.');
    const root = path.resolve(__dirname, '../renderer');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    invariant(file.startsWith(root + path.sep), 'INVALID_PATH', 'Invalid app resource.');
    return net.fetch(pathToFileURL(file).href);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle('kiln:call', async (event, method: unknown, args: unknown) => {
    const started = Date.now(); const requestId = randomUUID(); let operation = '';
    try {
      const sender = BrowserWindow.fromWebContents(event.sender);
      invariant(sender && (sender === main || sender === palette) && event.senderFrame === event.sender.mainFrame, 'INVALID_SENDER', 'Unknown request sender.');
      const url = new URL(event.senderFrame.url);
      invariant(devUrl ? url.origin === new URL(devUrl).origin : url.protocol === 'kiln:' && url.host === 'app', 'INVALID_ORIGIN', 'Request from an untrusted page.');
      const name = z.string().max(100).parse(method); operation = name;
      if (name !== 'desktop.telemetry') log('request.started', { requestId, method: name });
      return { ok: true, data: await desktopCall(name, args ?? {}, sender) };
    } catch (error) {
      log('request.failed', { requestId, method: operation, code: error instanceof WorkbenchError ? error.code : 'OPERATION_FAILED' });
      return { ok: false, error: { code: error instanceof WorkbenchError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) } };
    } finally { if (operation && operation !== 'desktop.telemetry') log('request.finished', { requestId, method: operation, durationMs: Date.now() - started }); }
  });
  main = createWindow(false);
  // macOS menu bar icons are monochrome templates that the system tints; Windows and Linux use the colour logo.
  const icon = process.platform === 'darwin' ? nativeImage.createFromPath(path.join(app.getAppPath(), 'assets/kilnTemplate.png')) : nativeImage.createFromPath(path.join(app.getAppPath(), 'assets/kiln.png')).resize({ width: 20, height: 20 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon); tray.setToolTip('Kiln · Prompt & Skill Workbench');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Kiln', click: () => main.show() }, { label: 'Quick search', click: openPalette }, { type: 'separator' }, { label: 'Quit Kiln', click: () => app.quit() }]));
  tray.on('double-click', () => main.show());
  try { await registerShortcut((await backend.call('settings')).shortcut); } catch (error) { log('shortcut.failed'); }
  app.on('activate', () => main.show());
}).catch(error => { console.error('Kiln startup failed:', error); dialog.showErrorBox('Kiln could not start', String(error)); app.quit(); });
