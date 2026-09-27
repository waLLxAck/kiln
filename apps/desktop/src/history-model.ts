import { trialPlace } from './trial-place';
import type { Activity, Approval, Installation, ItemDetail, PublishJob, Receipt, Revision, Snapshot, Trial } from '../../../packages/protocol/schema';

/** Who made a revision, as far as the stored record says: the author field is only the OS user, so the summary decides. */
export type RevisionAuthor = 'person' | 'agent' | 'import' | 'outside' | 'kiln';
export type HistoryEvent =
  | { type: 'revision'; id: string; at: string; revision: Revision; author: RevisionAuthor; approved: boolean; current: boolean }
  | { type: 'test'; id: string; at: string; trial: Trial; /** Where it ran (trial-place.ts). */ place: string }
  | { type: 'approved'; id: string; at: string; approval: Approval }
  | { type: 'unapproved'; id: string; at: string; revision: string }
  | { type: 'published'; id: string; at: string; job: PublishJob }
  | { type: 'installed'; id: string; at: string; receipt: Receipt }
  | { type: 'removed' | 'rolled-back'; id: string; at: string; activity: Activity }
  /** A copy edited outside Kiln. Drift is a current state with no timestamp, so it sits above everything else. */
  | { type: 'drift'; id: string; at: ''; installation: Installation };
export type HistoryType = HistoryEvent['type'];

export type HistoryFilter = 'all' | 'revisions' | 'tests' | 'approvals' | 'installs';
export const historyFilters: { id: HistoryFilter; label: string; types: HistoryType[] }[] = [
  { id: 'all', label: 'All', types: ['revision', 'test', 'approved', 'unapproved', 'published', 'installed', 'removed', 'rolled-back', 'drift'] },
  { id: 'revisions', label: 'Revisions', types: ['revision'] },
  { id: 'tests', label: 'Tests', types: ['test'] },
  { id: 'approvals', label: 'Approvals', types: ['approved', 'unapproved', 'published'] },
  { id: 'installs', label: 'Installs', types: ['installed', 'removed', 'rolled-back', 'drift'] },
];

export function revisionAuthor(revision: Revision, first: boolean, derived: boolean): RevisionAuthor {
  const summary = revision.summary.trim();
  if (/^External (file )?edit/i.test(summary)) return 'outside';
  if (/^Imported\b/i.test(summary) || (first && /^(local|local-import|repository):/.test(revision.source))) return 'import';
  // The first revision of an item an analysis or Create skill made was written by that agent.
  if (first && derived) return 'agent';
  if (/^(Filed as |Moved private session data)/.test(summary)) return 'kiln';
  return 'person';
}

/**
 * One item's history as typed events, newest first, from data the item page already holds: its revisions, trials and
 * approvals, and the snapshot's publish jobs, install receipts and activity for it. Nothing here asks the backend.
 */
export function buildHistory(detail: ItemDetail, snapshot: Pick<Snapshot, 'publish' | 'receipts' | 'activity'>, installations: Installation[], places: Map<string, string> = new Map()): HistoryEvent[] {
  const { item } = detail;
  const approved = new Set(detail.approvals.filter(a => a.trust === 'local').map(a => a.revision));
  const oldest = [...detail.revisions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const events: HistoryEvent[] = [
    ...detail.revisions.map(r => ({ type: 'revision' as const, id: `revision:${r.hash}`, at: r.createdAt, revision: r, author: revisionAuthor(r, r === oldest, Boolean(item.origin)), approved: approved.has(r.hash), current: r.hash === item.revision })),
    ...detail.trials.filter(t => !t.deletedAt).map(t => ({ type: 'test' as const, id: `test:${t.id}`, at: t.completedAt ?? t.createdAt, trial: t, place: trialPlace(t, places) })),
    ...detail.approvals.map(a => ({ type: 'approved' as const, id: `approved:${a.id}`, at: a.createdAt, approval: a })),
    ...snapshot.publish.filter(j => j.itemId === item.id && j.action === 'approve' && j.status === 'done').map(j => ({ type: 'published' as const, id: `published:${j.id}`, at: j.finishedAt ?? j.startedAt, job: j })),
    ...snapshot.receipts.filter(r => r.itemId === item.id).map(r => ({ type: 'installed' as const, id: `installed:${r.id}`, at: r.createdAt, receipt: r })),
    ...snapshot.activity.filter(a => a.itemId === item.id && ['uninstalled', 'rolled_back', 'unapproved'].includes(a.kind)).map(a => a.kind === 'unapproved'
      ? { type: 'unapproved' as const, id: `activity:${a.id}`, at: a.at, revision: a.revision ?? '' }
      : { type: a.kind === 'rolled_back' ? 'rolled-back' as const : 'removed' as const, id: `activity:${a.id}`, at: a.at, activity: a }),
  ];
  const drift = installations.filter(i => i.itemId === item.id && i.state === 'drifted').map(i => ({ type: 'drift' as const, id: `drift:${i.targetId}:${i.destination}`, at: '' as const, installation: i }));
  return [...drift, ...events.sort((a, b) => b.at.localeCompare(a.at) || rank[a.type] - rank[b.type])];
}
// Events at the same instant read in cause-to-effect order, newest first: an install after the approval after the save.
const rank: Record<HistoryType, number> = { drift: 0, installed: 1, removed: 1, 'rolled-back': 1, published: 2, approved: 3, unapproved: 3, test: 4, revision: 5 };

/** "Today", "Yesterday", "Sep 26", or "Sep 26, 2024" for another year: the separators between days in the timeline. */
export function dayLabel(at: string, now = new Date()): string {
  if (!at) return 'Now';
  const when = new Date(at), day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(when.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
export const timeLabel = (at: string) => at ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';

/** The folder a trial ran in, by its last segment; "Isolated example" when it had none. */
