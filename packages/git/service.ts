import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { invariant, WorkbenchError } from '../domain/errors';
import { noLinks, safeRelative, withLock } from '../storage/files';

/** Commit an immutable projection without reading or replacing the user's working files. */
export function commitSnapshot(root: string, canonical: string, files: Record<string, string>, replace: string[], message: string) {
  return withLock(canonical, () => {
    invariant(!git(root, ['diff', '--name-only', '--diff-filter=U']), 'GIT_CONFLICT', 'Resolve Git conflicts before publishing.');
    Object.keys(files).forEach(safeRelative); replace.forEach(safeRelative);
    const index = path.join(canonical, `.git-index-${process.pid}`);
    const run = (args: string[], input?: Buffer) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', input, timeout: 30_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
    try {
      let head = ''; try { head = run(['rev-parse', 'HEAD']); } catch { /* initial commit */ }
      run(head ? ['read-tree', head] : ['read-tree', '--empty']);
      const removed = run(['ls-files', '-z']).split('\0').filter(p => p && replace.some(prefix => p === prefix || p.startsWith(prefix + '/')));
      for (const file of removed) run(['update-index', '--force-remove', '--', file]);
      for (const [file, content] of Object.entries(files)) {
        const blob = run(['hash-object', '-w', '--stdin'], Buffer.from(content, 'base64'));
        run(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
      }
      const tree = run(['write-tree']);
      if (head && tree === run(['rev-parse', 'HEAD^{tree}'])) throw new WorkbenchError('NOTHING_TO_COMMIT', 'This approved snapshot is already committed.');
      const commit = run(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message]);
      run(['update-ref', 'HEAD', commit, head || '0'.repeat(40)]);
      // Only these paths are refreshed in the real index. The working tree, including later drafts, is untouched.
      const paths = [...new Set([...removed, ...Object.keys(files)])];
      if (paths.length) git(root, ['reset', '-q', 'HEAD', '--', ...paths]);
      return { commit };
    } finally { fs.rmSync(index, { force: true }); }
  });
}
export function committedJson(root: string, file: string): unknown {
  safeRelative(file);
  try { return JSON.parse(git(root, ['show', `HEAD:${file}`])); } catch { return {}; }
}

