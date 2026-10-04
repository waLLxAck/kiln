/**
 * The pure parts of how the renderer loads things without leaving a spinner up for good: the open item's state, the library
 * reload that coalesces callers, which focus events reload, and the cheap signatures that say whether a poll or a new
 * snapshot changed anything worth re-reading. Kept free of React and the bridge so the unit tests can use them.
 */
import type { AgentJob } from '../../../packages/agent/service';
import type { PublishJob, Snapshot } from '../../../packages/protocol/schema';

/** After this long a load says it is waiting for Kiln, and names what the backend is busy with when it can. */
export const WAITING_MS = 3000;
/** Focus events this soon after the last library load (or while the window is hidden) do not load it again. */
export const FOCUS_RELOAD_MS = 5000;
/** Alt+↑/↓ through items: the item is read once the keys rest this long, so held keys don't queue a read per step. */
export const STEP_READ_MS = 120;

/** The open item: loading (since when), failed (why), or shown. `data` stays while the same item is read again. */
export type DetailState<T> = { id: string; status: 'idle' | 'loading' | 'error' | 'ready'; data: T | null; error: string; since: number };
export type DetailAction<T> = { type: 'open'; id: string; at: number } | { type: 'loaded'; id: string; data: T } | { type: 'failed'; id: string; error: string } | { type: 'clear' };
export const idleDetail: DetailState<never> = { id: '', status: 'idle', data: null, error: '', since: 0 };

/**
 * Opening another item starts loading with nothing shown; reading the shown item again keeps it on screen (a failure then
 * leaves it there, and the caller reports the error elsewhere). Replies for an item that is no longer open are ignored.
 */
export function detailReducer<T>(state: DetailState<T>, action: DetailAction<T>): DetailState<T> {
  switch (action.type) {
    case 'clear': return state.status === 'idle' ? state : idleDetail;
    case 'open':
      if (action.id === state.id && state.data) return state.status === 'ready' ? state : { ...state, status: 'ready', error: '' };
      return { id: action.id, status: 'loading', data: null, error: '', since: action.at };
    case 'loaded': return action.id === state.id ? { id: action.id, status: 'ready', data: action.data, error: '', since: state.since } : state;
    case 'failed':
      if (action.id !== state.id) return state;
      return state.data ? state : { ...state, status: 'error', error: action.error };
  }
}

/**
 * Wraps a load so overlapping calls share it: a call while one is running gets one more run after it (shared by every caller
 * meanwhile), so whoever changed something and then asks still sees their change, and a burst of asks costs at most two loads.
 */
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null, again: Promise<void> | null = null;
  const start = (): Promise<void> => { const next = run().finally(() => { if (current === next) current = null; }); current = next; return next; };
  return () => {
    if (!current) return start();
    again ??= current.catch(() => undefined).then(() => { again = null; return start(); });
    return again;
  };
}

/** Whether a window focus should reload the library: not while hidden, and not again within FOCUS_RELOAD_MS of the last load. */
export const focusReloads = (now: number, lastLoad: number, hidden: boolean) => !hidden && now - lastLoad >= FOCUS_RELOAD_MS;

/** A job's summary may come without its steps; `stepCount` says how many there are. */
type JobSummary = Pick<AgentJob, 'id' | 'status' | 'phase'> & Partial<Pick<AgentJob, 'steps' | 'lastActivityAt' | 'finishedAt' | 'tune'>> & { stepCount?: number };
/** What the agent-jobs poll compares: a poll that changes none of these leaves the jobs (and every screen using them) alone. */
export const jobsSignature = (jobs: JobSummary[]) => jobs.map(j => `${j.id}:${j.status}:${j.phase}:${j.stepCount ?? j.steps?.length ?? 0}:${j.lastActivityAt ?? ''}:${j.finishedAt ?? ''}:${j.tune?.state ?? ''}`).join('|');

/** Publish jobs still on their way to GitHub. */
export const pendingPublish = <J extends Pick<PublishJob, 'status'>>(jobs: J[]) => jobs.filter(j => j.status !== 'done' && j.status !== 'failed');
/** Each publish job's id and status, to see whether polling `publish.jobs` changed anything. */
export const publishSignature = (jobs: Pick<PublishJob, 'id' | 'status'>[]) => jobs.map(j => `${j.id}:${j.status}`).join('|');

/**
 * What the item page shows from a snapshot, for one item: the item itself (revision, updatedAt, fields), its approvals, trials,
 * score, duplicate group and usage, and its finished runs. A new snapshot re-reads the open item only when this changed.
 */
export function itemStamp(snapshot: Pick<Snapshot, 'items' | 'approvals' | 'trials' | 'scores' | 'duplicates' | 'usage'>, id: string, jobs: Pick<AgentJob, 'id' | 'itemId' | 'status'>[] = []) {
  const item = snapshot.items.find(i => i.id === id);
  if (!item) return '';
  return JSON.stringify([item, snapshot.approvals.filter(a => a.itemId === id), snapshot.trials.filter(t => t.itemId === id), snapshot.scores?.[id] ?? null,
    snapshot.duplicates.find(g => g.ids.includes(id))?.ids ?? null, snapshot.usage[id] ?? null, jobs.filter(j => j.itemId === id && j.status !== 'running' && j.status !== 'queued').map(j => j.id)]);
}

/** What `backend.status` reports: requests waiting, the one running and for how long, and whether the worker is restarting. */
export type BackendStatus = { pending: number; running?: { method: string; ms: number }; restarting?: boolean };
/** "Waiting for Kiln… · busy with items.read for 12 s" style detail; empty when there is nothing useful to add. */
export function busyLine(status: BackendStatus | null) {
  if (!status) return '';
  if (status.restarting) return 'Kiln’s background worker is restarting';
  const seconds = status.running ? Math.max(1, Math.round(status.running.ms / 1000)) : 0;
  const parts = [!status.running ? '' : status.running.method === 'startup' ? `opening the library (${seconds} s)` : `busy with ${status.running.method} for ${seconds} s`, status.pending > 1 ? `${status.pending} requests waiting` : ''].filter(Boolean);
  return parts.join(' · ');
}

/** A request the renderer gave up waiting for (api.ts), so the screen can offer Retry. */
export const isTimeout = (error: unknown) => /^TIMEOUT\b/.test(error instanceof Error ? error.message : String(error));
/** An error as the sentence to show: without `Error: ` and the backend's `CODE: ` prefix. */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error: /, '').replace(/^[A-Z_]+: /, '');
