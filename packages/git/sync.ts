import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Workbench } from '../domain/workbench';
import { invariant, WorkbenchError } from '../domain/errors';
import { atomicWrite, now, withLock } from '../storage/files';
import { gitStatus, push } from './service';
import { GitQueue } from './queue';
import { catFile, gitDirs, headCommit, mergeInProgress, networkTimeout, run, runRaw, type RunError, type RunOptions } from './run';

export { mergeInProgress } from './run';

/**
 * Background sync with GitHub: a fetch that never waits in the backend queue (only in the Git queue, behind other Git work),
 * the overlap check that lets Pull and Merge run beside drafts, and the fast-forward itself.
 */
const base = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0'];
function git(root: string, args: string[], options: RunOptions = {}) {
  return run('git', [...base, '-C', root, ...args], options);
}
/** Only for what must happen under the library lock: the fast-forward, and finishing a merge. */
function gitSyncRun(root: string, args: string[]) {
  return execFileSync('git', [...base, '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function succeeds(root: string, args: string[]) { try { await git(root, args); return true; } catch { return false; } }
const stderrOf = (error: unknown) => String((error as { stderr?: string }).stderr || (error instanceof Error ? error.message : error)).trim();


/** When the desktop app fetches: shortly after start, then every few minutes. KILN_SYNC_INTERVAL_MS shortens both, for tests. */
export function syncTiming(value = process.env.KILN_SYNC_INTERVAL_MS) {
  const custom = Number(value);
  return custom > 0 ? { delayMs: custom, intervalMs: custom, focusMs: Math.min(custom, 60_000) } : { delayMs: 20_000, intervalMs: 300_000, focusMs: 60_000 };
}
export type SyncStatus = { fetching: boolean; /** Last successful fetch, from this app or any other Git tool. */ fetchedAt: string | null; /** Last attempt, successful or not. */ checkedAt: string | null; /** Why the last attempt failed; empty when it worked. Offline is normal and shown quietly. */ error: string; delayMs: number; intervalMs: number; focusMs: number };

/**
 * `git fetch origin` as a child process the worker does not wait on, so a slow or missing network never holds up other actions.
 * Credential prompts are switched off: a fetch nobody asked for must not open a login window. Failures are only recorded.
 */
export async function fetchOrigin(root: string, timeoutMs = networkTimeout(60_000)) {
  try { await runRaw('git', [...base, '-c', 'maintenance.auto=false', '-C', root, 'fetch', '--quiet', 'origin'], { timeoutMs, maxBuffer: 1_000_000, network: true }); }
  catch (error) {
    const reason = String((error as { stderr?: string }).stderr || '').split('\n').map(l => l.trim()).filter(Boolean).join(' ').slice(0, 300);
    throw new Error((error as { killed?: boolean }).killed ? 'GitHub did not answer in time.' : reason || (error instanceof Error ? error.message : String(error)));
  }
}

export class BackgroundFetch {
  private running: Promise<void> | null = null;
  private attempting = false;
  private startedAt = 0;
  private fetchedAt: string | null = null;
  private checkedAt: string | null = null;
  private error = '';
  /** `queue` is shared with every other background Git job (see queue.ts), so a fetch waits for a commit or push to finish instead of racing it for the same refs. */
  constructor(private wb: Workbench, readonly queue: GitQueue = new GitQueue()) {}
  status(): SyncStatus {
    if (!this.fetchedAt) {
      // A fetch from the command line or an earlier session counts too. FETCH_HEAD is found from the repository's files, not by starting Git.
      const dirs = gitDirs(this.wb.root);
      for (const dir of dirs ? [dirs.git, dirs.common] : []) { try { this.fetchedAt = fs.statSync(path.join(dir, 'FETCH_HEAD')).mtime.toISOString(); break; } catch { /* Never fetched. */ } }
    }
    return { fetching: Boolean(this.running) || this.attempting, fetchedAt: this.fetchedAt, checkedAt: this.checkedAt, error: this.error, ...syncTiming() };
  }
  private fresh(maxAgeMs: number) { return Boolean(this.checkedAt && Date.now() - Date.parse(this.checkedAt) < maxAgeMs); }
  /**
   * Fetches unless the last attempt is younger than `maxAgeMs`, in its turn in the Git queue. Joins a fetch already waiting or
   * running instead of starting a second one, and skips its turn when another job fetched after it asked.
   */
  async fetch(maxAgeMs = 0): Promise<SyncStatus> {
    if (this.running) { await this.running; return this.status(); }
    if (this.fresh(maxAgeMs) || !this.wb.repositoryState().ready) return this.status();
    const asked = Date.now();
    this.running = this.queue.run(() => this.startedAt >= asked ? undefined : this.attempt()).finally(() => { this.running = null; });
    await this.running;
    return this.status();
  }
  /** The same for a job already running in the Git queue (a machine report), which would otherwise wait for its own turn forever. */
  async fetchHeld(maxAgeMs = 0): Promise<SyncStatus> {
    if (!this.fresh(maxAgeMs) && this.wb.repositoryState().ready) await this.attempt();
    return this.status();
  }
  private async attempt() {
    this.attempting = true; this.startedAt = Date.now();
    try { await fetchOrigin(this.wb.root); this.error = ''; this.fetchedAt = now(); }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.attempting = false; this.checkedAt = now(); await this.wb.refreshGit(); }
  }
  /** Resolves once no fetch is waiting or running. */
  idle() { return this.running ?? Promise.resolve(); }
}

const STATUS = ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'];
/** Paths of `git status --porcelain -z` output, both names of a rename; `tracked` leaves out untracked files. */
function statusPaths(text: string, tracked = false) {
  const parts = text.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]; if (entry.length < 4) continue;
    if (tracked && entry.startsWith('??')) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') paths.push(parts[++i]);
  }
  return paths.filter(Boolean);
}
/**
 * Every path with uncommitted changes on this machine: modified, deleted, staged, renamed (both names) and untracked files.
 * `tracked: true` leaves out untracked files, which the last commit cannot have.
 */
