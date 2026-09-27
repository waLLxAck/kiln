import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { Workbench } from '../domain/workbench';
import { invariant, WorkbenchError } from '../domain/errors';
import { atomicWrite, now, withLock } from '../storage/files';
import { gitStatus } from './service';

/**
 * Background sync with GitHub: a fetch that never waits in the backend queue, the overlap check that
 * lets Pull and Merge run beside drafts, and the fast-forward itself.
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
  private fetchedAt: string | null = null;
  private checkedAt: string | null = null;
  private error = '';
  /** `busy` says a publish job is committing or pushing; a fetch then waits for the next turn so the two never race for the same refs. */
  constructor(private wb: Workbench, private busy: () => boolean = () => false) {}
  status(): SyncStatus {
    if (!this.fetchedAt) {
      // A fetch from the command line or an earlier session counts too.
      try { this.fetchedAt = fs.statSync(path.resolve(this.wb.root, git(this.wb.root, ['rev-parse', '--git-path', 'FETCH_HEAD']).trim())).mtime.toISOString(); } catch { /* Never fetched. */ }
    }
    return { fetching: Boolean(this.running), fetchedAt: this.fetchedAt, checkedAt: this.checkedAt, error: this.error, ...syncTiming() };
  }
  /** Fetches unless the last attempt is younger than `maxAgeMs`. Joins a fetch already running instead of starting a second one. */
  async fetch(maxAgeMs = 0): Promise<SyncStatus> {
    if (this.running) { await this.running; return this.status(); }
    if (this.checkedAt && Date.now() - Date.parse(this.checkedAt) < maxAgeMs) return this.status();
    if (this.busy() || !this.wb.repositoryState().ready) return this.status();
    this.running = fetchOrigin(this.wb.root)
      .then(() => { this.error = ''; this.fetchedAt = now(); }, error => { this.error = error instanceof Error ? error.message : String(error); })
      .finally(() => { this.checkedAt = now(); this.running = null; this.wb.invalidateGit(); });
    await this.running;
    return this.status();
  }
  /** Resolves once no fetch is running. */
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

export type PullResult = { status: 'pulled'; count: number } | { status: 'current' } | { status: 'diverged'; ahead: number; behind: number } | { status: 'blocked'; items: Overlap['items']; paths: string[] };
/**
 * Pull without the network: fast-forwards to what the last fetch brought. Local drafts are never moved, stashed or rewritten;
 * the pull is refused (naming the items) when GitHub changed something that also changed here.
 */
export function pullFetched(wb: Workbench): PullResult {
  const result = withLock(wb.canonical, (): PullResult => {
    try {
      invariant(gitStatus(wb.root).attached, 'NOT_A_REPOSITORY', 'Attach a Git repository first.');
      try { git(wb.root, ['rev-parse', '--verify', '@{upstream}']); } catch { throw new WorkbenchError('NO_UPSTREAM', 'This branch is not on GitHub yet. Approve something to push it first.'); }
      const behind = Number(git(wb.root, ['rev-list', '--count', 'HEAD..@{upstream}']).trim()) || 0;
      const ahead = Number(git(wb.root, ['rev-list', '--count', '@{upstream}..HEAD']).trim()) || 0;
      if (!behind) return { status: 'current' };
      if (ahead) return { status: 'diverged', ahead, behind };
      invariant(!mergeInProgress(wb.root), 'GIT_CONFLICT', 'A merge from GitHub is in progress. Resolve conflicts and finish it first.');
      settleBookkeeping(wb);
      const overlap = incomingOverlap(wb);
      if (overlap.items.length || overlap.paths.length) return { status: 'blocked', ...overlap };
      try { git(wb.root, ['merge', '--ff-only', '--no-edit', '@{upstream}']); }
      catch (error) {
        const stderr = stderrOf(error);
        // Git checks before it writes anything, so a refusal here leaves every file as it was.
        if (/would be overwritten|untracked working tree files/i.test(stderr)) return { status: 'blocked', items: [], paths: stderr.split('\n').map(l => l.trim()).filter(l => l && !/^(error|hint|Please|Aborting|Updating)/i.test(l) && !l.endsWith(':')).slice(0, 20) };
        throw new WorkbenchError('GIT_SYNC_FAILED', stderr.split('\n').filter(l => l.trim()).join(' ').slice(0, 600) || 'git merge failed');
      }
      return { status: 'pulled', count: behind };
    } finally { wb.invalidateGit(); }
  });
  // New and changed items show at once rather than when the folder watcher catches up.
  if (result.status === 'pulled') wb.refresh();
  return result;
}
