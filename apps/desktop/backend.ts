import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { WorkbenchError } from '../../packages/domain/errors';
import type { RunFinished } from '../../packages/agent/run-notice';
import { deadline as defaultDeadline, requestName } from './backend-routes';
/**
 * What the renderer shows while it waits (`backend.status`, answered by the main process without asking the worker): how many
 * calls are waiting, the call the worker is busy with and for how long (`startup` while it opens the library), and whether the
 * worker is restarting after a crash.
 */
export type BackendStatus = { pending: number; running?: { method: string; ms: number }; restarting?: boolean };
export type BackendOptions = {
  /** The worker script; tests pass a stand-in. */
  workerFile?: string;
  /** How often deadlines, slow calls and stalls are checked. */
  tickMs?: number;
  /** Silence from a ready worker longer than this is logged as `worker.stall`; the worker sends a heartbeat every second. */
  stallMs?: number;
  /** Wait before each restart after a crash; more crashes than this within `restartWindowMs` stop the worker for good. */
  restartDelays?: number[];
  restartWindowMs?: number;
  /** Milliseconds a call may take once the worker is ready, by name; null for none. Defaults to backend-routes.ts. */
  deadline?: (method: string) => number | null;
};
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; method: string; since: number; startedAt?: number; warned: boolean; posted: boolean; message: { id: number; method: string; args: unknown[] } };
export class Backend {
  private worker!: Worker;
  private sequence = 0;
  private agentProcesses = new Set<number>();
  private failure?: Error;
  private closing = false;
  /** Called once for every agent run that ends, with what the worker knows about it. */
  onAgentFinished?: (event: RunFinished) => void;
  private pending = new Map<number, Pending>();
  /** Calls given up on; a late answer is logged rather than delivered. */
  private abandoned = new Set<number>();
  private ready = false;
  private spawnedAt = 0;
  private readyAt = 0;
  private lastMessage = 0;
  private stall?: { since: number; method: string };
  /** Why the current worker is about to stop, when it said so (a library that cannot be opened). */
  private fatal?: { code: string; message: string };
  private lastError?: Error;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private restarts: number[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly workerFile: string;
  private readonly stallMs: number;
  private readonly restartDelays: number[];
  private readonly restartWindowMs: number;
  private readonly deadline: (method: string) => number | null;
  private markOpened!: () => void;
  private markFailed!: (error: Error) => void;
  /** Settles once a worker has opened the library, or with the reason Kiln cannot start after the restarts ran out. */
  opened = new Promise<void>((resolve, reject) => { this.markOpened = resolve; this.markFailed = reject; });
  /** `cli` tells the agent service where Kiln's own CLI can be run from, so a chat agent can change the library through it. */
  constructor(private root: string, private local: string, private log: (event: string, fields?: Record<string, unknown>) => void, private cli: { node: string; script: string }, options: BackendOptions = {}) {
    this.workerFile = options.workerFile ?? path.join(__dirname, 'backend-worker.cjs');
    this.stallMs = options.stallMs ?? 3000;
    this.restartDelays = options.restartDelays ?? [500, 2000, 5000];
    this.restartWindowMs = options.restartWindowMs ?? 120_000;
    this.deadline = options.deadline ?? defaultDeadline;
    this.opened.catch(() => {});
    this.spawn();
    this.timer = setInterval(() => this.tick(), options.tickMs ?? 1000);
    this.timer.unref();
  }
  private spawn() {
    const worker = this.worker = new Worker(this.workerFile, { workerData: { root: this.root, local: this.local, cli: this.cli } });
    this.ready = false; this.spawnedAt = this.lastMessage = Date.now(); this.stall = undefined; this.fatal = undefined; this.lastError = undefined;
    worker.on('message', reply => { if (worker === this.worker) this.receive(reply); });
    worker.on('error', error => { if (worker !== this.worker) return; this.lastError = error; this.log('backend.failed', { message: error.message }); });
    worker.on('exit', code => { if (worker === this.worker && !this.closing) this.crashed(code); });
    // Calls made while the previous worker was restarting, and those it never started, go to this one.
    for (const entry of this.pending.values()) if (!entry.posted) { entry.posted = true; worker.postMessage(entry.message); }
  }
  private receive(reply: any) {
    const at = Date.now(); this.lastMessage = at;
    if (this.stall) { this.log('worker.recovered', { method: this.stall.method, durationMs: at - this.stall.since }); this.stall = undefined; }
    if (reply.heartbeat) return;
    if (reply.ready) { this.ready = true; this.readyAt = at; this.log('worker.ready', { durationMs: at - this.spawnedAt, restarts: this.restarts.length }); this.markOpened(); return; }
    if (reply.fatal) { this.fatal = reply.fatal; return; }
    if (reply.agentFinished) { this.onAgentFinished?.(reply.agentFinished); return; }
    if (reply.telemetry) { if (reply.telemetry.event === 'agent.process') { const { pid, running } = reply.telemetry.fields; if (running) this.agentProcesses.add(pid); else this.agentProcesses.delete(pid); } this.log(reply.telemetry.event, reply.telemetry.fields); return; }
    const id = reply.id ?? reply.started, entry = this.pending.get(id);
    if (!entry) { if (reply.id && this.abandoned.delete(reply.id)) this.log('backend.late', { id: reply.id }); return; }
    if (reply.started) { entry.startedAt = at; this.log('backend.started', { id, method: entry.method, queueMs: at - entry.since }); return; }
    this.pending.delete(id);
    this.log('backend.finished', { id, method: entry.method, durationMs: at - entry.since, errorCode: reply.error?.code });
    if (reply.error) { entry.reject(new WorkbenchError(reply.error.code, reply.error.message)); return; }
    // A restarted worker opens the library the app last attached.
    if (entry.message.method === 'attach') this.root = String(entry.message.args[0]);
    entry.resolve(reply.data);
  }
  /** Agent runs the dead worker started are stopped too: nothing is left to save their results. */
  private stopAgents() {
    for (const pid of this.agentProcesses) { if (process.platform === 'win32') { const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); child.on('error', () => {}); } else { try { process.kill(pid); } catch {} } }
    this.agentProcesses.clear();
  }
  private crashed(code: number) {
    const at = Date.now(), reason = this.fatal?.message ?? this.lastError?.message;
    this.ready = false; this.stall = undefined; this.stopAgents();
    this.restarts = this.restarts.filter(time => at - time < this.restartWindowMs);
    if (this.restarts.length >= this.restartDelays.length) {
      const error = this.fatal ? new WorkbenchError(this.fatal.code, this.fatal.message) : new WorkbenchError('BACKEND_STOPPED', `Kiln's background worker stopped${reason ? `: ${reason}` : ` (${code})`}. Restart Kiln.`);
      this.failure = error; this.log('backend.stopped', { code, message: reason });
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear(); this.markFailed(error); return;
    }
    // Calls the worker had begun may have half run, so they fail; the rest never reached it and go to the next worker.
    const error = new WorkbenchError('BACKEND_RESTARTING', "Kiln's background worker stopped and is restarting. Try again in a moment.");
    let rejected = 0;
    for (const [id, entry] of this.pending) {
      if (entry.startedAt === undefined) { entry.posted = false; continue; }
      this.pending.delete(id); entry.reject(error); rejected++;
    }
    const delay = this.restartDelays[this.restarts.length]; this.restarts.push(at);
    this.log('backend.restarting', { code, message: reason, attempt: this.restarts.length, delayMs: delay, rejected, resent: this.pending.size });
    this.restartTimer = setTimeout(() => { this.restartTimer = undefined; if (!this.closing) this.spawn(); }, delay);
  }
  private tick() {
    const at = Date.now();
    for (const [id, entry] of this.pending) {
      if (!entry.warned && at - entry.since > 2000) { entry.warned = true; this.log('backend.slow', { id, method: entry.method, elapsedMs: at - entry.since, pending: this.pending.size }); }
      // Deadlines count from when the worker could answer, so opening a large library is not held against the first calls.
      const limit = this.ready ? this.deadline(entry.method) : null;
      if (limit === null || at - Math.max(entry.since, this.readyAt) <= limit) continue;
      this.pending.delete(id); this.abandoned.add(id);
      this.log('backend.timeout', { id, method: entry.method, elapsedMs: at - entry.since, started: entry.startedAt !== undefined, pending: this.pending.size });
      entry.reject(new WorkbenchError('TIMEOUT', 'Kiln took too long to answer'));
    }
    if (this.ready && !this.stall && at - this.lastMessage > this.stallMs) {
      const running = this.running(true);
      this.stall = { since: this.lastMessage, method: running?.method ?? 'background' };
      this.log('worker.stall', { method: this.stall.method, ms: running?.ms, silentMs: at - this.lastMessage, pending: this.pending.size });
    }
  }
  /**
   * The call the worker is busy with. A stalled worker is stuck in the call it began last; otherwise the oldest begun call is the
   * one the others are waiting behind.
   */
  private running(latest = Boolean(this.stall)) {
    let pick: Pending | undefined;
    for (const entry of this.pending.values()) if (entry.startedAt !== undefined && (!pick || (latest ? entry.startedAt > pick.startedAt! : entry.startedAt < pick.startedAt!))) pick = entry;
    return pick && { method: pick.method, ms: Date.now() - pick.startedAt! };
  }
  status(): BackendStatus {
    const status: BackendStatus = { pending: this.pending.size };
    if (this.restartTimer) status.restarting = true;
    const running = !this.ready && !this.failure ? { method: 'startup', ms: Date.now() - this.spawnedAt } : this.running();
    if (running) status.running = running;
    return status;
  }
  call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 100) return Promise.reject(new WorkbenchError('BACKEND_BUSY', 'Kiln is busy. Wait for the current operation to finish.'));
    const id = ++this.sequence, name = requestName(method, args);
    this.log('backend.queued', { id, method: name });
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject, method: name, since: Date.now(), warned: false, posted: !this.restartTimer, message: { id, method, args } };
      this.pending.set(id, entry);
      if (entry.posted) this.worker.postMessage(entry.message);
    });
  }
  /** An explicit startup Retry gets a new opening attempt after automatic restarts are exhausted. */
  retryOpening(): boolean {
    if (!this.failure || this.readyAt || this.closing) return false;
    this.failure = undefined; this.restarts = [];
    this.opened = new Promise<void>((resolve, reject) => { this.markOpened = resolve; this.markFailed = reject; });
    this.opened.catch(() => {});
    this.spawn();
    return true;
  }
  close() { this.closing = true; clearInterval(this.timer); clearTimeout(this.restartTimer); this.stopAgents(); void this.worker.terminate(); }
}
