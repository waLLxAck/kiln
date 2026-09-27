import type { AgentJob } from './service';
import type { RunProviderId } from '../protocol/schema';

/**
 * Conversations about an item, kept across closing the chat, switching items and restarting. Pure functions over agent jobs, shared by
 * the agent service and the desktop chat. What a turn changed is recorded on the job itself (`AgentJob.changes`).
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
