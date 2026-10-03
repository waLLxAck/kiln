/**
 * How the desktop treats each backend call, shared by the main process (backend.ts) and the worker (backend-worker.ts).
 * Names are router methods for `rpc` calls and Workbench methods for direct ones.
 */

/**
 * Pure reads: no library change beyond the idempotent cache refresh every read does (reconciling external edits, the git status
 * cache). The worker runs them beside its ordered queue, so they never wait behind a mutation that is waiting on Git or the
 * network, and answers identical ones that arrive together with one result.
 */
export const pureReads = new Set(['paths', 'settings', 'snapshot', 'getRevision', 'referencePath', 'items.read', 'items.revision', 'items.list', 'items.search', 'items.origins', 'items.duplicates', 'deploy.installations', 'targets.list', 'observations.list', 'context.sessionStart', 'publish.jobs']);
/** Calls that legitimately take minutes (clones, pushes, pulls, waiting for the Git queue, whole-library imports): no deadline. */
export const longCalls = new Set(['attach', 'importLibrary', 'exportLibrary', 'repos.import', 'repos.source', 'github.clone', 'github.publish', 'github.login', 'git.sync', 'git.merge', 'git.finishMerge', 'sync.pull', 'sync.fetch', 'skills.sync', 'repository.create', 'repository.migrate', 'repository.upgrade', 'usage.scan']);
export const READ_DEADLINE_MS = 30_000;
export const CALL_DEADLINE_MS = 120_000;
/** How long the main process waits for an answer before giving up on a call; null for calls without a deadline. */
export function deadline(method: string): number | null {
  if (longCalls.has(method)) return null;
  return pureReads.has(method) ? READ_DEADLINE_MS : CALL_DEADLINE_MS;
}
/** The name a request is known by: the router method of an `rpc` call, otherwise the Workbench method. */
export const requestName = (method: string, args: unknown[]) => method === 'rpc' ? String(args[0]) : method;
