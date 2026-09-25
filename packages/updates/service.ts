import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { UpdateStage } from '../protocol/schema';
import { invariant } from '../domain/errors';
import { noLinks, readJson, writeJson } from '../storage/files';

export const installerPattern = /^Kiln Setup (\d+\.\d+\.\d+)\.exe$/i;
export const newerVersion = (a: string, b: string) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
};
const preparedSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), folder: z.string().uuid(), size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
type Prepared = z.infer<typeof preparedSchema>;

async function checksum(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Staging never starts an installer. Only restart() may launch one, after a fresh integrity check. */
export class InstallerUpdates {
  private stage: UpdateStage = { state: 'idle' };
  private prepared?: Prepared;
  private pending?: Promise<void>;
  private restarting = false;
  private readonly manifest: string;
  constructor(private root: string, private current: string, private log: (event: string, fields?: Record<string, unknown>) => void = () => {}) {
    this.manifest = path.join(root, 'ready.json');
    try {
      noLinks(this.manifest);
      if (!fs.existsSync(this.manifest)) return;
      const record = preparedSchema.parse(readJson(this.manifest));
      if (!newerVersion(record.version, current)) { fs.unlinkSync(this.manifest); this.removePrepared(record); return; }
      const file = this.installer(record); noLinks(file);
      invariant(fs.statSync(file).size === record.size, 'UPDATE_MISSING', 'The prepared update is incomplete. Prepare it again.');
      this.prepared = record; this.stage = { state: 'ready', version: record.version };
    } catch { this.stage = { state: 'failed', message: 'The prepared update is missing or incomplete. Prepare it again.' }; }
  }
  private installer(record: Prepared) { return path.join(this.root, record.folder, `Kiln Setup ${record.version}.exe`); }
  private removePrepared(record: Prepared) {
    try { const file = this.installer(record); noLinks(file); fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)); } catch { /* Windows may still hold the installer open; leave it for manual cleanup. */ }
  }
  status(): UpdateStage { return this.stage; }
  prepare(candidate: { version: string; path: string }) {
    invariant(!this.restarting, 'UPDATE_BUSY', 'The update is already restarting.');
    if (this.pending || (this.prepared?.version === candidate.version && this.stage.state === 'ready')) return this.stage;
    invariant(newerVersion(candidate.version, this.current) && installerPattern.exec(path.basename(candidate.path))?.[1] === candidate.version, 'INVALID_INSTALLER', 'Choose a newer Kiln installer.');
    this.stage = { state: 'preparing', version: candidate.version, progress: 0 };
    this.pending = this.copy(candidate).finally(() => { this.pending = undefined; });
    return this.stage;
  }
  private async copy(candidate: { version: string; path: string }) {
    const folder = randomUUID(), destination = path.join(this.root, folder, `Kiln Setup ${candidate.version}.exe`);
    try {
      noLinks(candidate.path); noLinks(destination);
      const before = await fs.promises.stat(candidate.path);
      invariant(before.isFile() && before.size > 0, 'INVALID_INSTALLER', 'The installer is empty or unavailable.');
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      const hash = createHash('sha256'); let copied = 0;
      const monitor = new Transform({ transform: (chunk, _encoding, done) => {
        hash.update(chunk); copied += chunk.length;
        this.stage = { state: 'preparing', version: candidate.version, progress: Math.min(90, Math.floor(copied / before.size * 90)) };
        done(null, chunk);
      } });
      await pipeline(fs.createReadStream(candidate.path), monitor, fs.createWriteStream(destination, { flags: 'wx' }));
      const after = await fs.promises.stat(candidate.path), sha256 = hash.digest('hex');
      invariant(copied === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs, 'UPDATE_CHANGED', 'The installer changed while preparing. Try again once the build finishes.');
      invariant(await checksum(destination) === sha256, 'UPDATE_CHANGED', 'The prepared installer did not verify. Try again.');
      const record = { version: candidate.version, folder, size: copied, sha256 };
      const previous = this.prepared;
      writeJson(this.manifest, record);
      this.prepared = record; this.stage = { state: 'ready', version: candidate.version };
      if (previous) this.removePrepared(previous);
      this.log('update.prepared', { version: candidate.version, size: copied });
    } catch (error) {
      this.stage = { state: 'failed', message: error instanceof Error ? error.message : String(error) };
      this.log('update.prepareFailed', { message: this.stage.message });
      await fs.promises.unlink(destination).catch(() => undefined);
      await fs.promises.rmdir(path.dirname(destination)).catch(() => undefined);
    }
  }
  async settled() { await this.pending; }
  async restart(launch: (installer: string) => Promise<void>, quit: () => void) {
    invariant(this.stage.state === 'ready' && this.prepared, 'UPDATE_NOT_READY', 'Prepare the update before restarting.');
    invariant(!this.restarting, 'UPDATE_BUSY', 'The update is already restarting.');
    this.restarting = true;
    try {
      const installer = this.installer(this.prepared); noLinks(installer);
      invariant(await checksum(installer) === this.prepared.sha256, 'UPDATE_CHANGED', 'The prepared installer changed. Prepare the update again.');
      await launch(installer);
      this.log('update.restart', { from: this.current, to: this.prepared.version });
      quit();
    } catch (error) {
      this.restarting = false;
      this.stage = { state: 'failed', message: error instanceof Error ? error.message : String(error) };
      if (this.prepared) this.removePrepared(this.prepared);
      this.prepared = undefined;
      // An invalid or unlaunchable installer must not become ready again after reopening Kiln.
      noLinks(this.manifest); await fs.promises.unlink(this.manifest).catch(() => undefined);
      throw error;
    }
  }
}
