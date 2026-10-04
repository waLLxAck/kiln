import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { Workbench } from '../domain/workbench';
import { invariant, WorkbenchError } from '../domain/errors';
import { atomicWrite, now, withLock } from '../storage/files';
import { gitStatus, push } from './service';
import { GitQueue } from './queue';

/**
 * Background sync with GitHub: a fetch that never waits in the backend queue (only in the Git queue, behind other Git work),
 * the overlap check that lets Pull and Merge run beside drafts, and the fast-forward itself.
 */
const base = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0'];
function git(root: string, args: string[]) {
  return execFileSync('git', [...base, '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 20_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
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
export function fetchOrigin(root: string, timeoutMs = 60_000) {
  return new Promise<void>((resolve, reject) => {
    execFile('git', [...base, '-c', 'maintenance.auto=false', '-c', 'credential.interactive=never', '-C', root, 'fetch', '--quiet', 'origin'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 1_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' } }, (error, _stdout, stderr) => {
      if (!error) { resolve(); return; }
      const reason = String(stderr || '').split('\n').map(l => l.trim()).filter(Boolean).join(' ').slice(0, 300);
      reject(new Error((error as { killed?: boolean }).killed ? 'GitHub did not answer in time.' : reason || error.message));
    });
  });
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
      // A fetch from the command line or an earlier session counts too.
      try { this.fetchedAt = fs.statSync(path.resolve(this.wb.root, git(this.wb.root, ['rev-parse', '--git-path', 'FETCH_HEAD']).trim())).mtime.toISOString(); } catch { /* Never fetched. */ }
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
    finally { this.attempting = false; this.checkedAt = now(); this.wb.invalidateGit(); }
  }
  /** Resolves once no fetch is waiting or running. */
  idle() { return this.running ?? Promise.resolve(); }
}

/** Every path with uncommitted changes on this machine: modified, deleted, staged, renamed (both names) and untracked files. */
export function localPaths(root: string) {
  const parts = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]; if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') paths.push(parts[++i]);
  }
  return paths.filter(Boolean);
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
function incomingPaths(root: string, ref: string) {
  // --no-renames lists both sides of a rename, so a local change at either name counts.
  const names = (range: string[]) => new Set(git(root, ['diff', '--name-only', '-z', '--no-renames', ...range]).split('\0').filter(Boolean));
  const differs = names(['HEAD', ref]);
  return [...names([`HEAD...${ref}`])].filter(file => differs.has(file));
}
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
 * Kiln's JSON files that both HEAD and `ref` changed since they parted (manifests, item.json), merged key by key: a line-by-line
 * merge of JSON can succeed and still be wrong, such as one key added twice. `unresolved` are item.json files whose sides
 * really disagree (a different revision on each), and files one side deleted; those are left to Git and the user.
 */
export function mergeJsonFiles(wb: Workbench, ref: string) {
  const { split } = itemPaths(wb), shared = manifests(wb), isItem = (file: string) => { const part = split(file); return Boolean(part && uuid.test(part.id) && part.rest === 'item.json'); };
  const parted = git(wb.root, ['merge-base', 'HEAD', ref]).trim();
  const changed = (to: string) => new Set(git(wb.root, ['diff', '--name-only', '-z', '--no-renames', parted, to]).split('\0').filter(file => file && (shared.has(file) || isItem(file))));
  const ours = changed('HEAD'), files: Record<string, string> = {}, unresolved: string[] = [];
  const read = (rev: string, file: string) => JSON.parse(git(wb.root, ['show', `${rev}:${file}`])) as unknown;
  for (const file of [...changed(ref)].filter(f => ours.has(f))) {
    try {
      let before: unknown = {}; try { before = read(parted, file); } catch { /* Added on both sides. */ }
      const mine = read('HEAD', file), theirs = read(ref, file), merged = mergeJson(before, mine, theirs);
      if (isItem(file) && merged.clashes.some(key => !organisation.has(key))) { unresolved.push(file); continue; }
      if (isItem(file) && isRecord(merged.value) && isRecord(mine) && isRecord(theirs)) merged.value.updatedAt = later(mine.updatedAt, theirs.updatedAt);
      files[file] = JSON.stringify(merged.value, null, 2) + '\n';
    } catch { unresolved.push(file); }
  }
  return { files, unresolved };
}
/**
 * Edits made here that GitHub changed too, but that are not drafts: the manifests, and item.json files where only organisation
 * changed (a move or reorder not published yet). Git would refuse to merge over them, so they are put back to the committed
 * bytes first; `reapply` lays them over what the merge brought, and `restore` puts them back exactly when nothing was merged.
 */
export function setAside(wb: Workbench, ref = '@{upstream}') {
  const incoming = new Set(incomingPaths(wb.root, ref)), local = localPaths(wb.root), { split } = itemPaths(wb), shared = manifests(wb);
  // Items with any other local change (content, files, a new revision) are drafts, and stay in the way.
  const touched = new Set(local.map(split).filter(part => part && part.rest !== 'item.json').map(part => part!.id));
  const carried: { file: string; text: string; head: unknown; item: boolean }[] = [];
  for (const file of local.filter(f => incoming.has(f))) {
    const part = split(file), item = Boolean(part && uuid.test(part.id) && part.rest === 'item.json' && !touched.has(part.id));
    if (!item && !shared.has(file)) continue;
    try {
      const committed = git(wb.root, ['show', `HEAD:${file}`]), full = path.join(wb.root, file), text = fs.readFileSync(full, 'utf8'), head = JSON.parse(committed) as unknown, working = JSON.parse(text) as unknown;
      if (item && !(isRecord(head) && isRecord(working) && withoutOrganisation(head) === withoutOrganisation(working))) continue;
      atomicWrite(full, committed); carried.push({ file, text, head, item });
    } catch { /* Unreadable, deleted or new: a real change, left in the way. */ }
  }
  return {
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
 * The merge of HEAD and `ref` as a commit, built without touching the working tree or the index, with Kiln's JSON files merged
 * key by key. Null when an item really conflicts, so the user has to choose.
 */
function mergeCommit(wb: Workbench, ref: string) {
  let output: string;
  try { output = git(wb.root, ['merge-tree', '--write-tree', '-z', 'HEAD', ref]); }
  catch (error) {
    // 1 means conflicts. Anything else (Git older than 2.38 has no --write-tree) leaves the merge to Merge from GitHub.
    const failed = error as { status?: number; stdout?: string }; if (failed.status !== 1 || !failed.stdout) return null;
    output = failed.stdout;
  }
  const [tree, ...entries] = output.split('\0');
  const { files, unresolved } = mergeJsonFiles(wb, ref);
  if (unresolved.length || [...conflictedPaths(entries)].some(file => !(file in files))) return null;
  let merged = tree;
  if (Object.keys(files).length) {
    const index = path.join(wb.canonical, `.git-index-merge-${process.pid}`);
    const run = (args: string[], input?: string) => execFileSync('git', [...base, '-C', wb.root, ...args], { encoding: 'utf8', input, windowsHide: true, timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
    try {
      run(['read-tree', tree]);
      for (const [file, text] of Object.entries(files)) run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${file}`]);
      merged = run(['write-tree']);
    } finally { fs.rmSync(index, { force: true }); }
  }
  return git(wb.root, ['commit-tree', merged, '-p', 'HEAD', '-p', ref, '-m', 'Merge library changes from GitHub']).trim();
}
/**
 * Approving rewrites item.json with a fresh `updatedAt` and the published copy adds an empty `conflictHeads`, so an approved item
 * can look changed when it is not. Before merging, such item.json files that GitHub also changed are put back to the committed
 * bytes; they say the same thing, and otherwise Git would refuse to update them.
 */
export function settleBookkeeping(wb: Workbench, ref = '@{upstream}') {
  const incoming = new Set(incomingPaths(wb.root, ref)), { split } = itemPaths(wb);
  const itemFile = (file: string) => { const part = split(file); return Boolean(part && uuid.test(part.id) && part.rest === 'item.json'); };
  for (const file of localPaths(wb.root).filter(f => itemFile(f) && incoming.has(f))) {
    let head: string; try { head = git(wb.root, ['show', `HEAD:${file}`]); } catch { continue; }
    const full = path.join(wb.root, file);
    try { if (essence(JSON.parse(fs.readFileSync(full, 'utf8'))) === essence(JSON.parse(head))) atomicWrite(full, head); } catch { /* Unreadable or deleted: a real change, left alone. */ }
  }
}
/**
 * Local changes that incoming commits would collide with: the same path changed on both sides, or any incoming change inside an
 * item that is a draft here (its content, files or revision differ from the commit), because an item's files only make sense together.
 */
export function incomingOverlap(wb: Workbench, ref = '@{upstream}'): Overlap {
  const { prefix, itemOf, split } = itemPaths(wb);
  const incomingList = incomingPaths(wb.root, ref);
  const incoming = new Set(incomingList.map(p => p.toLowerCase())), incomingItems = new Set(incomingList.map(itemOf).filter(Boolean));
  const local = localPaths(wb.root), drafts = new Set<string>();
  for (const file of local) {
    const part = split(file); if (!part) continue;
    const { id, rest } = part;
    if (rest === 'content.md' || rest.startsWith('files/')) drafts.add(id);
    else if (rest === 'item.json') {
      try { const head = JSON.parse(git(wb.root, ['show', `HEAD:${file}`])) as { revision?: string }; if ((JSON.parse(fs.readFileSync(path.join(wb.root, file), 'utf8')) as { revision?: string }).revision !== head.revision) drafts.add(id); }
      catch { drafts.add(id); }
    }
  }
  const items = new Map<string, string>(), paths = new Set<string>();
  for (const file of local) {
    const id = itemOf(file);
    if (!incoming.has(file.toLowerCase()) && !(id && drafts.has(id) && incomingItems.has(id))) continue;
    if (!id) { paths.add(file); continue; }
    if (items.has(id)) continue;
    let title = '';
    try { title = wb.getItem(id).title; } catch { try { title = String((JSON.parse(git(wb.root, ['show', `${ref}:${prefix}${id}/item.json`])) as { title?: unknown }).title ?? ''); } catch { /* Neither side can name it. */ } }
    items.set(id, title || id);
  }
  return { items: [...items].map(([id, title]) => ({ id, title })), paths: [...paths] };
}
/** “A”, “B” and 2 more — for refusals that name what blocks them. */
export function describeOverlap(overlap: Overlap) {
  const names = [...overlap.items.map(i => `“${i.title}”`), ...overlap.paths.map(p => p)];
  const shown = names.slice(0, 5), rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? '';
}
export const mergeInProgress = (root: string) => { try { git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']); return true; } catch { return false; } };
/**
 * Refuses a merge only for what would really get in its way: a merge already in progress, files staged by hand, or local changes
 * to what GitHub changed. Drafts elsewhere stay exactly where they are; Git leaves files it does not merge untouched.
 */
export function assertMergeable(wb: Workbench, ref = '@{upstream}', verb: 'pull' | 'merge' = 'merge') {
  invariant(!mergeInProgress(wb.root), 'GIT_CONFLICT', 'A merge from GitHub is already in progress. Resolve conflicts and finish it first.');
  try { git(wb.root, ['diff', '--cached', '--quiet']); } catch { throw new WorkbenchError('GIT_STAGED', `Some files are staged in Git on this machine. Commit or unstage them in your Git tool, then ${verb} again.`); }
  settleBookkeeping(wb, ref);
  const overlap = incomingOverlap(wb, ref);
  if (overlap.items.length || overlap.paths.length) throw new WorkbenchError('GIT_DIRTY', `GitHub has changes to ${describeOverlap(overlap)}, which you also changed on this machine. Approve or discard those drafts, then ${verb} again.`);
  return overlap;
}

export type PullResult = { status: 'pulled'; count: number } | { status: 'merged'; count: number } | { status: 'current' } | { status: 'diverged'; ahead: number; behind: number } | { status: 'blocked'; items: Overlap['items']; paths: string[] };
/**
 * Pull without the network: brings in what the last fetch brought. A fast-forward when this machine has no commits of its own;
 * otherwise a merge commit, made without touching the working tree, as long as no item changed on both sides (`diverged` then:
 * the user chooses in Merge from GitHub). Drafts are never moved, stashed or rewritten; the pull is refused (naming the items)
 * when GitHub changed something that is a draft here. Manifests and organisation changed on both sides are merged.
 */
export function pullFetched(wb: Workbench): PullResult {
  const result = withLock(wb.canonical, (): PullResult => {
    try {
      invariant(gitStatus(wb.root).attached, 'NOT_A_REPOSITORY', 'Attach a Git repository first.');
      try { git(wb.root, ['rev-parse', '--verify', '@{upstream}']); } catch { throw new WorkbenchError('NO_UPSTREAM', 'This branch is not on GitHub yet. Approve something to push it first.'); }
      const behind = Number(git(wb.root, ['rev-list', '--count', 'HEAD..@{upstream}']).trim()) || 0;
      const ahead = Number(git(wb.root, ['rev-list', '--count', '@{upstream}..HEAD']).trim()) || 0;
      if (!behind) return { status: 'current' };
      invariant(!mergeInProgress(wb.root), 'GIT_CONFLICT', 'A merge from GitHub is in progress. Resolve conflicts and finish it first.');
      settleBookkeeping(wb);
      const aside = setAside(wb);
      let merged = false;
      try {
        const overlap = incomingOverlap(wb);
        if (overlap.items.length || overlap.paths.length) return { status: 'blocked', ...overlap };
        const target = ahead ? mergeCommit(wb, '@{upstream}') : '@{upstream}';
        if (!target) return { status: 'diverged', ahead, behind };
        try { git(wb.root, ['merge', '--ff-only', '--no-edit', target]); }
        catch (error) {
          const stderr = stderrOf(error);
          // Git checks before it writes anything, so a refusal here leaves every file as it was.
          if (/would be overwritten|untracked working tree files/i.test(stderr)) return { status: 'blocked', items: [], paths: stderr.split('\n').map(l => l.trim()).filter(l => l && !/^(error|hint|Please|Aborting|Updating)/i.test(l) && !l.endsWith(':')).slice(0, 20) };
          throw new WorkbenchError('GIT_SYNC_FAILED', stderr.split('\n').filter(l => l.trim()).join(' ').slice(0, 600) || 'git merge failed');
        }
        merged = true;
        return ahead ? { status: 'merged', count: behind } : { status: 'pulled', count: behind };
      } finally { if (merged) aside.reapply(); else aside.restore(); }
    } finally { wb.invalidateGit(); }
  });
  // New and changed items show at once rather than when the folder watcher catches up.
  if (result.status === 'pulled' || result.status === 'merged') wb.refresh();
  return result;
}
/** Whether GitHub, as of the last fetch, has `commit`. */
export function onGitHub(root: string, commit: string) {
  try { git(root, ['merge-base', '--is-ancestor', commit, '@{upstream}']); return true; } catch { return false; }
}
/**
 * Pushes this machine's commits. When GitHub refuses because another machine pushed first, fetches, brings those commits in
 * (see `pullFetched`) and pushes again. Run it in its turn in the Git queue; it fetches with `fetchHeld`.
 */
export async function pushToGitHub(wb: Workbench, fetcher: BackgroundFetch) {
  for (let attempt = 0; ; attempt++) {
    try { const state = push(wb.root); wb.invalidateGit(); return state; }
    catch (error) { if (!(error instanceof WorkbenchError && error.code === 'GIT_PUSH_REJECTED') || attempt >= 2) throw error; }
    const fetched = await fetcher.fetchHeld(0);
    if (fetched.error) throw new WorkbenchError('GIT_PUSH_FAILED', `GitHub has commits this machine does not have yet, and fetching them failed: ${fetched.error}`);
    const result = pullFetched(wb);
    if (result.status === 'blocked') throw new WorkbenchError('GIT_DIRTY', `GitHub has newer changes to ${describeOverlap(result)}, which you also changed on this machine. Approve or discard those drafts, then retry.`);
    if (result.status === 'diverged') throw new WorkbenchError('GIT_DIVERGED', 'GitHub has a different version of an item changed here. Pull, choose which to keep in Merge from GitHub, and this goes out with it.');
  }
}
