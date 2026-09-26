import fs from 'node:fs';
import path from 'node:path';
import { app, net } from 'electron';
import { GitHubUpdates, type InstallKind, type Updater } from '../../packages/updates/github';
export { RELEASES } from '../../packages/updates/github';

/**
 * How this copy can take an update. Windows installs, AppImages and .deb packages update in place through electron-updater;
 * the .deb asks for the administrator password. macOS builds are not signed with an Apple Developer ID, which macOS requires
 * before an app may replace itself, so they (and the Linux tar.gz, which has no installer) download from the releases page.
 */
export function installKind(): InstallKind {
  if (!app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return 'download';
  if (process.platform === 'win32') return 'app';
  if (process.platform !== 'linux') return 'download';
  if (process.env.APPIMAGE) return 'app';
  try { return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim() === 'deb' ? 'app' : 'download'; } catch { return 'download'; }
}
/** electron-updater set to wait for the user: it never downloads or installs on its own. */
async function loadUpdater(log: (event: string, fields?: Record<string, unknown>) => void): Promise<Updater> {
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: () => {}, debug: () => {}, warn: (message: unknown) => log('update.warn', { message: String(message) }), error: (message: unknown) => log('update.error', { message: String(message) }) };
  return autoUpdater as unknown as Updater;
}
export function createGitHubUpdates(log: (event: string, fields?: Record<string, unknown>) => void) {
  return new GitHubUpdates(app.getVersion(), installKind(), log, (url, init) => net.fetch(url, init), () => loadUpdater(log));
}
