import { MAX_ATTACHMENT_BYTES } from '../protocol/limits';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { invariant, WorkbenchError } from '../domain/errors';

export const now = () => new Date().toISOString();
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, val]) => `${JSON.stringify(key)}:${stable(val)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = (value: unknown) => hash(stable(value));
export function safeRelative(value: string) {
  invariant(value.length > 0 && value.length < 240 && !/[\\:*?"<>|\x00-\x1f]/.test(value) && !path.posix.isAbsolute(value), 'INVALID_PATH', `Unsafe relative path: ${value}`);
  invariant(value.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p)), 'INVALID_PATH', `Unsafe relative path: ${value}`);
  return value;
}
export function contained(root: string, relative: string) {
  safeRelative(relative);
  const result = path.resolve(root, relative);
  invariant(result.startsWith(path.resolve(root) + path.sep), 'INVALID_PATH', 'Path escapes its root.');
  return result;
}
export function noLinks(absolute: string) {
  const resolved = path.resolve(absolute);
  const parts = resolved.slice(path.parse(resolved).root.length).split(path.sep);
  let current = path.parse(resolved).root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current)) invariant(!fs.lstatSync(current).isSymbolicLink(), 'SYMLINK_REJECTED', `Linked path must be handled by its existing manager: ${current}`);
  }
}
export function atomicWrite(file: string, value: string | Buffer) {
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}
export const writeJson = (file: string, value: unknown) => atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
export const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
export function readRecords<T>(dir: string, parse: (value: unknown) => T, warnings?: string[]): T[] {
  if (!fs.existsSync(dir)) return [];
  // The folder's ancestry is checked once; each record then needs a single lstat rather than a walk from the drive root.
  noLinks(dir);
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => {
    try { const file = path.join(dir, f); invariant(!fs.lstatSync(file).isSymbolicLink(), 'SYMLINK_REJECTED', `Linked record: ${f}`); return [parse(readJson(file))]; }
    catch (error) { warnings?.push(`${f}: ${error instanceof Error ? error.message : error}`); return []; }
  });
}
export function withLock<T>(root: string, action: () => T): T {
  fs.mkdirSync(root, { recursive: true }); noLinks(root);
  const file = path.join(root, '.mutation.lock');
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started: now() }), { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let dead = false;
    try { const record = readJson(file) as { pid: number }; process.kill(record.pid, 0); }
    catch (check) { dead = (check as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (dead) { fs.unlinkSync(file); return withLock(root, action); }
    throw new WorkbenchError('LIBRARY_BUSY', 'Another process is updating this library. Try again shortly.');
  }
  try { return action(); } finally { fs.unlinkSync(file); }
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