export async function localPaths(root: string, options: { tracked?: boolean } = {}) {
  return statusPaths(await git(root, STATUS, { maxBuffer: 64_000_000 }), options.tracked);
}
/** The same, synchronously, for finishing a merge under the library lock. */
export function localPathsSync(root: string) {
  return statusPaths(gitSyncRun(root, STATUS));
}
export type Overlap = { items: { id: string; title: string }[]; paths: string[] };
/** Stable JSON for comparing records whose key order may differ. */
const canonicalJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(value) ?? 'null';
/** An item record without the bookkeeping Kiln rewrites on its own: when it last changed, and an empty list of conflict heads. */
const essence = (value: Record<string, unknown>) => { const { updatedAt: _updated, conflictHeads, ...rest } = value; return canonicalJson({ ...rest, conflictHeads: conflictHeads ?? [] }); };
/** Where item folders sit in the repository, as Git names paths ("workbench/items/"), and which item a changed path belongs to. */
export function itemPaths(wb: Workbench) {
  const prefix = `${path.relative(wb.root, wb.canonical).split(path.sep).join('/')}/items/`;
  const split = (file: string) => { if (!file.startsWith(prefix)) return null; const [id, ...rest] = file.slice(prefix.length).split('/'); return id ? { id, rest: rest.join('/') } : null; };
  return { prefix, itemOf: (file: string) => split(file)?.id ?? null, split };
}
const uuid = /^[a-f0-9-]{36}$/;
/** Paths a merge of `ref` would change here: changed on GitHub's side since the common ancestor, and different from this commit. */
async function incomingPaths(root: string, ref: string) {
  // --no-renames lists both sides of a rename, so a local change at either name counts.
  const names = async (range: string[]) => new Set((await git(root, ['diff', '--name-only', '-z', '--no-renames', ...range], { maxBuffer: 64_000_000 })).split('\0').filter(Boolean));
  const [differs, changed] = await Promise.all([names(['HEAD', ref]), names([`HEAD...${ref}`])]);
  return [...changed].filter(file => differs.has(file));
}
/** Committed text of `files` at `ref`, read in one Git process; absent files are left out. */
async function committedTexts(root: string, ref: string, files: string[]) {
  const found = await catFile(root, files.map(file => `${ref}:${file}`)), texts = new Map<string, string>();
  for (const file of files) { const bytes = found.get(`${ref}:${file}`); if (bytes) texts.set(file, bytes.toString('utf8')); }
  return texts;
}
/** item.json files to put back to their committed bytes before a merge (see `settleBookkeeping`). */
type Settle = { file: string; head: string }[];
/** Keys of item.json that are organisation or bookkeeping: changing only these on this machine is not a draft. */
const organisation = new Set(['collection', 'order', 'favourite', 'updatedAt']);
const withoutOrganisation = (value: Record<string, unknown>) => canonicalJson(Object.fromEntries(Object.entries({ ...value, conflictHeads: value.conflictHeads ?? [] }).filter(([key]) => !organisation.has(key))));
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/**
 * Three-way merge of two JSON values that parted from `base`: objects key by key, lists as sets (what either side added stays,
 * what either side removed goes), and where both sides set one value differently, this machine's wins. `clashes` names those keys.
 */
