import { WorkbenchError } from '../domain/errors';

/**
 * One line for Git work that touches refs or the network: background fetches, pulls, approval and organisation commits and
 * pushes, and machine reports. Each task runs only after the one before it has settled, so a fetch never updates
 * `origin/<branch>` while a push is updating it, and a report is never built on refs a pull is moving.
 *
 * A task must not wait for another task on the same queue (that would wait forever); code already running in the queue calls
 * the `…Held` variant of what it needs, such as `BackgroundFetch.fetchHeld`.
 *
 * Every Git process a task starts has its own timeout, so a task always ends. As a last resort the queue also gives each task a
 * deadline: past it, the task's caller gets a `GIT_TIMEOUT` error and the next task starts, so one stuck task cannot hold up
 * every later one.
 */
export class GitQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  /** `deadlineMs`: the longest one task may hold the queue. */
  constructor(private deadlineMs = Number(process.env.KILN_GIT_TASK_DEADLINE_MS) || 10 * 60_000) {}
  /** Runs `task` after every task queued before it, and settles with its result. A failure is the caller's; the queue goes on. */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    this.waiting++;
    const result = this.tail.then(() => new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new WorkbenchError('GIT_TIMEOUT', 'A Git task took too long and was abandoned. Retry it.')), this.deadlineMs);
      timer.unref?.();
      Promise.resolve().then(task).then(resolve, reject).finally(() => clearTimeout(timer));
    }));
    this.tail = result.then(() => undefined, () => undefined).finally(() => { this.waiting--; });
    return result;
  }
  /** Tasks queued or running. */
  get pending() { return this.waiting; }
  /** Resolves once every task queued so far has settled. */
  idle(): Promise<void> { return this.tail.then(() => undefined); }
}
