import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { invariant, WorkbenchError } from '../domain/errors';
import { noLinks, safeRelative, withLock } from '../storage/files';
import { catFile, git, gitSync, networkTimeout } from './run';

const zeros = '0'.repeat(40);
/**
 * Commit an immutable projection without reading or replacing the user's working files. The tree is built in a private index
 * outside the library lock (Git objects and that index are Kiln's alone); only moving HEAD, a compare-and-swap Git refuses when
 * HEAD moved meanwhile, happens under the lock. Blobs are written by one `hash-object --stdin-paths` and the index changed by one
 * `update-index --index-info`, instead of two processes per file.
 */
export async function commitSnapshot(root: string, canonical: string, files: Record<string, string>, replace: string[], message: string) {
  Object.keys(files).forEach(safeRelative); replace.forEach(safeRelative);
  invariant(!(await git(root, ['diff', '--name-only', '--diff-filter=U'])).trim(), 'GIT_CONFLICT', 'Resolve Git conflicts before publishing.');
  fs.mkdirSync(canonical, { recursive: true });
  const index = path.join(canonical, `.git-index-${process.pid}-${randomUUID()}`), env = { GIT_INDEX_FILE: index };
  const run = async (args: string[], input?: string | Buffer) => (await git(root, args, { input, env })).trim();
  const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-blobs-'));
  try {
    let head = ''; try { head = await run(['rev-parse', '--verify', '-q', 'HEAD']); } catch { /* initial commit */ }
    await run(head ? ['read-tree', head] : ['read-tree', '--empty']);
    const removed = (await run(['ls-files', '-z'])).split('\0').filter(p => p && replace.some(prefix => p === prefix || p.startsWith(prefix + '/')));
    const names = Object.keys(files), sources = names.map((_, i) => path.join(blobs, String(i)));
    names.forEach((name, i) => fs.writeFileSync(sources[i], Buffer.from(files[name], 'base64')));
    // --no-filters stores the bytes exactly as given, as `hash-object --stdin` does.
    const shas = names.length ? (await run(['hash-object', '-w', '--no-filters', '--stdin-paths'], sources.join('\n') + '\n')).split('\n').map(l => l.trim()) : [];
    invariant(shas.length === names.length && shas.every(sha => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)), 'GIT_FAILED', 'Git did not store every file of this commit.');
    // Removals first, so a replaced folder ends up holding exactly the files written now.
    const entries = [...removed.map(file => `0 ${zeros}\t${file}`), ...names.map((file, i) => `100644 ${shas[i]}\t${file}`)];
    if (entries.length) await run(['update-index', '-z', '--index-info'], entries.join('\0') + '\0');
    const tree = await run(['write-tree']);
    if (head && tree === await run(['rev-parse', 'HEAD^{tree}'])) throw new WorkbenchError('NOTHING_TO_COMMIT', 'This approved snapshot is already committed.');
    const commit = await run(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message]);
    withLock(canonical, () => { gitSync(root, ['update-ref', 'HEAD', commit, head || zeros]); });
    // Only these paths are refreshed in the real index. The working tree, including later drafts, is untouched.
    const paths = [...new Set([...removed, ...names])];
    if (paths.length) await git(root, ['reset', '-q', 'HEAD', '--', ...paths]);
    return { commit };
  } finally { fs.rmSync(index, { force: true }); fs.rmSync(blobs, { recursive: true, force: true }); }
}
/** A JSON file as the last commit has it; `{}` when absent or unreadable. */
export async function committedJson(root: string, file: string): Promise<unknown> {
  safeRelative(file);
  try { const bytes = (await catFile(root, [`HEAD:${file}`])).get(`HEAD:${file}`); return bytes ? JSON.parse(bytes.toString('utf8')) : {}; } catch { return {}; }
}
/** The same, synchronously, for the single read a withdrawal makes when it is queued. */
export function committedJsonSync(root: string, file: string): unknown {
  safeRelative(file);
  try { return JSON.parse(gitSync(root, ['show', `HEAD:${file}`])); } catch { return {}; }
}

