import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { invariant, WorkbenchError } from '../domain/errors';
import { noLinks } from '../storage/files';
import { isDedicated } from './service';

const exec = promisify(execFile);
const repoSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/);
export type GitHubState = { available: boolean; authenticated: boolean; login: string; repo: { nameWithOwner: string; url: string; isPrivate: boolean; defaultBranchRef: { name: string } | null } | null; error?: string };
async function gh(args: string[], cwd?: string, timeout = 45000) {
  try { return (await exec('gh', args, { cwd, windowsHide: true, timeout, maxBuffer: 5_000_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } })).stdout.trim(); }
  catch (error) { throw new WorkbenchError('GITHUB_FAILED', (error as { stderr?: string }).stderr?.trim() || 'GitHub CLI is unavailable or needs sign-in.'); }
}
export async function githubState(root: string): Promise<GitHubState> {
  try { await gh(['--version'], undefined, 5000); } catch { return { available: false, authenticated: false, login: '', repo: null, error: 'Install GitHub CLI to connect. Local library features work without it.' }; }
  let login: string;
  try { login = await gh(['api', 'user', '--jq', '.login'], undefined, 8000); } catch { return { available: true, authenticated: false, login: '', repo: null, error: 'Could not verify GitHub. Retry the connection check or sign in with GitHub CLI.' }; }
  let repo: GitHubState['repo'] = null;
  try { repo = JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner,url,isPrivate,defaultBranchRef'], root, 8000)); } catch { /* The chosen local library need not have a GitHub remote. */ }
  return { available: true, authenticated: true, login, repo };
}
type Repo = { nameWithOwner: string; url: string; isPrivate: boolean; description: string; updatedAt: string };
export async function listGitHubRepositories(): Promise<Repo[]> {
  return JSON.parse(await gh(['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,url,isPrivate,description,updatedAt']));
}
const dedicatedTopLevel = new Set(['kiln.json', 'KILN.md', 'README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', '.gitignore', '.gitattributes', 'workbench', '.kiln', '.github']);
/**
 * The user's repositories that are Kiln libraries: they carry a `kiln.json` in the Kiln format and, unless the manifest
 * says `dedicated`, nothing at the top level beyond the Kiln layout. Checked over the API so nothing is cloned to find out.
 */
export async function listKilnRepositories() {
  const repos = await listGitHubRepositories();
  const results: (Repo & { dedicated: boolean })[] = [];
  const check = async (repo: Repo) => {
    try {
      const raw = await gh(['api', `repos/${repo.nameWithOwner}/contents/kiln.json`, '--jq', '.content'], undefined, 15000);
      const manifest = JSON.parse(Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8')) as { format?: string; dedicated?: boolean };
      if (manifest.format !== 'kiln-library') return;
      let dedicated = manifest.dedicated === true;
      if (manifest.dedicated === undefined) {
        const names = JSON.parse(await gh(['api', `repos/${repo.nameWithOwner}/contents/`, '--jq', '[.[].name]'], undefined, 15000)) as string[];
        dedicated = names.every(name => dedicatedTopLevel.has(name));
      }
      if (dedicated) results.push({ ...repo, dedicated });
    } catch { /* No kiln.json, or unreadable: not a Kiln repository. */ }
  };
  // Eight at a time keeps a hundred repositories to a few seconds without tripping GitHub's abuse limits.
  const queue = [...repos];
  await Promise.all(Array.from({ length: 8 }, async () => { for (let next = queue.shift(); next; next = queue.shift()) await check(next); }));
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export type DefaultRepository = { repo: Repo; dedicated: boolean } | null;
export async function findDefaultRepository(run: typeof gh = gh): Promise<DefaultRepository> {
  const login = await run(['api', 'user', '--jq', '.login']);
  const fullName = repoSchema.parse(`${login}/my-kiln`);
  let raw: string;
  try { raw = await run(['api', `repos/${fullName}`]); }
  catch (error) { if (/HTTP 404/.test(String(error))) return null; throw error; }
  const value = JSON.parse(raw);
  const repo: Repo = { nameWithOwner: value.full_name, url: value.html_url, isPrivate: value.private, description: value.description ?? '', updatedAt: value.updated_at };
  let manifest: { format?: string; dedicated?: boolean };
  try {
    const content = await run(['api', `repos/${fullName}/contents/kiln.json`, '--jq', '.content']);
    manifest = JSON.parse(Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || /HTTP 404/.test(String(error))) return { repo, dedicated: false };
    throw error;
  }
  let dedicated = manifest?.format === 'kiln-library' && manifest.dedicated === true;
  if (manifest?.format === 'kiln-library' && manifest.dedicated === undefined) {
    const names = JSON.parse(await run(['api', `repos/${fullName}/contents/`, '--jq', '[.[].name]'])) as string[];
    dedicated = names.every(name => dedicatedTopLevel.has(name));
  }
  return { repo, dedicated };
}
export async function cloneGitHub(input: unknown) {
  const data = z.object({ repo: repoSchema, parent: z.string().min(1) }).parse(input);
  invariant(path.isAbsolute(data.parent), 'INVALID_PATH', 'Choose a parent folder.'); fs.mkdirSync(data.parent, { recursive: true });
  noLinks(data.parent); invariant(fs.statSync(data.parent).isDirectory(), 'INVALID_PATH', 'Choose an existing parent folder.');
  const root = path.join(data.parent, data.repo.split('/')[1]);
  if (fs.existsSync(root)) {
    noLinks(root);
    let remote = '';
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    invariant(path.resolve(top).toLowerCase() === path.resolve(root).toLowerCase(), 'FOLDER_EXISTS', 'That folder is inside another repository. Choose a different parent folder.');
    try { remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* A conflicting folder must never be overwritten. */ }
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/.exec(remote.replace(/\.git$/, ''));
    invariant(match?.[1].toLowerCase() === data.repo.toLowerCase() && isDedicated(root), 'FOLDER_EXISTS', 'That folder already exists and is not a local copy of this Kiln repository. Choose a different parent folder.');
    return { root, standard: true, dedicated: true };
  }
  await gh(['repo', 'clone', data.repo, root]);
  // Only repositories Kiln created are libraries; a skills repository, even one carrying kiln.json, is a source to import from.
  return { root, standard: fs.existsSync(path.join(root, 'kiln.json')), dedicated: isDedicated(root) };
}
export async function publishGitHub(input: unknown) {
  const data = z.object({ root: z.string().min(1), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/), description: z.string().max(300).default('A Kiln-managed prompt and skill library'), visibility: z.enum(['private', 'public']).default('private'), confirm: z.literal(true) }).parse(input);
  noLinks(data.root); invariant(fs.existsSync(path.join(data.root, 'kiln.json')), 'NOT_STANDARD_REPOSITORY', 'Create or migrate the standard Kiln repository before publishing.');
  let remote = ''; try { remote = execFileSync('git', ['-C', data.root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* New local repository. */ }
  invariant(!remote, 'REMOTE_EXISTS', 'This repository already has an origin. Use Sync for the connected repository.');
  await gh(['repo', 'create', data.name, `--${data.visibility}`, '--description', data.description, '--source', data.root, '--remote', 'origin', '--push']);
  return githubState(data.root);
}
let loginProcess: ChildProcess | null = null;
let loginState = { status: 'idle', message: '' };
export function startGitHubLogin() {
  if (loginProcess) return loginState;
  loginState = { status: 'waiting', message: 'Opening GitHub device sign-in…' };
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { windowsHide: true, stdio: 'pipe' });
  loginProcess = child;
  const output = (data: Buffer) => {
    const text = data.toString().replace(/\x1b\[[0-9;]*m/g, '');
    loginState.message = (loginState.message + '\n' + text).slice(-4000);
    if (/press enter/i.test(text)) child.stdin?.write('\n');
  };
  child.stdout?.on('data', output); child.stderr?.on('data', output);
  child.on('error', error => { loginState = { status: 'failed', message: error.message }; loginProcess = null; });
  child.on('exit', code => { loginState.status = code === 0 ? 'complete' : 'failed'; loginProcess = null; });
  return loginState;
}
export function githubLoginStatus() { return loginState; }
