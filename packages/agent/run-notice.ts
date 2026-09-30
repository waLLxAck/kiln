import type { AgentJob, AgentKind } from './service';

/**
 * What the backend tells the desktop when a run ends, and the words used to announce it. Shared by the main
 * process (desktop notifications) and the renderer (the in-app toast and the runs list), so both say the same thing.
 */

/** A run that has not ended: running now, or waiting for a free slot. Only one may be active per item and kind. */
export const activeRun = (job: Pick<AgentJob, 'status'>) => job.status === 'running' || job.status === 'queued';
export type RunFinished = { id: string; itemId: string; kind: AgentKind; status: AgentJob['status']; itemTitle: string; error?: string; judgement?: 'pass' | 'fail' | 'uncertain'; entries?: number; collection?: string; createdItemId?: string; createdTitle?: string; /** Score runs: the score out of 100. */ score?: number; /** Tune runs: how many files the proposal changes. */ changes?: number };
/** What each kind of run is called in a sentence of its own. */
export const runKindLabel: Record<AgentKind, string> = { capture: 'Capture', trial: 'Experiment', derive: 'Skill draft', distill: 'Distillation', chat: 'Chat reply', score: 'Score', tune: 'Tune', 'distill-repo': 'Repository distillation' };
const firstLine = (text: string, max = 120) => { const line = text.trim().split('\n')[0].trim(); return line.length > max ? line.slice(0, max - 1) + '…' : line; };

/** The event for a finished job. `title` looks up an item's current title; a trashed or missing item falls back to the kind. */
export function runFinished(job: AgentJob, title: (id: string) => string | undefined): RunFinished {
  const result = job.result as Record<string, unknown> | undefined;
  return {
    id: job.id, itemId: job.itemId, kind: job.kind, status: job.status, itemTitle: title(job.itemId) ?? runKindLabel[job.kind],
    ...(job.error ? { error: job.error } : {}),
    ...(result && typeof result.judgement === 'string' ? { judgement: result.judgement as RunFinished['judgement'] } : {}),
    ...((job.kind === 'distill' || job.kind === 'distill-repo') && job.status === 'completed' ? { entries: job.createdItemIds?.length ?? 0, ...(job.collection ? { collection: job.collection } : {}) } : {}),
    ...(job.kind === 'score' && job.status === 'completed' && typeof result?.score === 'number' ? { score: result.score } : {}),
    ...(job.kind === 'tune' && job.status === 'completed' && job.tune ? { changes: job.tune.changes.length } : {}),
    ...(job.createdItemId ? { createdItemId: job.createdItemId, createdTitle: title(job.createdItemId) ?? (typeof result?.name === 'string' ? result.name : undefined) } : {}),
  };
}

/**
 * The desktop notification for a finished run, or null when there is nothing to announce: the user cancelled it themselves,
 * or it was interrupted by Kiln closing. A run that timed out ends as failed, so it is announced.
 */
export function runNotice(event: RunFinished): { title: string; body: string } | null {
  if (event.status === 'failed') return { title: `Run failed · ${firstLine(event.error || 'The agent stopped without a result', 90)}`, body: `${runKindLabel[event.kind]} for “${event.itemTitle}”` };
  if (event.status !== 'completed') return null;
  if (event.kind === 'trial') return { title: `${event.judgement === 'pass' ? 'Experiment passed' : event.judgement === 'fail' ? 'Experiment failed' : 'Experiment finished'} · ${firstLine(event.itemTitle, 80)}`, body: event.judgement === 'uncertain' ? 'The agent was not sure. Open Trials to read why.' : 'Open Trials to read the output and assessment.' };
  if (event.kind === 'distill' || event.kind === 'distill-repo') return { title: `Distillation finished · ${event.entries ?? 0} ${event.entries === 1 ? 'entry' : 'entries'} from ${firstLine(event.itemTitle, 70)}`, body: event.collection ? `Filed under “${event.collection}”.` : 'Open the source to see what was made from it.' };
  if (event.kind === 'derive') return { title: `Skill draft ready${event.createdTitle ? ` · ${firstLine(event.createdTitle, 80)}` : ''}`, body: `Drafted from “${event.itemTitle}”. Review it before approving.` };
  if (event.kind === 'score') return { title: `Scored ${event.score ?? '?'}/100 · ${firstLine(event.itemTitle, 80)}`, body: 'Open it to see what would raise the score.' };
  if (event.kind === 'tune') return { title: `Tune finished · ${firstLine(event.itemTitle, 80)}`, body: event.changes ? `${event.changes} file${event.changes === 1 ? '' : 's'} changed. Review the diff before it becomes a draft.` : 'The run changed nothing. Open it to read the report.' };
  if (event.kind === 'chat') return { title: `Chat reply · ${firstLine(event.itemTitle, 80)}`, body: 'Open Kiln to read the reply.' };
  return { title: `${runKindLabel[event.kind]} finished · ${firstLine(event.itemTitle, 80)}`, body: 'Open Kiln to see the result.' };
}
