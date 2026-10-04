import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

/**
 * Child processes for Git (and GitHub CLI) that never block the backend worker thread and never stay pending.
 *
 * - Each run has a deadline. When it passes, the whole process tree is killed (`taskkill /T /F` on Windows, the process group
 *   elsewhere), because a killed `git` can leave `git-remote-https` or a credential helper running.
 * - A run settles when the process exits, not when its pipes close: a surviving grandchild that still holds stdout must not keep
 *   the promise pending. Output that arrives shortly after the exit is still collected; then the pipes are destroyed.
 * - Network runs never prompt: no terminal prompt, no Git Credential Manager window, no SSH askpass, and a transfer that stalls is
 *   abandoned instead of waiting for the deadline.
 */
export type RunOptions = {
  input?: string | Buffer;
  /** Whole-run deadline. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Fetch, pull, push, clone or ls-remote: adds the no-prompt environment and configuration. */
  network?: boolean;
};
export type RunError = Error & { stdout: string; stderr: string; code: number | null; killed: boolean; aborted?: boolean };

/** Configuration for every background network Git call. `-c` options go before everything else on the command line. */
export const NETWORK_CONFIG = ['-c', 'credential.interactive=never', '-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30'];
export const NETWORK_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' } as const;
/** Deadline for a push or fetch; KILN_GIT_NETWORK_TIMEOUT_MS shortens it, for tests. */
export const networkTimeout = (fallback: number) => Number(process.env.KILN_GIT_NETWORK_TIMEOUT_MS) || fallback;
/** How long output is still read after the process exits, before pipes a grandchild holds open are destroyed. */
const DRAIN_MS = 250;
/** After a kill, how long to wait for the exit before giving up on the process and settling anyway. */
const KILL_GRACE_MS = 2_000;

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* Already gone. */ }
    return;
  }
  // The child leads its own process group (`detached` below), so this reaches helpers it started too.
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
}

/** Runs `command` and resolves with stdout as raw bytes. Rejects with stderr attached, like `execFile`. */
export function runRaw(command: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
  const { timeoutMs = 30_000, maxBuffer = 20_000_000, signal, network } = options;
  const env = network ? { ...process.env, ...options.env, ...NETWORK_ENV } : options.env ? { ...process.env, ...options.env } : process.env;
  const fullArgs = network && command === 'git' ? [...NETWORK_CONFIG, ...args] : args;
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error('Cancelled'), { stdout: '', stderr: '', code: null, killed: false, aborted: true })); return; }
    const child = spawn(command, fullArgs, { cwd: options.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, settled = false, killed = false, aborted = false, overflow = false, exitCode: number | null = null, exited = false;
    let drain: NodeJS.Timeout | undefined, grace: NodeJS.Timeout | undefined;
    const finish = (spawnError?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(drain); clearTimeout(grace); signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
      const stdout = Buffer.concat(out), stderr = Buffer.concat(err).toString('utf8');
      if (!spawnError && !killed && !overflow && exitCode === 0) { resolve(stdout); return; }
      const reason = spawnError?.message ?? (aborted ? 'Cancelled' : killed ? `${command} did not finish in ${Math.round(timeoutMs / 1000)} s` : overflow ? `${command} printed more than ${maxBuffer} bytes` : `${command} exited with code ${exitCode}`);
      reject(Object.assign(new Error(stderr.trim() ? `${reason}: ${stderr.trim().slice(0, 2000)}` : reason), { stdout: stdout.toString('utf8'), stderr, code: exitCode, killed, aborted }));
    };
    const stop = () => { if (exited) return; killTree(child.pid); grace = setTimeout(() => finish(), KILL_GRACE_MS); grace.unref?.(); };
    const deadline = setTimeout(() => { killed = true; stop(); }, timeoutMs);
    const onAbort = () => { aborted = true; killed = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBuffer) { overflow = true; stop(); return; } out.push(chunk); });
    child.stderr!.on('data', (chunk: Buffer) => { if (err.reduce((n, c) => n + c.length, 0) < 1_000_000) err.push(chunk); });
    // A process that exits without reading its input closes the pipe; that is not an error of ours.
    child.stdin!.on('error', () => {});
    child.on('error', error => finish(error));
    child.on('exit', code => {
      exited = true; exitCode = code;
      drain = setTimeout(() => finish(), DRAIN_MS); drain.unref?.();
    });
    child.on('close', () => finish());
    if (options.input !== undefined) child.stdin!.end(options.input); else child.stdin!.end();
  });
}
/** `runRaw` decoded as UTF-8. */
export async function run(command: string, args: string[], options: RunOptions = {}) {
  return (await runRaw(command, args, options)).toString('utf8');
}