// stderr is captured, not inherited: expected failures such as "no upstream configured" must not reach the console.
const gitText = (root: string, args: string[]) => gitSync(root, args).trim();
export type GitState = { attached: boolean; branch: string; commit: string; changes: string[]; /** URL of the origin remote; empty when the repository has none. */ remote: string; /** Commits on this branch that origin does not have yet; every commit counts when the branch was never pushed. */ ahead: number; /** Commits on the upstream branch, as of the last fetch, that this branch does not have; 0 without an upstream. */ behind: number };
const unattached = (): GitState => ({ attached: false, branch: '', commit: '', changes: [], remote: '', ahead: 0, behind: 0 });
/**
 * One `git status --porcelain=v2 --branch` gives the branch, the commit, ahead/behind and the changes. `--no-optional-locks`
 * keeps a background status from taking the index lock that a commit or reset running beside it needs.
 */
const STATUS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch'];
/** Parses that output; changes are listed the way `git status --porcelain` lists them. */
function parseStatus(text: string) {
  let branch = '', commit = '', counts: { ahead: number; behind: number } | null = null;
  const changes: string[] = [], code = (xy: string) => xy.replace(/\./g, ' ');
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) { const oid = line.slice(13).trim(); commit = oid === '(initial)' ? '' : oid; }
    else if (line.startsWith('# branch.head ')) { const head = line.slice(14).trim(); branch = head === '(detached)' ? '' : head; }
    else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) counts = { ahead: Number(m[1]), behind: Number(m[2]) }; }
    else if (line.startsWith('1 ')) { const f = line.split(' '); changes.push(`${code(f[1])} ${f.slice(8).join(' ')}`); }
    else if (line.startsWith('2 ')) { const f = line.split(' '), [to, from] = f.slice(9).join(' ').split('\t'); changes.push(`${code(f[1])} ${from} -> ${to}`); }
    else if (line.startsWith('u ')) { const f = line.split(' '); changes.push(`${code(f[1])} ${f.slice(10).join(' ')}`); }
    else if (line.startsWith('? ')) changes.push(`?? ${line.slice(2)}`);
  }
  return { branch, commit, changes, counts };
}
/** A branch that has never been pushed has no ahead/behind line; then every commit counts as ahead, and nothing as behind. */
function state(parsed: ReturnType<typeof parseStatus>, remote: string, countAll: () => number): GitState {
  const { counts, ...rest } = parsed;
  let ahead = 0, behind = 0;
  if (remote && rest.commit) { if (counts) ({ ahead, behind } = counts); else ahead = countAll(); }
  return { attached: true, ...rest, remote, ahead, behind };
}
/** Git state of a repository, without blocking the thread: two processes, three when the branch was never pushed. */
export async function gitStatus(root: string): Promise<GitState> {
  try {
    const [status, remote] = await Promise.all([git(root, STATUS), git(root, ['remote', 'get-url', 'origin']).then(url => url.trim(), () => '')]);
    const parsed = parseStatus(status);
    const all = remote && parsed.commit && !parsed.counts ? Number((await git(root, ['rev-list', '--count', 'HEAD'])).trim()) || 0 : 0;
    return state(parsed, remote, () => all);
  } catch { return unattached(); }
}
/** The same for synchronous callers (setup checks, a commit of paths, the very first snapshot). */
export function gitStatusSync(root: string): GitState {
  try {
    const parsed = parseStatus(gitSync(root, STATUS));
    let remote = ''; try { remote = gitText(root, ['remote', 'get-url', 'origin']); } catch { /* No origin yet. */ }
    return state(parsed, remote, () => Number(gitText(root, ['rev-list', '--count', 'HEAD'])) || 0);
  } catch { return unattached(); }
}
/** Top-level files a Kiln-created repository may track besides the Kiln layout itself. */
const dedicatedExtras = new Set(['kiln.json', 'KILN.md', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', '.gitignore', '.gitattributes']);
const dedicatedFiles = (tracked: string) => tracked.split('\0').filter(Boolean).every(file => dedicatedExtras.has(file) || file.startsWith('workbench/') || file.startsWith('.kiln/') || file === '.github/workflows/kiln.yml');
function manifestDedicated(root: string): boolean | null | undefined {
  let manifest: { dedicated?: boolean };
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'kiln.json'), 'utf8')) as { dedicated?: boolean }; } catch { return null; }
  return typeof manifest.dedicated === 'boolean' ? manifest.dedicated : undefined;
}
/**
 * Whether a repository exists only to be a Kiln library. Repositories Kiln creates say so in kiln.json; older ones are
 * judged by what Git tracks. A skills repository that merely had the Kiln layout added (a `mine/` or `vendor/` tree,
 * docs, scripts) is an import source, not the library, however many items its workbench holds.
 */
