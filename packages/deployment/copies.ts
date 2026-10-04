import fs from 'node:fs';
import path from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../protocol/limits';
import { IGNORED_SKILL_ENTRIES } from '../domain/skills-import';
import { safeRelativePath } from '../domain/relative-path';
import { atomicWrite, digest } from '../storage/files';

/** Folders are listed case-insensitively where the file system usually is, as `lstat` of a path would find them. */
const folds = process.platform === 'win32' || process.platform === 'darwin';

/**
 * One `readdir` per folder for a whole scan, instead of an `lstat` per item and location: the installations list probes every
 * skill under every location of every target, and almost all of those paths do not exist.
 */
export class FolderIndex {
  private folders = new Map<string, { exact: Map<string, fs.Dirent>; folded: Set<string> } | null>();
  private list(folder: string) {
    if (this.folders.has(folder)) return this.folders.get(folder)!;
    let listing: { exact: Map<string, fs.Dirent>; folded: Set<string> } | null = null;
    try {
      const entries = fs.readdirSync(folder, { withFileTypes: true });
      listing = { exact: new Map(entries.map(e => [e.name, e])), folded: new Set(folds ? entries.map(e => e.name.toLowerCase()) : []) };
    } catch { /* Missing or unreadable: nothing is installed there. */ }
    this.folders.set(folder, listing);
    return listing;
  }
  /** Whether `file` exists, and whether it is a link (a symlink or a Windows junction), without following it. Null when absent. */
  find(file: string): { linked: boolean } | null {
    const listing = this.list(path.dirname(file)), name = path.basename(file);
    if (!listing) return null;
    const entry = listing.exact.get(name);
    if (!entry && !(folds && listing.folded.has(name.toLowerCase()))) return null;
    // Directory listings mark every Windows reparse point (OneDrive placeholders too) as a link, and a case-folded match names a
    // different spelling; both are rare, so ask lstat as before.
    if (entry && !entry.isSymbolicLink()) return { linked: false };
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    return stat ? { linked: stat.isSymbolicLink() } : null;
  }
}

/**
 * A modification time this close to now may not have ticked yet for a change made a moment later (file systems with coarse
 * timestamps), so a fingerprint that recent is not trusted: the copy is read again until it has been still for a few seconds.
 */
export const RACY_MS = 3000;
/** Above these a copy cannot be a skill Kiln installed, so walking further only costs time. */
const MAX_FILES = 5000, MAX_DEPTH = 16;
type Listed = { name: string; file: string; size: number; mtimeMs: number };
type Stored = { schemaVersion: 1; entries: Record<string, { fingerprint: string; hash: string }> };

/**
 * State hashes of installed copies (as `stateHash(readDestination(...))` computes them), kept per copy with a fingerprint of
 * its files' names, sizes and modification times. A refresh then lists and stats a copy, and reads and hashes it only when
 * something changed. Persisted machine-private (`<local>/cache/copy-states.json`) so a restart reads nothing new either.
 *
 * A linked copy (symlink or junction) is never followed into a large tree: anything a skill import leaves out (`.git`,
 * `node_modules`, ...), more than 5,000 files, nesting deeper than 16 or over the 25 MB bundle cap means the copy cannot equal
 * what Kiln writes, so it hashes as null ("differs") at once. Real folders follow the same rules: Kiln never writes those entries.
 */
export class CopyStates {
  private entries = new Map<string, { fingerprint: string; hash: string }>();
  private loaded = false;
  private dirty = false;
  constructor(private local: string) {}
  private get file() { return path.join(this.local, 'cache', 'copy-states.json'); }
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Stored;
      if (stored?.schemaVersion === 1 && stored.entries && typeof stored.entries === 'object') this.entries = new Map(Object.entries(stored.entries));
    } catch { /* No cache yet, or a damaged one. */ }
  }
  /** Files of a copy with their stats, or null when it cannot be one Kiln wrote (see the class comment) or cannot be read. */
  private list(root: string): Listed[] | null {
    let stat: fs.Stats; try { stat = fs.statSync(root); } catch { return null; }
    if (stat.isFile()) return [{ name: '.instruction', file: root, size: stat.size, mtimeMs: stat.mtimeMs }];
    if (!stat.isDirectory()) return null;
    const files: Listed[] = []; let bytes = 0;
    const visit = (dir: string, relative: string, depth: number): boolean => {
      if (depth > MAX_DEPTH) return false;
      let entries: fs.Dirent[]; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
      for (const entry of entries) {
        if (IGNORED_SKILL_ENTRIES.includes(entry.name) || entry.isSymbolicLink()) return false;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (!safeRelativePath(name)) return false;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!visit(file, name, depth + 1)) return false; continue; }
        if (!entry.isFile()) return false;
        let info: fs.Stats; try { info = fs.statSync(file); } catch { return false; }
        bytes += info.size;
        if (bytes > MAX_ATTACHMENT_BYTES || files.length >= MAX_FILES) return false;
        files.push({ name, file, size: info.size, mtimeMs: info.mtimeMs });
      }
      return true;
    };
    return visit(root, '', 0) ? files : null;
  }
  /**
   * State hash of the copy at `destination`, or null when there is none Kiln could have written. `linked` copies are read where
   * the link points (as installations always showed them), bounded as above.
   */
  hash(destination: string, linked: boolean): string | null {
    this.load();
    let root = destination;
    if (linked) { try { root = fs.realpathSync(destination); } catch { return null; } }
    const files = this.list(root);
    if (!files) { if (this.entries.delete(destination)) this.dirty = true; return null; }
    const fingerprint = digest([root, ...files.map(f => `${f.name}\0${f.size}\0${f.mtimeMs}`)]), hit = this.entries.get(destination);
    if (hit?.fingerprint === fingerprint) return hit.hash;
    const contents: Record<string, string> = {};
    try { for (const f of files) contents[f.name] = fs.readFileSync(f.file).toString('base64'); } catch { return null; }
    const hash = digest(contents), recent = Date.now() - RACY_MS;
    if (files.some(f => f.mtimeMs > recent)) { if (this.entries.delete(destination)) this.dirty = true; }
    else { this.entries.set(destination, { fingerprint, hash }); this.dirty = true; }
    return hash;
  }
  /** Drops copies not in `seen` (after a scan of everything), then writes the cache if it changed. */
  save(seen?: Set<string>) {
    if (seen) for (const key of this.entries.keys()) if (!seen.has(key)) { this.entries.delete(key); this.dirty = true; }
    if (!this.dirty) return;
    this.dirty = false;
    try { atomicWrite(this.file, JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries(this.entries) } satisfies Stored)); }
    catch { /* Rebuilt next time. */ }
  }
}