export function mergeJson(base: unknown, ours: unknown, theirs: unknown, at = ''): { value: unknown; clashes: string[] } {
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  if (same(ours, theirs) || same(theirs, base)) return { value: ours, clashes: [] };
  if (same(ours, base)) return { value: theirs, clashes: [] };
  if (isRecord(ours) && isRecord(theirs)) {
    const before = isRecord(base) ? base : {}, value: Record<string, unknown> = {}, clashes: string[] = [];
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const merged = mergeJson(before[key], ours[key], theirs[key], at ? `${at}.${key}` : key);
      if (merged.value !== undefined) value[key] = merged.value;
      clashes.push(...merged.clashes);
    }
    return { value, clashes };
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) {
    const before = new Set((Array.isArray(base) ? base : []).map(canonicalJson)), mine = new Set(ours.map(canonicalJson)), seen = new Set<string>();
    const value = [...theirs.filter(v => !before.has(canonicalJson(v)) || mine.has(canonicalJson(v))), ...ours.filter(v => !before.has(canonicalJson(v)))]
      .filter(v => { const key = canonicalJson(v); if (seen.has(key)) return false; seen.add(key); return true; });
    return { value, clashes: [] };
  }
  return { value: ours, clashes: [at] };
}
/** Library-wide manifests both machines write: desired installs, the collection list, and pairs marked as not duplicates. */
const manifests = (wb: Workbench) => { const { prefix } = itemPaths(wb), library = prefix.slice(0, -'items/'.length); return new Set(['installs.json', 'workbench.json', 'distinct.json'].map(name => library + name)); };
const later = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' ? (a > b ? a : b) : a ?? b;
/**
 * Kiln's JSON files that both `head` and `ref` changed since they parted (manifests, item.json), merged key by key: a line-by-line
 * merge of JSON can succeed and still be wrong, such as one key added twice. `unresolved` are item.json files where both sides
 * changed more than organisation (content, revision, status), and files one side deleted; those are left to Git and the user.
 * Reads only commits, so it runs without the library lock.
 */
