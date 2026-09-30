import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { WorkbenchError, invariant } from '../domain/errors';
import { repoName, type GitHubRepoLink } from '../domain/github-url';

const exec = promisify(execFile);
/** Folder under the library's machine-private root that holds fetched repositories, one folder per commit. */
export const REPO_CACHE = 'repo-sources';
/** A checkout larger than this (files, not Git objects) is removed again and refused. */
export const MAX_CHECKOUT_BYTES = 300 * 1024 * 1024;
/** GitHub's own size estimate (KB of packed history) above which a repository is not fetched at all. */
const MAX_DISK_KB = 250_000;
/** Checkouts kept per repository; older commits are removed when a newer one arrives. */
const KEEP = 3;
/** One fetched commit of a repository. `scope` is the folder a `/tree/<ref>/<path>` link pointed at, '' for the whole repository. */
export type Checkout = { dir: string; commit: string; ref: string; scope: string };

/** Where a repository is fetched from. `KILN_GITHUB_REMOTE` replaces `https://github.com` (tests point it at local fixture repositories). */
export const remoteFor = (link: Pick<GitHubRepoLink, 'owner' | 'repo'>) => { const base = process.env.KILN_GITHUB_REMOTE; return base ? `${base.replace(/[\\/]+$/, '')}/${link.owner}/${link.repo}` : `https://github.com/${link.owner}/${link.repo}.git`; };
/**
 * Git with the checkout made inert: no hooks, no filesystem monitor, no symlinks (a link in a skill folder arrives as a small text
 * file naming its target, so nothing outside the checkout is ever read into the library), no LFS downloads and no prompts. GitHub
 * remotes authenticate through GitHub CLI's credential helper, so private repositories of the signed-in user work too.
 */
