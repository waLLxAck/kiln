import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/**
 * Child processes for the agent CLIs and the tools a run needs (yt-dlp). A CLI is often a wrapper (npm, Scoop, Volta, a pip launcher)
 * whose own children inherit its output pipes, so a run counts as finished when the process exits, not when every pipe closes, and
 * cancelling or timing out stops the whole process tree.
 */

/** How long output may keep arriving after the process exited before Kiln closes the pipes from its side. */
export const EXIT_GRACE_MS = 1500;
/** How long a process tree has to stop after SIGTERM before it gets SIGKILL (POSIX). */
const KILL_GRACE_MS = 3000;

/** Spawn options every CLI process shares. On POSIX the child leads its own process group, so the tree can be stopped together. */
export const treeOptions = (): Pick<SpawnOptions, 'detached' | 'windowsHide'> => ({ detached: process.platform !== 'win32', windowsHide: true });

/** Stops a process and everything it started: `taskkill /T /F` on Windows; SIGTERM, then SIGKILL, to its process group elsewhere. */
export function killTree(child: ChildProcess) {
  const pid = child.pid; if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    return;
  }
  const signal = (name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch { try { if (child.exitCode === null && child.signalCode === null) child.kill(name); } catch { /* Already gone. */ } } };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
}

/**
 * Resolves once the process has exited and its output is read: on 'close', or `grace` ms after 'exit' when something it started still
 * holds the pipes open. The pipes are destroyed either way, so a surviving grandchild cannot keep the run, or Kiln, waiting.
 */
export function settled(child: ChildProcess, grace = EXIT_GRACE_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let done = false, timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => { done = true; clearTimeout(timer); for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy(); };
    child.on('error', error => { if (done) return; release(); reject(error); });
    child.on('exit', (code, signal) => { if (!done) timer = setTimeout(() => { if (done) return; release(); resolve({ code, signal }); }, grace); });
    child.on('close', (code, signal) => { if (done) return; release(); resolve({ code, signal }); });
  });
}

export type Captured = { code: number | null; output: string; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean };
/**
 * Runs a short command to the end and keeps the last `limit` characters of its output (`output` interleaves both streams). A timeout or
 * the signal stops its whole tree; the promise still settles if a grandchild keeps the pipes open. Rejects only when it cannot start.
 */
export function capture(executable: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv; limit?: number }): Promise<Captured> {
  const limit = options.limit ?? 1_000_000;
  if (options.signal?.aborted) return Promise.resolve({ code: null, output: '', stdout: '', stderr: '', timedOut: false, cancelled: true });
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], ...treeOptions() });
  let stdout = '', stderr = '', output = '', timedOut = false, cancelled = false;
  const keep = (text: string, data: unknown) => (text + String(data)).slice(-limit);
  child.stdout!.on('data', data => { stdout = keep(stdout, data); output = keep(output, data); });
  child.stderr!.on('data', data => { stderr = keep(stderr, data); output = keep(output, data); });
  const cancel = () => { cancelled = true; killTree(child); };
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
  return settled(child).then(({ code }) => { cleanup(); return { code, output, stdout, stderr, timedOut, cancelled }; }, error => { cleanup(); throw error; });
}

/**
 * Runs one step of a run with a time limit. `work` gets a signal that aborts when the run is cancelled or the time is up, and the step
 * ends then even if `work` ignores it: "Cancelled" when cancelled, `timeoutMessage` when the time ran out.
 */
export async function bounded<T>(signal: AbortSignal | undefined, ms: number, timeoutMessage: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), cancel = () => controller.abort();
  if (signal?.aborted) throw new Error('Cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  // The limit alone never keeps a process alive (the CLI, tests): the work it bounds does that.
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms); timer.unref?.();
  const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  stopped.catch(() => {});
  try { return await Promise.race([work(controller.signal), stopped]); }
  catch (error) { throw timedOut ? new Error(timeoutMessage) : error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