export async function mergeJsonFiles(wb: Workbench, ref: string, head = 'HEAD') {
  const { split } = itemPaths(wb), shared = manifests(wb), isItem = (file: string) => { const part = split(file); return Boolean(part && uuid.test(part.id) && part.rest === 'item.json'); };
  const parted = (await git(wb.root, ['merge-base', head, ref])).trim();
  const changed = async (to: string) => new Set((await git(wb.root, ['diff', '--name-only', '-z', '--no-renames', parted, to], { maxBuffer: 64_000_000 })).split('\0').filter(file => file && (shared.has(file) || isItem(file))));
  const [ours, theirsChanged] = await Promise.all([changed(head), changed(ref)]);
  const both = [...theirsChanged].filter(f => ours.has(f)), files: Record<string, string> = {}, unresolved: string[] = [];
  const blobs = await catFile(wb.root, both.flatMap(file => [`${parted}:${file}`, `${head}:${file}`, `${ref}:${file}`]));
  const read = (rev: string, file: string) => { const bytes = blobs.get(`${rev}:${file}`); if (!bytes) throw new Error(`${file} is not in ${rev}`); return JSON.parse(bytes.toString('utf8')) as unknown; };
  for (const file of both) {
    try {
      let before: unknown = {}; try { before = read(parted, file); } catch { /* Added on both sides. */ }
      const mine = read(head, file), theirs = read(ref, file), merged = mergeJson(before, mine, theirs);
      // An item's content, revision or status changed on both sides needs the user, even when no single key clashes: a withdrawn
      // approval of one revision must not land on the newer revision the other machine approved.
      if (isItem(file) && (!isRecord(before) || !isRecord(mine) || !isRecord(theirs) || (withoutOrganisation(mine) !== withoutOrganisation(before) && withoutOrganisation(theirs) !== withoutOrganisation(before)))) { unresolved.push(file); continue; }
      if (isItem(file) && isRecord(merged.value) && isRecord(mine) && isRecord(theirs)) merged.value.updatedAt = later(mine.updatedAt, theirs.updatedAt);
      files[file] = JSON.stringify(merged.value, null, 2) + '\n';
    } catch { unresolved.push(file); }
  }
  return { files, unresolved };
}
/** Local edits put out of a merge's way: see `setAside`. */
export type Aside = {
  /** Paths that will be set aside, so the overlap check can leave them out. */
  files: Set<string>;
  /** Puts them back to the committed bytes. Under the library lock, right before merging; one changed since it was read stays in the way. */
  apply(): void;
  /** Puts them back exactly, when nothing was merged. */
  restore(): void;
  /** Lays them over what the merge brought. */
  reapply(): void;
};
/**
 * Edits made here that GitHub changed too, but that are not drafts: the manifests, and item.json files where only organisation
 * changed (a move or reorder not published yet). Git would refuse to merge over them, so they are put back to the committed
 * bytes first (`apply`); `reapply` lays them over what the merge brought, and `restore` puts them back exactly when nothing was
 * merged. Which files is worked out here, without the lock; `local` is this machine's changed paths.
 */
