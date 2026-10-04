import fs from 'node:fs';
import path from 'node:path';
import { invariant } from '../domain/errors';
import { noLinks, readJson } from './files';

/** A folder changed this recently may change again within the same timestamp tick, so its listing is not trusted yet. */
const SETTLE_MS = 1000;
/** Records from another machine carry that machine's clock; a file is assumed no older than its own time by more than this. */
const CLOCK_SLACK_MS = 10 * 60_000;

type Entry<T> = { key: string; mtimeMs: number; loaded: boolean; stale: boolean; value?: T; error?: string };

/**
 * The parsed records of one folder (approvals, activity, observations…), kept between calls so a snapshot does not re-read
 * every file each time. While the folder is unchanged a call costs one lstat of it. Atomic writes, removals and Git checkouts
 * all change the folder's own time; then it is listed again and only new files are read, plus, in folders whose records are
 * rewritten in place (`rewritten`), files whose size or time changed. Edits that keep the folder's time (an editor saving in
 * place) are caught by `forget`, which the library's watcher and Kiln's own writes call.
 */
export class RecordFolder<T> {
  private entries = new Map<string, Entry<T>>();
  private listed: { mtimeMs: number; at: number } | null = null;
  private values: T[] | null = null;
  private recent?: { version: number; count: number; values: T[] };
  private ancestry = false;
  /** Bumped whenever the parsed records change, so callers can keep what they derive from them. */
  version = 0;
  constructor(readonly dir: string, private parse: (value: unknown) => T, private rewritten = false) {}
  /** Re-checks one record on the next call, or every record when no name is given. Nothing is re-read unless it changed. */
  forget(name?: string) {
    this.listed = null;
    if (name === undefined) { for (const entry of this.entries.values()) entry.stale = true; return; }
    const entry = this.entries.get(name); if (entry) entry.stale = true;
  }
  /** Every record read so far, with the size and time it had, for `restore` in a later process. */
  saved(): Record<string, { key: string; mtimeMs: number; value: unknown }> {
    const result: Record<string, { key: string; mtimeMs: number; value: unknown }> = {};
    for (const [name, entry] of this.entries) if (entry.loaded && entry.value !== undefined && entry.key) result[name] = { key: entry.key, mtimeMs: entry.mtimeMs, value: entry.value };
    return result;
  }
  /**
   * Takes back what `saved` gave, before the first call. `trusted`: the folder's records are written once and never in place
   * (observations), so a file still listed under its name holds what was read. Otherwise each is checked by size and time first.
   */
  restore(saved: Record<string, { key: string; mtimeMs: number; value: unknown }>, trusted: boolean) {
    for (const [name, entry] of Object.entries(saved)) {
      if (this.entries.has(name) || !name.endsWith('.json')) continue;
      try { this.entries.set(name, { key: entry.key, mtimeMs: entry.mtimeMs, loaded: true, stale: !trusted, value: this.parse(entry.value) }); } catch { /* Read again from the file. */ }
    }
    this.changed();
  }
  /** The folder's version once its names are up to date, without reading any record: unchanged means nothing to recompute. */
  check() { this.list(); return this.version; }
  /** Every record, in no particular order; unreadable ones are reported through `warnings` on each call, as `readRecords` does. */
  all(warnings?: string[]): T[] {
    this.list();
    for (const [name, entry] of this.entries) if (!entry.loaded) this.load(name, entry);
    return this.result(warnings);
  }
  /**
   * The `count` newest records by `time` (an ISO timestamp), reading as few files as it can; with `since` (ms), only records from
   * then on (give or take the clock slack). A record file is written at or after the time it records, so once `count` records are
   * known, files last modified before the oldest of them cannot hold a newer one, and neither can files last modified before `since`.
   */
  newest(count: number, time: (value: T) => string, warnings?: string[], since?: number): T[] {
    this.list();
    const order = (a: T, b: T) => time(b).localeCompare(time(a));
    let unread = [...this.entries].filter(([, entry]) => !entry.loaded);
    if (unread.length <= count && since === undefined) for (const [name, entry] of unread) this.load(name, entry);
    else {
      for (const [name, entry] of unread) if (entry.mtimeMs < 0) { try { entry.mtimeMs = fs.lstatSync(path.join(this.dir, name)).mtimeMs; } catch { entry.mtimeMs = 0; } }
      if (since !== undefined) unread = unread.filter(([, entry]) => entry.mtimeMs + CLOCK_SLACK_MS >= since);
      unread.sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs);
      while (unread.length) {
        const known = this.loadedValues().sort(order);
        if (known.length >= count) {
          const floor = Date.parse(time(known[count - 1]));
          if (!Number.isNaN(floor)) unread = unread.filter(([, entry]) => entry.mtimeMs + CLOCK_SLACK_MS >= floor);
        }
        for (const [name, entry] of unread.splice(0, count)) this.load(name, entry);
      }
    }
    const values = this.result(warnings);
    if (since !== undefined) return values.filter(value => !(Date.parse(time(value)) + CLOCK_SLACK_MS < since)).sort(order).slice(0, count);
    if (this.recent?.version !== this.version || this.recent.count !== count) this.recent = { version: this.version, count, values: values.sort(order).slice(0, count) };
    return [...this.recent.values];
  }
  private loadedValues() { return [...this.entries.values()].flatMap(entry => entry.loaded && entry.value !== undefined ? [entry.value] : []); }
  private result(warnings?: string[]) {
    if (warnings) for (const entry of this.entries.values()) if (entry.error) warnings.push(entry.error);
    this.values ??= this.loadedValues();
    return [...this.values];
  }
  private changed() { this.values = null; this.version++; }
  private load(name: string, entry: Entry<T>) {
    const file = path.join(this.dir, name);
    try {
      const stat = fs.lstatSync(file);
      entry.key = `${stat.size}:${stat.mtimeMs}`; entry.mtimeMs = stat.mtimeMs;
      invariant(!stat.isSymbolicLink(), 'SYMLINK_REJECTED', `Linked record: ${name}`);
      entry.value = this.parse(readJson(file)); entry.error = undefined;
    } catch (error) { entry.value = undefined; entry.error = `${name}: ${error instanceof Error ? error.message : error}`; }
    entry.loaded = true; entry.stale = false; this.changed();
  }
  /** Brings the names up to date with the folder, marking new and changed files to be read. */
  private list() {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.dir); } catch { if (this.entries.size) { this.entries.clear(); this.changed(); } this.listed = null; return; }
    invariant(!stat.isSymbolicLink(), 'SYMLINK_REJECTED', `Linked path must be handled by its existing manager: ${this.dir}`);
    if (this.listed && this.listed.mtimeMs === stat.mtimeMs && this.listed.at - stat.mtimeMs > SETTLE_MS) return;
    // The folder's ancestry is checked once; the folder itself on every call, above.
    if (!this.ancestry) { noLinks(this.dir); this.ancestry = true; }
    const at = Date.now(), present = new Set<string>();
    for (const dirent of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!dirent.name.endsWith('.json')) continue;
      present.add(dirent.name);
      const entry = this.entries.get(dirent.name);
      if (!entry) { this.entries.set(dirent.name, { key: '', mtimeMs: -1, loaded: false, stale: false }); this.changed(); continue; }
      if (!entry.loaded || !(this.rewritten || entry.stale || entry.error || dirent.isSymbolicLink())) continue;
      let key = 'missing'; try { const s = fs.lstatSync(path.join(this.dir, dirent.name)); key = `${s.size}:${s.mtimeMs}`; } catch { /* Gone since the listing; dropped next time. */ }
      if (key !== entry.key || dirent.isSymbolicLink()) { entry.loaded = false; entry.value = undefined; entry.error = undefined; this.changed(); }
      entry.stale = false;
    }
    for (const name of [...this.entries.keys()]) if (!present.has(name)) { this.entries.delete(name); this.changed(); }
    this.listed = { mtimeMs: stat.mtimeMs, at };
  }
}
