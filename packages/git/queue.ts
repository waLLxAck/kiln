/**
 * One line for Git work that touches refs or the network: background fetches, pulls, approval and organisation commits and
 * pushes, and machine reports. Each task runs only after the one before it has settled, so a fetch never updates
 * `origin/<branch>` while a push is updating it, and a report is never built on refs a pull is moving.
 *
 * A task must not wait for another task on the same queue (that would wait forever); code already running in the queue calls
 * the `…Held` variant of what it needs, such as `BackgroundFetch.fetchHeld`.
 */
export class GitQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  /** Runs `task` after every task queued before it, and settles with its result. A failure is the caller's; the queue goes on. */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    this.waiting++;
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined).finally(() => { this.waiting--; });
    return result;
  }
  /** Tasks queued or running. */
  get pending() { return this.waiting; }
  /** Resolves once every task queued so far has settled. */
  idle(): Promise<void> { return this.tail.then(() => undefined); }
}