function git(root: string, args: string[]) {
  // stderr is captured, not inherited: expected failures such as "no upstream configured" must not reach the console.
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 5_000_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export type GitState = { attached: boolean; branch: string; commit: string; changes: string[]; /** URL of the origin remote; empty when the repository has none. */ remote: string; /** Commits on this branch that origin does not have yet; every commit counts when the branch was never pushed. */ ahead: number };
export function gitStatus(root: string): GitState {
  try {
    const branch = git(root, ['branch', '--show-current']);
    let commit = ''; try { commit = git(root, ['rev-parse', 'HEAD']); } catch { /* A new repository has no HEAD yet. */ }
    let remote = ''; try { remote = git(root, ['remote', 'get-url', 'origin']); } catch { /* No origin yet. */ }
    let ahead = 0;
    if (remote && commit) { try { ahead = Number(git(root, ['rev-list', '--count', '@{u}..HEAD'])) || 0; } catch { ahead = Number(git(root, ['rev-list', '--count', 'HEAD'])) || 0; } }
    return { attached: true, branch, commit, changes: git(root, ['status', '--porcelain']).split('\n').filter(Boolean), remote, ahead };
  } catch { return { attached: false, branch: '', commit: '', changes: [], remote: '', ahead: 0 }; }
}
/** Top-level files a Kiln-created repository may track besides the Kiln layout itself. */
const dedicatedExtras = new Set(['kiln.json', 'KILN.md', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', '.gitignore', '.gitattributes']);
/**
 * Whether a repository exists only to be a Kiln library. Repositories Kiln creates say so in kiln.json; older ones are
 * judged by what Git tracks. A skills repository that merely had the Kiln layout added (a `mine/` or `vendor/` tree,
 * docs, scripts) is an import source, not the library, however many items its workbench holds.
 */
export function isDedicated(root: string) {
  let manifest: { dedicated?: boolean };
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'kiln.json'), 'utf8')) as { dedicated?: boolean }; } catch { return false; }
  if (typeof manifest.dedicated === 'boolean') return manifest.dedicated;
  try { return git(root, ['ls-files', '-z']).split('\0').filter(Boolean).every(file => dedicatedExtras.has(file) || file.startsWith('workbench/') || file.startsWith('.kiln/') || file === '.github/workflows/kiln.yml'); }
  catch { return true; }
}
export function inventory(root: string) {
  invariant(path.isAbsolute(root) && fs.statSync(root).isDirectory(), 'INVALID_PATH', 'Select an existing repository folder.'); noLinks(root);
  const state = gitStatus(root);
  invariant(state.attached, 'NOT_A_REPOSITORY', 'This folder is not a Git repository.');
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
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
    const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U']);
    invariant(!conflicts, 'GIT_CONFLICT', 'Resolve Git conflicts before committing.');
    const tracked = new Set(git(root, ['ls-files', '-z']).split('\0').filter(Boolean));
    const managed = [...new Set(paths)].filter(p => fs.existsSync(path.join(root, p)) || [...tracked].some(t => t === p || t.startsWith(p + '/')));
    invariant(managed.length > 0, 'NOTHING_TO_COMMIT', 'Nothing to commit for this item.');
    // A dedicated index prevents staged changes elsewhere from entering this commit.
    const index = path.join(canonical, `.git-index-${process.pid}`);
    const run = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
    try {
      try { run(['read-tree', 'HEAD']); } catch { run(['read-tree', '--empty']); }
      run(['add', '-A', '--', ...managed]);
      let headTree = ''; try { headTree = run(['rev-parse', 'HEAD^{tree}']); } catch { /* First commit. */ }
      if (run(['write-tree']) === headTree) throw new WorkbenchError('NOTHING_TO_COMMIT', 'These paths are already committed.');
      const commit = run(['commit', '-m', message]);
      // Refresh only our paths in the real index; leave unrelated staging untouched.
      git(root, ['reset', '-q', 'HEAD', '--', ...managed]);
      return { message: commit, ...gitStatus(root) };
    } finally { fs.rmSync(index, { force: true }); }
  });
}
/** Pushes the current branch to origin, creating the upstream on first push. Fails with git's own explanation. */
export function push(root: string) {
  const state = gitStatus(root);
  invariant(state.attached, 'NOT_A_REPOSITORY', 'This library is not a Git repository.');
  invariant(state.remote, 'NO_REMOTE', 'This library has no GitHub remote yet. Finish the GitHub setup first.');
  try { execFileSync('git', ['-c', 'core.hooksPath=', '-C', root, 'push', '-u', 'origin', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? error).trim();
    const reason = stderr.split('\n').map(l => l.trim()).filter(l => l && !/^(To |remote: ?$|branch '|\* \[new branch\])/.test(l)).join(' ').slice(0, 600);
    throw new WorkbenchError('GIT_PUSH_FAILED', reason || 'git push failed');
  }
  return gitStatus(root);
}
export function gitDiff(root: string) { return git(root, ['diff', '--no-ext-diff', '--', 'workbench', 'kiln.json', 'KILN.md', '.kiln', '.github/workflows/kiln.yml']); }
/** Unified diff of one item's working files against the last commit; empty when the item is new or unchanged. Capped so it fits a commit-message prompt. */
export function itemDiff(root: string, canonical: string, itemId: string, limit = 20_000) {
  const relative = libraryRelative(root, canonical);
  let text = '';
  try { text = git(root, ['diff', '--no-ext-diff', 'HEAD', '--', `${relative}/items/${itemId}/content.md`, `${relative}/items/${itemId}/files`]); } catch { /* No HEAD yet: everything is new. */ }
  return text.length > limit ? text.slice(0, limit) + '\n… diff truncated' : text;
}
export function sync(root: string, canonical: string, action: 'fetch' | 'pull' | 'push') {
  return withLock(canonical, () => {
    invariant(gitStatus(root).attached, 'NOT_A_REPOSITORY', 'Attach a Git repository first.');
    // Local drafts are uncommitted by design; git itself refuses a pull only when incoming commits touch the same files.
    try { const result = git(root, action === 'fetch' ? ['fetch'] : action === 'pull' ? ['pull', '--ff-only'] : ['push', '-u', 'origin', 'HEAD']); return { result, ...gitStatus(root) }; }
    catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? error).trim();
      if (/would be overwritten/i.test(stderr)) throw new WorkbenchError('GIT_DIRTY', 'GitHub has changes to items you have unapproved drafts of. Approve or discard those drafts, then pull again.');
      if (/not possible to fast-forward|diverge/i.test(stderr)) throw new WorkbenchError('GIT_DIVERGED', 'This machine and GitHub both have new approvals. Use “Merge from GitHub” to combine them.');
      throw new WorkbenchError('GIT_SYNC_FAILED', stderr.split('\n').filter(l => l.trim() && !/^(To |remote: ?$)/.test(l)).join(' ').slice(0, 600) || `git ${action} failed`);
    }
  });
}