/** Configuration for Kiln's own Git calls: no hooks and no filesystem monitor. */
export const GIT_BASE = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false'];
/** Async `git -C root …` with Kiln's base configuration. */
export function git(root: string, args: string[], options: RunOptions = {}) {
  return run('git', [...GIT_BASE, '-C', root, ...args], options);
}
/** The synchronous form, kept for short local commands that must happen under the library lock or answer a synchronous API. */
export function gitSync(root: string, args: string[], options: { input?: string | Buffer; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  return execFileSync('git', [...GIT_BASE, '-C', root, ...args], { encoding: 'utf8', input: options.input, windowsHide: true, timeout: options.timeoutMs ?? 30_000, maxBuffer: 20_000_000, stdio: ['pipe', 'pipe', 'pipe'], env: options.env ? { ...process.env, ...options.env } : process.env });
}

/**
 * Reads many objects (`HEAD:path`, blob ids) in one `git cat-file --batch`, instead of one `git show` per file. Missing objects
 * map to null. Names must not contain line breaks.
 */
export async function catFile(root: string, names: string[], options: RunOptions = {}): Promise<Map<string, Buffer | null>> {
  const result = new Map<string, Buffer | null>();
  const wanted = [...new Set(names)].filter(name => name && !/[\r\n]/.test(name));
  if (!wanted.length) return result;
  const raw = await runRaw('git', [...GIT_BASE, '-C', root, 'cat-file', '--batch'], { maxBuffer: 256_000_000, timeoutMs: 60_000, ...options, input: wanted.join('\n') + '\n' });
  let at = 0;
  for (const name of wanted) {
    const end = raw.indexOf(10, at); if (end < 0) break;
    const header = raw.subarray(at, end).toString('utf8'); at = end + 1;
    const match = /^[0-9a-f]+ (\S+) (\d+)$/.exec(header);
    if (!match) { result.set(name, null); continue; }
    const size = Number(match[2]);
    result.set(name, match[1] === 'blob' ? raw.subarray(at, at + size) : null);
    at += size + 1;
  }
  return result;
}

/** The repository's own folder and the folder shared by its worktrees, found without starting Git; null when not found. */
export function gitDirs(root: string): { git: string; common: string } | null {
  try {
    for (let folder = path.resolve(root); ; folder = path.dirname(folder)) {
      const dotGit = path.join(folder, '.git');
      if (fs.existsSync(dotGit)) {
        let dir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
          const named = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim(); if (!named) return null;
          dir = path.resolve(folder, named);
        }
        let common = dir;
        try { common = path.resolve(dir, fs.readFileSync(path.join(dir, 'commondir'), 'utf8').trim()); } catch { /* Not a linked worktree. */ }
        return { git: dir, common };
      }
      if (path.dirname(folder) === folder) return null;
    }
  } catch { return null; }
}
/** The commit HEAD points at, read from the repository's files; null when unborn or stored in a form this does not read (reftable). */
export function headCommit(root: string): string | null {
  const dirs = gitDirs(root); if (!dirs) return null;
  try {
    let value = fs.readFileSync(path.join(dirs.git, 'HEAD'), 'utf8').trim();
    for (let depth = 0; depth < 5 && value.startsWith('ref:'); depth++) {
      const name = value.slice(4).trim();
      if (!/^refs\/[A-Za-z0-9._/-]+$/.test(name) || name.split('/').includes('..')) return null;
      let next: string | null = null;
      for (const dir of [dirs.git, dirs.common]) { try { next = fs.readFileSync(path.join(dir, ...name.split('/')), 'utf8').trim(); break; } catch { /* Not loose here. */ } }
      if (next === null) {
        try { next = fs.readFileSync(path.join(dirs.common, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(` ${name}`))?.split(' ')[0] ?? null; } catch { next = null; }
      }
      if (next === null) return null;
      value = next;
    }
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value) ? value : null;
  } catch { return null; }
}
/** A merge is waiting to be finished; read from the repository's files, falling back to Git when they cannot be found. */
export function mergeInProgress(root: string) {
  const dirs = gitDirs(root);
  if (dirs) return fs.existsSync(path.join(dirs.git, 'MERGE_HEAD'));
  try { gitSync(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']); return true; } catch { return false; }
}
