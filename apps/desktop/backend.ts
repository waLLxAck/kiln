import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { WorkbenchError } from '../../packages/domain/errors';
export class Backend {
  private worker: Worker;
  private sequence = 0;
  private agentProcesses = new Set<number>();
  private failure?: Error;
  private closing = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string; since: number; warned: boolean }>();
  /** `cli` tells the agent service where Kiln's own CLI can be run from, so a chat agent can change the library through it. */
  constructor(root: string, local: string, private log: (event: string, fields?: Record<string, unknown>) => void, cli: { node: string; script: string }) {
    this.worker = new Worker(path.join(__dirname, 'backend-worker.cjs'), { workerData: { root, local, cli } });
    this.worker.on('message', reply => {
      if (reply.telemetry) { if (reply.telemetry.event === 'agent.process') { const { pid, running } = reply.telemetry.fields; if (running) this.agentProcesses.add(pid); else this.agentProcesses.delete(pid); } this.log(reply.telemetry.event, reply.telemetry.fields); return; }
      const entry = this.pending.get(reply.id ?? reply.started);
      if (!entry) return;
      if (reply.started) { this.log('backend.started', { id: reply.started, method: entry.method, queueMs: Date.now() - entry.since }); return; }
      this.pending.delete(reply.id);
      this.log('backend.finished', { id: reply.id, method: entry.method, durationMs: Date.now() - entry.since, errorCode: reply.error?.code });
      if (reply.error) entry.reject(new WorkbenchError(reply.error.code, reply.error.message)); else entry.resolve(reply.data);
    });
    const fail = (error: Error) => { this.failure = error; this.log('backend.failed', { message: error.message }); for (const entry of this.pending.values()) entry.reject(error); this.pending.clear(); };
    this.worker.on('error', fail);
    this.worker.on('exit', code => { if (!this.closing) fail(new Error(`Background worker stopped (${code}). Restart Kiln.`)); });
    const timer = setInterval(() => { for (const [id, entry] of this.pending) if (!entry.warned && Date.now() - entry.since > 2000) { entry.warned = true; this.log('backend.slow', { id, method: entry.method, elapsedMs: Date.now() - entry.since, pending: this.pending.size }); } }, 1000);
    timer.unref();
    this.worker.once('exit', () => clearInterval(timer));
  }
  call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 100) return Promise.reject(new Error('Kiln is busy. Wait for the current operation to finish.'));
    const id = ++this.sequence;
    this.log('backend.queued', { id, method: method === 'rpc' ? args[0] : method });
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method: method === 'rpc' ? String(args[0]) : method, since: Date.now(), warned: false }); this.worker.postMessage({ id, method, args }); });
  }
  close() { this.closing = true; for (const pid of this.agentProcesses) { if (process.platform === 'win32') { const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); child.on('error', () => {}); } else { try { process.kill(pid); } catch {} } } void this.worker.terminate(); }
}