export async function setAside(wb: Workbench, local: string[], ref = '@{upstream}'): Promise<Aside> {
  const incoming = new Set(await incomingPaths(wb.root, ref)), { split } = itemPaths(wb), shared = manifests(wb);
  // Items with any other local change (content, files, a new revision) are drafts, and stay in the way.
  const touched = new Set(local.map(split).filter(part => part && part.rest !== 'item.json').map(part => part!.id));
  const isCarriedItem = (file: string) => { const part = split(file); return Boolean(part && uuid.test(part.id) && part.rest === 'item.json' && !touched.has(part.id)); };
  const candidates = local.filter(f => incoming.has(f) && (isCarriedItem(f) || shared.has(f))), heads = await committedTexts(wb.root, 'HEAD', candidates);
  const planned: { file: string; text: string; committed: string; head: unknown; item: boolean }[] = [];
  for (const file of candidates) {
    const committed = heads.get(file), item = isCarriedItem(file); if (committed === undefined) continue;
    try {
      const text = fs.readFileSync(path.join(wb.root, file), 'utf8'), head = JSON.parse(committed) as unknown, working = JSON.parse(text) as unknown;
      if (item && !(isRecord(head) && isRecord(working) && withoutOrganisation(head) === withoutOrganisation(working))) continue;
      planned.push({ file, text, committed, head, item });
    } catch { /* Unreadable, deleted or new: a real change, left in the way. */ }
  }
  const carried: typeof planned = [];
  return {
    files: new Set(planned.map(p => p.file)),
    apply() {
      for (const c of planned) {
        const full = path.join(wb.root, c.file);
        try { if (fs.readFileSync(full, 'utf8') !== c.text) continue; } catch { continue; }
        atomicWrite(full, c.committed); carried.push(c);
      }
    },
    restore() { for (const c of carried) atomicWrite(path.join(wb.root, c.file), c.text); },
    reapply() {
      for (const c of carried) {
        const full = path.join(wb.root, c.file);
        let now: unknown; try { now = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { if (!c.item) atomicWrite(full, c.text); continue; }
        const ours = JSON.parse(c.text) as unknown, merged = mergeJson(c.head, ours, now).value;
        if (c.item && isRecord(merged) && isRecord(ours) && isRecord(now)) merged.updatedAt = later(ours.updatedAt, now.updatedAt);
        if (canonicalJson(merged) !== canonicalJson(now)) atomicWrite(full, JSON.stringify(merged, null, 2) + '\n');
      }
    },
  };
}
/** Paths a merge left conflicted, from `git ls-files -u -z` or the conflict list of `git merge-tree -z` (`<mode> <blob> <stage>\t<path>`). */
export function conflictedPaths(entries: string[]) {
  const paths = new Set<string>();
  for (const entry of entries) { const match = entry.match(/^\d+ [0-9a-f]+ [123]\t(.+)$/s); if (!match) break; paths.add(match[1]); }
  return paths;
}
/**
 * The merge of commits `head` and `theirs` as a commit, built without touching the working tree or the index (so without the
 * library lock), with Kiln's JSON files merged key by key. Null when an item really conflicts, so the user has to choose.
 */
async function mergeCommit(wb: Workbench, head: string, theirs: string) {
  let output: string;
  try { output = await git(wb.root, ['merge-tree', '--write-tree', '-z', head, theirs], { maxBuffer: 64_000_000 }); }
  catch (error) {
    // 1 means conflicts. Anything else (Git older than 2.38 has no --write-tree) leaves the merge to Merge from GitHub.
    const failed = error as RunError; if (failed.code !== 1 || !failed.stdout) return null;
    output = failed.stdout;
  }
  const [tree, ...entries] = output.split('\0');
  const { files, unresolved } = await mergeJsonFiles(wb, theirs, head);
  if (unresolved.length || [...conflictedPaths(entries)].some(file => !(file in files))) return null;
  let merged = tree;
  if (Object.keys(files).length) {
    const index = path.join(wb.canonical, `.git-index-merge-${process.pid}-${randomUUID()}`);
    const inIndex = async (args: string[], input?: string) => (await git(wb.root, args, { input, env: { GIT_INDEX_FILE: index } })).trim();
    try {
      await inIndex(['read-tree', tree]);
      for (const [file, text] of Object.entries(files)) await inIndex(['update-index', '--add', '--cacheinfo', `100644,${await inIndex(['hash-object', '-w', '--stdin'], text)},${file}`]);
      merged = await inIndex(['write-tree']);
    } finally { fs.rmSync(index, { force: true }); }
  }
  return (await git(wb.root, ['commit-tree', merged, '-p', head, '-p', theirs, '-m', 'Merge library changes from GitHub'])).trim();
}
/**
 * Approving rewrites item.json with a fresh `updatedAt` and the published copy adds an empty `conflictHeads`, so an approved item
 * can look changed when it is not. Before merging, such item.json files that GitHub also changed are put back to the committed
 * bytes; they say the same thing, and otherwise Git would refuse to update them. This works out which; `applySettle` writes them.
 */
async function settleBookkeeping(wb: Workbench, local: string[], ref = '@{upstream}'): Promise<Settle> {
  const incoming = new Set(await incomingPaths(wb.root, ref)), { split } = itemPaths(wb);
  const itemFile = (file: string) => { const part = split(file); return Boolean(part && uuid.test(part.id) && part.rest === 'item.json'); };
  const files = local.filter(f => itemFile(f) && incoming.has(f)), heads = await committedTexts(wb.root, 'HEAD', files), settle: Settle = [];
  for (const file of files) {
    const head = heads.get(file); if (head === undefined) continue;
    try { if (essence(JSON.parse(fs.readFileSync(path.join(wb.root, file), 'utf8'))) === essence(JSON.parse(head))) settle.push({ file, head }); } catch { /* Unreadable or deleted: a real change, left alone. */ }
  }
  return settle;
}
/** Writes the settled item.json files, under the library lock; one changed since it was checked is a real change and stays. */
function applySettle(wb: Workbench, settle: Settle) {
  for (const { file, head } of settle) {
    const full = path.join(wb.root, file);
    try { if (essence(JSON.parse(fs.readFileSync(full, 'utf8'))) === essence(JSON.parse(head))) atomicWrite(full, head); } catch { /* Changed meanwhile: left alone. */ }
  }
}
/**
 * Local changes that incoming commits would collide with: the same path changed on both sides, or any incoming change inside an
 * item that is a draft here (its content, files or revision differ from the commit), because an item's files only make sense together.
 */
async function incomingOverlap(wb: Workbench, local: string[], ref = '@{upstream}'): Promise<Overlap> {
  const { prefix, itemOf, split } = itemPaths(wb);
  const incomingList = await incomingPaths(wb.root, ref);
  const incoming = new Set(incomingList.map(p => p.toLowerCase())), incomingItems = new Set(incomingList.map(itemOf).filter(Boolean));
  const drafts = new Set<string>();
  const records = local.filter(file => split(file)?.rest === 'item.json'), heads = await committedTexts(wb.root, 'HEAD', records);
  for (const file of local) {
    const part = split(file); if (!part) continue;
    const { id, rest } = part;
    if (rest === 'content.md' || rest.startsWith('files/')) drafts.add(id);
    else if (rest === 'item.json') {
      try { const head = JSON.parse(heads.get(file) ?? '') as { revision?: string }; if ((JSON.parse(fs.readFileSync(path.join(wb.root, file), 'utf8')) as { revision?: string }).revision !== head.revision) drafts.add(id); }
      catch { drafts.add(id); }
    }
  }
  const items = new Map<string, string>(), paths = new Set<string>(), unnamed: string[] = [];
  for (const file of local) {
    const id = itemOf(file);
    if (!incoming.has(file.toLowerCase()) && !(id && drafts.has(id) && incomingItems.has(id))) continue;
    if (!id) { paths.add(file); continue; }
    if (items.has(id)) continue;
    let title = '';
    try { title = wb.getItem(id).title; } catch { unnamed.push(id); }
    items.set(id, title || id);
  }
  if (unnamed.length) {
    const theirs = await committedTexts(wb.root, ref, unnamed.map(id => `${prefix}${id}/item.json`));
    for (const id of unnamed) { try { const title = String((JSON.parse(theirs.get(`${prefix}${id}/item.json`) ?? '') as { title?: unknown }).title ?? ''); if (title) items.set(id, title); } catch { /* Neither side can name it. */ } }
  }
  return { items: [...items].map(([id, title]) => ({ id, title })), paths: [...paths] };
}
/** “A”, “B” and 2 more — for refusals that name what blocks them. */
export function describeOverlap(overlap: Overlap) {
  const names = [...overlap.items.map(i => `“${i.title}”`), ...overlap.paths.map(p => p)];
  const shown = names.slice(0, 5), rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? '';
}
/**
 * What GitHub's side would collide with here, worked out without the library lock or the thread: the item.json files to settle
 * first, the edits to set aside (see `setAside`), and what still overlaps once both are out of the way.
 */
async function mergePreview(wb: Workbench, ref: string) {
  const local = await localPaths(wb.root);
  const settle = await settleBookkeeping(wb, local, ref), settled = new Set(settle.map(s => s.file));
  const unsettled = local.filter(file => !settled.has(file)), aside = await setAside(wb, unsettled, ref);
  return { settle, aside, overlap: await incomingOverlap(wb, unsettled.filter(file => !aside.files.has(file)), ref) };
}
/**
 * Refuses a merge only for what would really get in its way: a merge already in progress, files staged by hand, or local changes
 * to what GitHub changed. Drafts elsewhere stay exactly where they are; Git leaves files it does not merge untouched.
 *
 * Returns what to do under the library lock right before merging: `settle` puts bookkeeping back (`applySettle`) and sets
 * manifests and organisation aside; `aside` lays those over the result afterwards, or restores them when nothing was merged.
 */
export async function assertMergeable(wb: Workbench, ref = '@{upstream}', verb: 'pull' | 'merge' = 'merge') {
  invariant(!mergeInProgress(wb.root), 'GIT_CONFLICT', 'A merge from GitHub is already in progress. Resolve conflicts and finish it first.');
  if (!await succeeds(wb.root, ['diff', '--cached', '--quiet'])) throw new WorkbenchError('GIT_STAGED', `Some files are staged in Git on this machine. Commit or unstage them in your Git tool, then ${verb} again.`);
  const { settle, aside, overlap } = await mergePreview(wb, ref);
  if (overlap.items.length || overlap.paths.length) throw new WorkbenchError('GIT_DIRTY', `GitHub has changes to ${describeOverlap(overlap)}, which you also changed on this machine. Approve or discard those drafts, then ${verb} again.`);
  return { overlap, aside, settle: () => { applySettle(wb, settle); aside.apply(); } };
}

export type PullResult = { status: 'pulled'; count: number } | { status: 'merged'; count: number } | { status: 'current' } | { status: 'diverged'; ahead: number; behind: number } | { status: 'blocked'; items: Overlap['items']; paths: string[] };
/**
 * Pull without the network: brings in what the last fetch brought. A fast-forward when this machine has no commits of its own;
 * otherwise a merge commit, made without touching the working tree, as long as no item changed on both sides (`diverged` then:
 * the user chooses in Merge from GitHub). Drafts are never moved, stashed or rewritten; the pull is refused (naming the items)
 * when GitHub changed something that is a draft here. Manifests and organisation changed on both sides are merged.
 *
 * The checks and the merge commit run without the library lock; only settling bookkeeping, setting edits aside and the
 * fast-forward itself, which change working files, hold it.
 */
export async function pullFetched(wb: Workbench): Promise<PullResult> {
  let result: PullResult;
  try {
    invariant((await gitStatus(wb.root)).attached, 'NOT_A_REPOSITORY', 'Attach a Git repository first.');
    let commits: string[];
    try { commits = (await git(wb.root, ['rev-parse', 'HEAD', '@{upstream}'])).trim().split(/\s+/); }
    catch { throw new WorkbenchError('NO_UPSTREAM', 'This branch is not on GitHub yet. Approve something to push it first.'); }
    const [head, upstream] = commits;
    const [ahead, behind] = (await git(wb.root, ['rev-list', '--left-right', '--count', `${head}...${upstream}`])).trim().split(/\s+/).map(n => Number(n) || 0);
    if (!behind) return { status: 'current' };
    invariant(!mergeInProgress(wb.root), 'GIT_CONFLICT', 'A merge from GitHub is in progress. Resolve conflicts and finish it first.');
    const { settle, aside, overlap } = await mergePreview(wb, upstream);
    if (overlap.items.length || overlap.paths.length) return { status: 'blocked', ...overlap };
    const target = ahead ? await mergeCommit(wb, head, upstream) : upstream;
    if (!target) return { status: 'diverged', ahead, behind };
    result = withLock(wb.canonical, (): PullResult => {
      // A commit made while this was worked out (a checkpoint) would be lost behind the merge: pull again instead.
      const now = headCommit(wb.root);
      if (now && now !== head) throw new WorkbenchError('GIT_SYNC_FAILED', 'The library got a new commit while pulling. Pull again.');
      applySettle(wb, settle); aside.apply();
      let merged = false;
      try {
        try { gitSyncRun(wb.root, ['merge', '--ff-only', '--no-edit', target]); }
        catch (error) {
          const stderr = stderrOf(error);
          // Git checks before it writes anything, so a refusal here leaves every file as it was.
          if (/would be overwritten|untracked working tree files/i.test(stderr)) return { status: 'blocked', items: [], paths: stderr.split('\n').map(l => l.trim()).filter(l => l && !/^(error|hint|Please|Aborting|Updating)/i.test(l) && !l.endsWith(':')).slice(0, 20) };
          throw new WorkbenchError('GIT_SYNC_FAILED', stderr.split('\n').filter(l => l.trim()).join(' ').slice(0, 600) || 'git merge failed');
        }
        merged = true;
        return ahead ? { status: 'merged', count: behind } : { status: 'pulled', count: behind };
      } finally { if (merged) aside.reapply(); else aside.restore(); }
    });
  } finally { await wb.refreshGit(); }
  // New and changed items show at once rather than when the folder watcher catches up.
  if (result.status === 'pulled' || result.status === 'merged') wb.refresh();
  return result;
}
/** Whether GitHub's commits, as of the last fetch, change anything in the item's folder that this machine has not got. */
export async function changedOnGitHub(wb: Workbench, itemId: string) {
  try { return Boolean((await git(wb.root, ['diff', '--name-only', 'HEAD...@{upstream}', '--', `${itemPaths(wb).prefix}${itemId}`])).trim()); } catch { return false; }
}
/** Whether GitHub, as of the last fetch, has `commit`. */
export function onGitHub(root: string, commit: string) {
  return succeeds(root, ['merge-base', '--is-ancestor', commit, '@{upstream}']);
}
/**
 * Pushes this machine's commits. When GitHub refuses because another machine pushed first, fetches, brings those commits in
 * (see `pullFetched`) and pushes again. Run it in its turn in the Git queue; it fetches with `fetchHeld`. The push and the fetch
 * are network calls without prompts (see run.ts) and never hold the library lock.
 */
export async function pushToGitHub(wb: Workbench, fetcher: BackgroundFetch) {
  for (let attempt = 0; ; attempt++) {
    try { const state = await push(wb.root); wb.invalidateGit(); return state; }
    catch (error) { if (!(error instanceof WorkbenchError && error.code === 'GIT_PUSH_REJECTED') || attempt >= 2) throw error; }
    const fetched = await fetcher.fetchHeld(0);
    if (fetched.error) throw new WorkbenchError('GIT_PUSH_FAILED', `GitHub has commits this machine does not have yet, and fetching them failed: ${fetched.error}`);
    const result = await pullFetched(wb);
    if (result.status === 'blocked') throw new WorkbenchError('GIT_DIRTY', `GitHub has newer changes to ${describeOverlap(result)}, which you also changed on this machine. Approve or discard those drafts, then retry.`);
    if (result.status === 'diverged') throw new WorkbenchError('GIT_DIVERGED', 'GitHub has a different version of an item changed here. Pull, choose which to keep in Merge from GitHub, and this goes out with it.');
  }
}
