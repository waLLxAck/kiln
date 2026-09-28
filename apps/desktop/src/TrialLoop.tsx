import type { AgentJob } from '../../../packages/agent/service';
import type { Item, ItemDetail, Trial } from '../../../packages/protocol/schema';
import { date, shortHash } from './api';
import { Field, providerName } from './components';

/**
 * Improve and re-test from experiments: the pieces the experiments grid (Experiments.tsx), the Experiments page
 * (ExperimentsPage.tsx) and the Test dialog share. Asking the item chat to improve the item from a result, the user's own
 * verdicts on agent runs, and the revision picker.
 */

/**
 * Opens the item chat about `itemId` with `message` already typed in the composer, not sent. App.tsx listens for this event, reveals the
 * item and opens the chat with `initialMessage`. Anything may dispatch it; whoever reworks the chat must keep this event and the prefill.
 */
export const ASK_AGENT_EVENT = 'kiln:ask-agent';
export type AskAgentDetail = { itemId: string; message: string };
export function askAgent(itemId: string, message: string) { window.dispatchEvent(new CustomEvent<AskAgentDetail>(ASK_AGENT_EVENT, { detail: { itemId, message } })); }

export { experimentsOf, reviewOf, reviews, verdictOf } from './trial-verdicts';
import { reviewOf, verdictOf } from './trial-verdicts';
const who = (t: Trial) => t.provider === 'manual' ? 'Manual handoff' : providerName[t.provider];
const trimmed = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit).trimEnd()}\n…(trimmed)` : text;
/** "2 passed · 1 failed" over the verdicts that count, for a revision or an item. */
export const tally = (trials: Trial[], judged: Map<string, Trial>) => { const count = (v: string) => trials.filter(t => verdictOf(t, judged) === v).length; return [['pass', 'passed'], ['fail', 'failed'], ['uncertain', 'uncertain']].map(([v, word]) => [count(v), word] as const).filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(' · ') || 'no verdicts yet'; };

/** What "Improve with agent" types into the chat: the experiment's verdict, note and a trimmed excerpt of its output, and what to do about it. */
export function improveMessage(t: Trial, item: Item, job: AgentJob | undefined, review: Trial | undefined) {
  const output = job?.result && 'judgement' in job.result ? job.result.output : '';
  const current = t.revision === item.revision;
  return [
    `Please improve this ${item.kind} using the ${who(t)} experiment run on ${date(t.completedAt ?? t.createdAt)} (listed in context.md under Experiments). Revise the current revision with Kiln's CLI so it addresses what the experiment found, then tell me what you changed so I can re-test it.`,
    '',
    `Experiment: ${who(t)}, ${t.case} case, on ${current ? 'the current revision' : `the earlier revision ${shortHash(t.revision)}`}${job ? `, ${job.workspace ? `project ${job.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? job.workspace}` : 'isolated example'}` : ''}.`,
    `Verdict: ${t.judgement ?? t.status} (${t.mode === 'codex' ? 'agent assessment' : 'human judgement'})${review ? `; I marked it as ${review.judgement === 'pass' ? 'passed' : 'failed'}` : ''}.`,
    `Agent's note: ${trimmed(t.note || '(none)', 600)}`,
    ...(output ? ['', 'Output excerpt:', trimmed(output, 1200)] : []),
  ].join('\n');
}

/** Test dialog: which revision to run. The current revision is the default and follows new edits; older ones are pinned. */
export function RevisionSelect({ detail, value, onChange, disabled }: { detail: ItemDetail; value: string; onChange: (hash: string) => void; disabled?: boolean }) {
  const approved = new Set(detail.approvals.filter(a => a.trust === 'local' && !a.revokedAt).map(a => a.revision));
  const recent = detail.revisions.slice(0, 12);
  if (!recent.some(r => r.hash === value)) { const chosen = detail.revisions.find(r => r.hash === value); if (chosen) recent.push(chosen); }
  return <Field label="Revision" hint="Experiments run against this exact revision. Older revisions are tested as they were.">
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{recent.map(r => <option key={r.hash} value={r.hash}>{r.hash === detail.item.revision ? 'Current' : shortHash(r.hash)} · {r.summary.slice(0, 60)} · {date(r.createdAt)}{approved.has(r.hash) ? ' · approved' : ''}</option>)}</select>
  </Field>;
}