async function git(args: string[], signal?: AbortSignal, timeout = 180_000) {
  const github = !process.env.KILN_GITHUB_REMOTE;
  const config = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=false', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', ...(github ? ['-c', 'credential.https://github.com.helper=', '-c', 'credential.https://github.com.helper=!gh auth git-credential'] : [])];
  try { return (await exec('git', [...config, ...args], { windowsHide: true, timeout, signal, maxBuffer: 20_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' } })).stdout.trim(); }
  catch (error) {
    if (signal?.aborted) throw new Error('Cancelled');
    const stderr = String((error as { stderr?: string }).stderr ?? (error as Error).message ?? '');
    throw new WorkbenchError('REPOSITORY_UNAVAILABLE', stderr.trim().split('\n').filter(line => !/^hint:/.test(line)).slice(-3).join(' ') || 'Git could not fetch the repository.');
  }
}
/** Splits `<ref>/<path>` from a tree link against the repository's real branches and tags (a ref may itself contain slashes). */
async function resolveRef(remote: string, rest: string, signal?: AbortSignal): Promise<{ ref: string; scope: string }> {
  const parts = rest.split('/').filter(Boolean);
  if (parts.length <= 1) return { ref: parts[0] ?? '', scope: '' };
  const refs = new Set((await git(['ls-remote', '--heads', '--tags', remote], signal, 60_000)).split('\n').map(line => line.split('\t')[1]?.replace(/^refs\/(?:heads|tags)\//, '').replace(/\^\{\}$/, '')).filter(Boolean));
  for (let i = parts.length; i >= 1; i--) { const ref = parts.slice(0, i).join('/'); if (refs.has(ref)) return { ref, scope: parts.slice(i).join('/') }; }
  return { ref: parts[0], scope: parts.slice(1).join('/') };
}
/** Bytes of the files in a checkout, stopping as soon as the cap is passed. */
function treeBytes(dir: string, cap: number) {
  let total = 0; const stack = [dir];
  while (stack.length && total <= cap) {
    const folder = stack.pop()!;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) stack.push(full); else if (entry.isFile()) total += fs.statSync(full).size;
    }
  }
  return total;
}
const repoFolder = (local: string, link: Pick<GitHubRepoLink, 'owner' | 'repo'>) => path.join(local, REPO_CACHE, `${link.owner}__${link.repo}`.toLowerCase());
/** Keeps the newest checkouts of one repository and removes abandoned partial fetches. */
function prune(base: string, keep: string) {
  const entries = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => ({ name: e.name, at: fs.statSync(path.join(base, e.name)).mtimeMs }));
  const stale = entries.filter(e => e.name.startsWith('.fetch-') && Date.now() - e.at > 3_600_000);
  const old = entries.filter(e => !e.name.startsWith('.fetch-') && e.name !== keep).sort((a, b) => b.at - a.at).slice(KEEP - 1);
  for (const e of [...stale, ...old]) fs.rmSync(path.join(base, e.name), { recursive: true, force: true });
}
/** GitHub's size estimate, when GitHub CLI can tell; unknown sizes are fetched and checked afterwards. */
async function diskUsageKb(link: GitHubRepoLink) {
  if (process.env.KILN_GITHUB_REMOTE) return 0;
  try { return Number((await exec('gh', ['api', `repos/${repoName(link)}`, '--jq', '.size'], { windowsHide: true, timeout: 15_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })).stdout.trim()) || 0; } catch { return 0; }
}
/**
 * Shallow-fetches one commit of a repository into the machine-private cache (`<local>/repo-sources/<owner>__<repo>/<commit>`) and
 * checks it out without hooks or symlinks. `ref` empty means the default branch; a commit already in the cache is not fetched again.
 */
async function fetchCommit(local: string, link: GitHubRepoLink, ref: string, signal?: AbortSignal) {
  const base = repoFolder(local, link); fs.mkdirSync(base, { recursive: true });
  if (/^[0-9a-f]{40}$/i.test(ref) && fs.existsSync(path.join(base, ref.toLowerCase(), '.git'))) return path.join(base, ref.toLowerCase());
  const kb = await diskUsageKb(link);
  invariant(kb <= MAX_DISK_KB, 'REPOSITORY_TOO_LARGE', `${repoName(link)} is about ${Math.round(kb / 1024)} MB on GitHub. Kiln scans repositories up to ${Math.round(MAX_DISK_KB / 1024)} MB; link to the folder that holds the skills instead.`);
  const tmp = path.join(base, `.fetch-${randomUUID()}`);
  try {
    await git(['init', '-q', '--template=', tmp], signal, 30_000);
    await git(['-C', tmp, 'config', 'core.symlinks', 'false'], signal, 10_000);
    if (process.platform === 'win32') await git(['-C', tmp, 'config', 'core.longpaths', 'true'], signal, 10_000);
    await git(['-C', tmp, 'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', remoteFor(link), `+${ref || 'HEAD'}:refs/kiln/source`], signal).catch(async error => {
      // A commit or tag cannot be the source of a refspec on every server; fetch it plainly and read FETCH_HEAD instead.
      if (!ref) throw error;
      await git(['-C', tmp, 'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', remoteFor(link), ref], signal);
      await git(['-C', tmp, 'update-ref', 'refs/kiln/source', 'FETCH_HEAD'], signal, 10_000);
    });
    await git(['-C', tmp, 'checkout', '-q', '--detach', 'refs/kiln/source'], signal);
    const commit = (await git(['-C', tmp, 'rev-parse', 'HEAD'], signal, 10_000)).toLowerCase();
    invariant(treeBytes(tmp, MAX_CHECKOUT_BYTES) <= MAX_CHECKOUT_BYTES, 'REPOSITORY_TOO_LARGE', `${repoName(link)} is larger than ${MAX_CHECKOUT_BYTES / 1024 / 1024} MB checked out. Link to the folder that holds the skills instead.`);
    const dest = path.join(base, commit);
    if (fs.existsSync(dest)) fs.rmSync(tmp, { recursive: true, force: true }); else fs.renameSync(tmp, dest);
    fs.utimesSync(dest, new Date(), new Date()); prune(base, commit);
    return dest;
  } catch (error) { fs.rmSync(tmp, { recursive: true, force: true }); throw error; }
}
/** Fetches what a repository link names: its default branch, or the ref and folder of a `/tree/` or `/blob/` link. */
export async function fetchRepository(local: string, link: GitHubRepoLink, signal?: AbortSignal): Promise<Checkout> {
  const { ref, scope: named } = await resolveRef(remoteFor(link), link.rest, signal);
  const scope = link.blob ? path.posix.dirname(named) === '.' ? '' : path.posix.dirname(named) : named;
  const dir = await fetchCommit(local, link, ref, signal);
  if (scope) invariant(fs.existsSync(path.join(dir, ...scope.split('/'))) && fs.statSync(path.join(dir, ...scope.split('/'))).isDirectory(), 'PATH_NOT_FOUND', `${scope} is not a folder in ${repoName(link)}${ref ? ` at ${ref}` : ''}.`);
  return { dir, commit: path.basename(dir), ref, scope };
}
/** The checkout of one exact commit, fetched again if the cache no longer has it (an agent run retried days later). */
export async function checkoutAt(local: string, link: GitHubRepoLink, commit: string, signal?: AbortSignal) {
  invariant(/^[0-9a-f]{40}$/i.test(commit), 'INVALID_INPUT', 'A repository source records the commit it was read at.');
  return fetchCommit(local, link, commit, signal);
}
