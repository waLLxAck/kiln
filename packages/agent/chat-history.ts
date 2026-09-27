import type { AgentJob } from './service';
import type { Item, Revision, RunProviderId } from '../protocol/schema';

/**
 * Conversations about an item kept across closing the chat, switching items and restarting, and the
 * library changes a turn made. Pure functions over agent jobs and revision history, shared by the agent service and the desktop chat.
 */

/** Chat turns about one item, oldest first. */
export const chatTurns = (jobs: AgentJob[], itemId: string) => jobs.filter(job => job.kind === 'chat' && job.itemId === itemId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

/** Turns from several sources, each once, oldest first. The first list wins for a turn present in both: it is the fresher copy. */
export function mergeTurns(...lists: AgentJob[][]) {
  const seen = new Map<string, AgentJob>();
  for (const list of lists) for (const job of list) if (!seen.has(job.id)) seen.set(job.id, job);
  return [...seen.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export type ChatSession = { conversationId: string; startedAt: string; lastAt: string; question: string; provider: RunProviderId; turns: number };
/** The conversations among these turns, most recently active first, each named by its first message. */
export function chatSessions(turns: AgentJob[]): ChatSession[] {
  const sessions = new Map<string, ChatSession>();
  for (const turn of [...turns].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (!turn.conversationId) continue;
    const known = sessions.get(turn.conversationId);
    if (known) { known.lastAt = turn.startedAt; known.turns++; }
    else sessions.set(turn.conversationId, { conversationId: turn.conversationId, startedAt: turn.startedAt, lastAt: turn.startedAt, question: turn.question ?? '', provider: turn.provider, turns: 1 });
  }
  return [...sessions.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Item ids that appear in the commands a turn ran (Kiln CLI calls such as `items update <id>`), other than the turn's own ids. */
export function mentionedIds(turn: AgentJob) {
  const own = new Set([turn.id, turn.conversationId, turn.threadId].filter(Boolean));
  const found = new Set<string>();
  for (const step of turn.steps) if (step.kind === 'command' || step.kind === 'tool') for (const match of step.text.match(uuid) ?? []) if (!own.has(match.toLowerCase())) found.add(match.toLowerCase());
  return [...found];
}

/** Items worth checking for changes made during a turn: the item it was about, items its commands named, and items made from it since it started. */
export function changeCandidates(turn: AgentJob, items: Item[]) {
  if (!turn.finishedAt) return [];
  const named = new Set([turn.itemId, ...mentionedIds(turn)]);
  return items.filter(item => item.updatedAt >= turn.startedAt && (named.has(item.id) || (item.origin?.itemId === turn.itemId && item.createdAt >= turn.startedAt && item.createdAt <= turn.finishedAt!)));
}

export type TurnChange = { itemId: string; title: string; /** Revision before the turn; null when the turn created the item. */ before: string | null; after: string; notes: string[]; current: string; /** The item is back at `before`. */ undone: boolean; deleted: boolean };
/**
 * What a finished turn did to one item, from its revision history (newest first): the revisions saved while the turn ran, the one
 * before them and the one they ended on. Null when nothing was saved in that time.
 */
export function turnChange(turn: AgentJob, detail: { item: Item; revisions: Revision[] }): TurnChange | null {
  if (!turn.finishedAt) return null;
  const made = detail.revisions.filter(r => r.createdAt >= turn.startedAt && r.createdAt <= turn.finishedAt!).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!made.length) return null;
  const after = made[0].hash, before = made.at(-1)!.parent;
  // Revisions are content-addressed, so Undo change (a restore of `before`) points the item back at that same revision.
  return { itemId: detail.item.id, title: detail.item.title, before, after, notes: made.map(r => r.summary).filter(Boolean).reverse(), current: detail.item.revision, deleted: Boolean(detail.item.deletedAt), undone: Boolean(before) && detail.item.revision === before };
}
