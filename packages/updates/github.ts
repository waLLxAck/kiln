import type { UpdateStage } from '../protocol/schema';
import { invariant } from '../domain/errors';
import { newerVersion } from './service';

export const RELEASES = 'https://github.com/waLLxAck/kiln/releases';
/** First check shortly after launch, then on a slow timer. A check is one small request to github.com; nothing is scanned or indexed. */
export const FIRST_CHECK_MS = 15_000, CHECK_EVERY_MS = 30 * 60_000;
/** app: downloads and installs in place; download: the new version is downloaded from its release page by hand. */
export type InstallKind = 'app' | 'download';
type Fetch = (url: string, init: { method: string; redirect: 'follow'; cache: 'no-store' }) => Promise<{ status: number; url: string; headers: { get(name: string): string | null } }>;

/**
 * Newest published version: github.com redirects /releases/latest to the release's tag page, so one HEAD request answers it without
 * the rate-limited API. The redirect is followed (Electron's net.fetch cancels a manual one) and the tag read from the final URL.
 */
export async function latestRelease(fetcher: Fetch): Promise<{ version: string; url: string } | null> {
  const response = await fetcher(`${RELEASES}/latest`, { method: 'HEAD', redirect: 'follow', cache: 'no-store' });
  const location = response.url.includes('/releases/tag/') ? response.url : response.headers.get('location') ?? '';
  const version = location.match(/\/releases\/tag\/v?(\d+\.\d+\.\d+)$/)?.[1];
  return version ? { version, url: `${RELEASES}/tag/v${version}` } : null;
}

/** The parts of electron-updater's AppUpdater this uses, so tests can stand in for it. */
export type Updater = {
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(event: 'download-progress', listener: (info: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
};
type Log = (event: string, fields?: Record<string, unknown>) => void;
/** Checks GitHub releases on a timer and, where the platform allows, downloads and installs them when the user asks. Never downloads on its own. */
export class GitHubUpdates {
  private stage: UpdateStage = { state: 'idle' };
  private latest: { version: string; url: string } | null = null;
  private checkedAt = '';
  private error = '';
  private checking?: Promise<void>;
  private updater?: Promise<Updater>;
  private timers: ReturnType<typeof setTimeout>[] = [];
  constructor(private current: string, readonly install: InstallKind, private log: Log, private fetcher: Fetch, private loadUpdater: () => Promise<Updater>) {}
  /** The updater is loaded on first use, not at startup. */
  private load() {
    return this.updater ??= this.loadUpdater().then(updater => {
      updater.on('download-progress', ({ percent }) => { if (this.stage.state === 'preparing') this.stage = { ...this.stage, progress: Math.min(99, Math.floor(percent)) }; });
      updater.on('update-downloaded', ({ version }) => { this.stage = { state: 'ready', version }; this.log('update.downloaded', { version }); });
      updater.on('error', error => { if (this.stage.state === 'preparing') this.stage = { state: 'failed', message: error.message }; });
      return updater;
    });
  }
  start() {
    if (this.timers.length) return;
    this.timers.push(setTimeout(() => void this.check('startup'), FIRST_CHECK_MS), setInterval(() => void this.check('timer'), CHECK_EVERY_MS));
  }
  stop() { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }
  /** One check at a time; a download in progress or waiting for a restart is not interrupted. */
  check(reason: string): Promise<void> {
    if (this.stage.state === 'preparing' || this.stage.state === 'ready') return Promise.resolve();
    return this.checking ??= (async () => {
      try {
        const release = this.install === 'app' ? await this.load().then(u => u.checkForUpdates()).then(r => r ? { version: r.updateInfo.version, url: `${RELEASES}/tag/v${r.updateInfo.version}` } : null) : await latestRelease(this.fetcher);
        this.latest = release && newerVersion(release.version, this.current) ? release : null;
        this.error = ''; this.log('update.checked', { reason, available: this.latest?.version ?? null });
      } catch (error) { this.error = `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`; this.log('update.checkFailed', { reason, message: this.error }); }
      finally { this.checkedAt = new Date().toISOString(); this.checking = undefined; }
    })();
  }
  status() { return { available: this.latest ? { version: this.latest.version, path: this.latest.url } : null, stage: this.stage, checkedAt: this.checkedAt, error: this.error }; }
  async download(version: string) {
    invariant(this.install === 'app', 'UPDATE_UNSUPPORTED', 'This copy of Kiln updates from the releases page. Download the new version there.');
    invariant(this.latest?.version === version, 'UPDATE_CHANGED', 'The available update changed. Check again before downloading it.');
    if (this.stage.state === 'preparing' || this.stage.state === 'ready') return;
    this.stage = { state: 'preparing', version, progress: 0 };
    const updater = await this.load();
    void updater.downloadUpdate().catch((error: Error) => { this.stage = { state: 'failed', message: error.message }; this.log('update.downloadFailed', { message: error.message }); });
  }
  /** Quits and installs silently; Kiln starts again afterwards. `quitting` lets the windows close instead of hiding. */
  async restart(quitting: () => void) {
    invariant(this.stage.state === 'ready', 'UPDATE_NOT_READY', 'Download the update before restarting.');
    const updater = await this.load();
    this.log('update.restart', { from: this.current, to: this.stage.version });
    quitting(); this.stop();
    setImmediate(() => updater.quitAndInstall(true, true));
  }
}
