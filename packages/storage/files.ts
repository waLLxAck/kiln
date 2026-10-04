import { MAX_ATTACHMENT_BYTES } from '../protocol/limits';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { invariant, WorkbenchError } from '../domain/errors';
import { safeRelativePath } from '../domain/relative-path';

export const now = () => new Date().toISOString();
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, val]) => `${JSON.stringify(key)}:${stable(val)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => hash(stable(value));
export function safeRelative(value: string) {
  invariant(safeRelativePath(value), 'INVALID_PATH', `Unsafe relative path: ${value}`);
  return value;
}
export function contained(root: string, relative: string) {
  safeRelative(relative);
  const result = path.resolve(root, relative);
  invariant(result.startsWith(path.resolve(root) + path.sep), 'INVALID_PATH', 'Path escapes its root.');
  return result;
}
/**
 * Links the operating system owns rather than the user: macOS's /var, /tmp and /etc (which point into /private), and the folders
 * leading to a home folder reached through a link, such as /home -> /var/home on Fedora Atomic. Windows has none.
 */
export function systemLink(current: string, platform: NodeJS.Platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return false;
  if (platform === 'darwin' && ['/var', '/tmp', '/etc'].includes(current)) return true;
  const resolvedHome = path.resolve(home);
  return resolvedHome === current || resolvedHome.startsWith(current + path.sep);
}
export function noLinks(absolute: string) {
  const resolved = path.resolve(absolute);
  const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep);
  let current = path.parse(resolved).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current)) invariant(!fs.lstatSync(current).isSymbolicLink() || systemLink(current), 'SYMLINK_REJECTED', `Linked path must be handled by its existing manager: ${current}`);
  }
}
export function atomicWrite(file: string, value: string | Buffer) {
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { retryBusy(() => fs.renameSync(temp, file)); } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}
/** Blocks this thread; the library's file operations are synchronous, so a short wait between retries has to be too. */
export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Errors Windows gives while an antivirus scanner, the search indexer or a sync client briefly holds a file open. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Runs a rename or removal again after 10, 20, 40… ms (about 1.3 s in all) while the file is briefly held. */
export function retryBusy<T>(action: () => T, attempts = 8): T {
  for (let attempt = 1; ; attempt++) {
    try { return action(); }
    catch (error) { if (attempt >= attempts || !BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error; sleepSync(10 * 2 ** (attempt - 1)); }
  }
}
export const writeJson = (file: string, value: unknown) => atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
export const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
export function readRecords<T>(dir: string, parse: (value: unknown) => T, warnings?: string[]): T[] {
  if (!fs.existsSync(dir)) return [];
  // The folder's ancestry is checked once; each record's own type comes with the listing, so no file needs a walk or an lstat.
  // Callers that read the same folder often keep a RecordFolder (records.ts) instead.
  noLinks(dir);
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.name.endsWith('.json')).flatMap(entry => {
    const f = entry.name;
    try { invariant(!entry.isSymbolicLink(), 'SYMLINK_REJECTED', `Linked record: ${f}`); return [parse(readJson(path.join(dir, f)))]; }
    catch (error) { warnings?.push(`${f}: ${error instanceof Error ? error.message : error}`); return []; }
  });
}
/** An empty or unreadable lock (a crash between creating and writing it) is abandoned once it is this old. */
export const LOCK_UNREADABLE_MS = 5_000;
/** A lock whose process cannot be checked (EPERM: not ours, so most likely a reused PID; or another machine) is abandoned after this. */
export const LOCK_FOREIGN_MS = 30_000;
/** A lock whose process still answers is abandoned after this; no mutation takes that long, so the PID was reused by another program. */
export const LOCK_MAX_AGE_MS = 5 * 60_000;
/** How long a mutation waits for another process to finish before reporting LIBRARY_BUSY. */
export const LOCK_WAIT_MS = 1_000;
const processStart = Date.now() - process.uptime() * 1000;
/** Locks this thread holds. A nested mutation fails at once, as it always has, instead of waiting for itself. */
const held = new Set<string>();
type LockRecord = { pid: number; threadId?: number; host?: string; processStart?: number; token?: string; started?: string };
/** Whether the lock in `text` (last written `mtimeMs`) belongs to nobody any more. */
export function staleLock(text: string, mtimeMs: number, at = Date.now()) {
  const age = at - mtimeMs;
  // Written before this boot: no process from then is running, whatever now has its PID.
  if (mtimeMs < at - os.uptime() * 1000 - 5_000) return true;
  let record: LockRecord | undefined;
  try { const value = JSON.parse(text); if (typeof value?.pid === 'number') record = value; } catch { /* Empty or cut short. */ }
  if (!record) return age > LOCK_UNREADABLE_MS;
  if (record.host && record.host !== os.hostname()) return age > LOCK_FOREIGN_MS;
  if (record.pid === process.pid) {
    // An earlier process with this PID, or this thread after a release that failed (withLock refuses to nest before asking).
    if (record.processStart !== undefined && Math.abs(record.processStart - processStart) > 5_000) return true;
    if (record.threadId === threadId) return true;
    return age > LOCK_MAX_AGE_MS;
  }
  try { process.kill(record.pid, 0); }
  catch (check) {
    const code = (check as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    if (code === 'EPERM') return age > LOCK_FOREIGN_MS;
  }
  return age > LOCK_MAX_AGE_MS;
}
/** Removes the lock when it is stale and unchanged since it was judged so. True when the caller should try to take it again. */
function clearStaleLock(file: string) {
  let text: string, mtimeMs: number;
  try { mtimeMs = fs.statSync(file).mtimeMs; text = fs.readFileSync(file, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  if (!staleLock(text, mtimeMs)) return false;
  try {
    if (fs.readFileSync(file, 'utf8') !== text || fs.statSync(file).mtimeMs !== mtimeMs) return false; // Another process took it meanwhile.
    retryBusy(() => fs.unlinkSync(file), 3); return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}
export function withLock<T>(root: string, action: () => T): T {
  fs.mkdirSync(root, { recursive: true }); noLinks(root);
  const file = path.join(root, '.mutation.lock'), token = randomUUID();
  const record = JSON.stringify({ pid: process.pid, threadId, host: os.hostname(), processStart, token, started: now() } satisfies LockRecord);
  if (held.has(file)) throw new WorkbenchError('LIBRARY_BUSY', 'Another process is updating this library. Try again shortly.');
  const until = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0, cleared = 0; ; attempt++) {
    try { fs.writeFileSync(file, record, { flag: 'wx' }); break; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      // EPERM and EACCES also come from Windows while a just-deleted lock is still held open by a scanner.
      if (code !== 'EEXIST' && !BUSY_CODES.has(code)) throw error;
      if (code === 'EEXIST' && cleared < 3 && clearStaleLock(file)) { cleared++; continue; }
    }
    if (Date.now() >= until) throw new WorkbenchError('LIBRARY_BUSY', 'Another process is updating this library. Try again shortly.');
    sleepSync(Math.min(25 * 2 ** attempt, 200));
  }
  held.add(file);
  try { return action(); }
  finally {
    held.delete(file);
    // Only this lock is removed: one judged stale and replaced by another process stays theirs.
    try { if (fs.readFileSync(file, 'utf8') === record) retryBusy(() => fs.unlinkSync(file)); }
    catch { /* Gone already, or still held open: this thread's next mutation treats a lock it left as stale (staleLock). */ }
  }
}
export function bundleFiles(files: Record<string, string>) {
  const names = new Set<string>(); let bytes = 0;
  for (const [name, value] of Object.entries(files)) {
    safeRelative(name); const folded = name.toLowerCase();
    invariant(!names.has(folded), 'INVALID_PATH', 'File names collide on Windows.'); names.add(folded);
    invariant(value.length % 4 === 0 && Buffer.from(value, 'base64').toString('base64') === value, 'INVALID_ASSET', `Invalid base64 asset: ${name}`);
    bytes += Buffer.byteLength(value, 'base64');
  }
  invariant(bytes <= MAX_ATTACHMENT_BYTES, 'ASSET_TOO_LARGE', 'Imported assets are limited to 25 MB per item. Use a file reference for larger resources.');
}