export function isDedicated(root: string) {
  const said = manifestDedicated(root);
  if (said === null) return false;
  if (said !== undefined) return said;
  try { return dedicatedFiles(gitText(root, ['ls-files', '-z'])); }
  catch { return true; }
}
/** The same without blocking the thread. */
export async function isDedicatedAsync(root: string) {
  const said = manifestDedicated(root);
  if (said === null) return false;
  if (said !== undefined) return said;
  try { return dedicatedFiles(await git(root, ['ls-files', '-z'])); }
  catch { return true; }
}
export function inventory(root: string) {
  invariant(path.isAbsolute(root) && fs.statSync(root).isDirectory(), 'INVALID_PATH', 'Select an existing repository folder.'); noLinks(root);
  const state = gitStatusSync(root);
  invariant(state.attached, 'NOT_A_REPOSITORY', 'This folder is not a Git repository.');
  const files = gitText(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  return { ...state, root, resources: files.filter(f => /(^|\/)(SKILL\.md|AGENTS\.md|CLAUDE\.md)$|\.(md|txt|png|jpg|jpeg)$/i.test(f)).slice(0, 1000), totalFiles: files.length };
}
const libraryRelative = (root: string, canonical: string) => {
  const relative = path.relative(root, canonical).split(path.sep).join('/');
  invariant(!relative.startsWith('..') && relative !== '', 'INVALID_PATH', 'Canonical library must be inside the repository.');
  return relative;
};
/** Everything Kiln authors in a library, relative to the repository root. */
function managedPaths(root: string, relative: string) {
  return [`${relative}/items`, `${relative}/approvals`, `${relative}/experiments`, `${relative}/activity`, `${relative}/workbench.json`, `${relative}/.gitignore`, ...[`${relative}/installs.json`, 'kiln.json', 'KILN.md', '.kiln', '.github/workflows/kiln.yml'].filter(p => fs.existsSync(path.join(root, p)))];
}
/** Commits every Kiln-managed path at once. The desktop app commits per approval through `commitPaths` instead, so drafts stay local. */
export function checkpoint(root: string, canonical: string, message: string) {
  return commitPaths(root, canonical, managedPaths(root, libraryRelative(root, canonical)), message);
}
/**
 * Commits only the given repository-relative paths through a private index, so drafts of other items and the user's own
 * staged work stay out of the commit. Paths that were tracked and are now gone get their deletion recorded.
 */
export function commitPaths(root: string, canonical: string, paths: string[], message: string) {
  return withLock(canonical, () => {
    libraryRelative(root, canonical);
    const conflicts = gitText(root, ['diff', '--name-only', '--diff-filter=U']);
    invariant(!conflicts, 'GIT_CONFLICT', 'Resolve Git conflicts before committing.');
    const tracked = new Set(gitText(root, ['ls-files', '-z']).split('\0').filter(Boolean));
    const managed = [...new Set(paths)].filter(p => fs.existsSync(path.join(root, p)) || [...tracked].some(t => t === p || t.startsWith(p + '/')));
    invariant(managed.length > 0, 'NOTHING_TO_COMMIT', 'Nothing to commit for this item.');
    // A dedicated index prevents staged changes elsewhere from entering this commit.
    const index = path.join(canonical, `.git-index-${process.pid}`);
    const run = (args: string[]) => gitSync(root, args, { env: { GIT_INDEX_FILE: index } }).trim();
    try {
      try { run(['read-tree', 'HEAD']); } catch { run(['read-tree', '--empty']); }
      run(['add', '-A', '--', ...managed]);
      let headTree = ''; try { headTree = run(['rev-parse', 'HEAD^{tree}']); } catch { /* First commit. */ }
      if (run(['write-tree']) === headTree) throw new WorkbenchError('NOTHING_TO_COMMIT', 'These paths are already committed.');
      const commit = run(['commit', '-m', message]);
      // Refresh only our paths in the real index; leave unrelated staging untouched.
      gitText(root, ['reset', '-q', 'HEAD', '--', ...managed]);
      return { message: commit, ...gitStatusSync(root) };
    } finally { fs.rmSync(index, { force: true }); }
  });
}
/** git's explanation of a failed network command, without the progress chatter. */
const explain = (error: unknown) => String((error as { stderr?: string }).stderr || (error instanceof Error ? error.message : error)).trim();
/**
 * Pushes the current branch to origin, creating the upstream on first push. Fails with git's own explanation. Never prompts for
 * credentials: a push nobody is watching must not wait for a login window.
 */
export async function push(root: string) {
  const state = await gitStatus(root);
  invariant(state.attached, 'NOT_A_REPOSITORY', 'This library is not a Git repository.');
  invariant(state.remote, 'NO_REMOTE', 'This library has no GitHub remote yet. Finish the GitHub setup first.');
  try { await git(root, ['push', '-u', 'origin', 'HEAD'], { network: true, timeoutMs: networkTimeout(120_000) }); }
  catch (error) {
    const stderr = explain(error);
    if ((error as { killed?: boolean }).killed) throw new WorkbenchError('GIT_PUSH_FAILED', 'GitHub did not answer in time.');
    // Another machine pushed first: callers that can fetch and merge (sync.ts `pushToGitHub`) catch this and try again.
    if (/\[rejected\]|non-fast-forward|fetch first/i.test(stderr)) throw new WorkbenchError('GIT_PUSH_REJECTED', 'GitHub has commits this machine does not have yet. Pull from GitHub, then push again.');
    const reason = stderr.split('\n').map(l => l.trim()).filter(l => l && !/^(To |remote: ?$|branch '|\* \[new branch\]|hint:)/.test(l)).join(' ').slice(0, 600);
    throw new WorkbenchError('GIT_PUSH_FAILED', reason || 'git push failed');
  }
  return gitStatus(root);
}
export function gitDiff(root: string) { return gitText(root, ['diff', '--no-ext-diff', '--', 'workbench', 'kiln.json', 'KILN.md', '.kiln', '.github/workflows/kiln.yml']); }
/** Unified diff of one item's working files against the last commit; empty when the item is new or unchanged. Capped so it fits a commit-message prompt. */
export function itemDiff(root: string, canonical: string, itemId: string, limit = 20_000) {
  const relative = libraryRelative(root, canonical);
  let text = '';
  try { text = gitText(root, ['diff', '--no-ext-diff', 'HEAD', '--', `${relative}/items/${itemId}/content.md`, `${relative}/items/${itemId}/files`]); } catch { /* No HEAD yet: everything is new. */ }
  return text.length > limit ? text.slice(0, limit) + '\n… diff truncated' : text;
}
/**
 * The Settings buttons. The network part never holds the library lock or the thread; a pull fetches first and then only the
 * fast-forward, which changes working files, runs under the lock. Local drafts are uncommitted by design; git itself refuses
 * the fast-forward only when incoming commits touch the same files.
 */
export async function sync(root: string, canonical: string, action: 'fetch' | 'pull' | 'push') {
  invariant((await gitStatus(root)).attached, 'NOT_A_REPOSITORY', 'Attach a Git repository first.');
  try {
    let result: string;
    if (action === 'push') result = await git(root, ['push', '-u', 'origin', 'HEAD'], { network: true, timeoutMs: networkTimeout(120_000) });
    else {
      result = await git(root, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch'], { network: true, timeoutMs: networkTimeout(120_000) });
      if (action === 'pull') result = withLock(canonical, () => gitSync(root, ['merge', '--ff-only', '--no-edit', '@{upstream}']));
    }
    return { result: result.trim(), ...await gitStatus(root) };
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    const stderr = explain(error);
    if (/would be overwritten/i.test(stderr)) throw new WorkbenchError('GIT_DIRTY', 'GitHub has changes to items you have unapproved drafts of. Approve or discard those drafts, then pull again.');
    if (/not possible to fast-forward|diverge/i.test(stderr)) throw new WorkbenchError('GIT_DIVERGED', 'This machine and GitHub both have new approvals. Use “Merge from GitHub” to combine them.');
    throw new WorkbenchError('GIT_SYNC_FAILED', stderr.split('\n').filter(l => l.trim() && !/^(To |remote: ?$)/.test(l)).join(' ').slice(0, 600) || `git ${action} failed`);
  }
}
