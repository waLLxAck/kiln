import { useState } from 'react';
import { ArrowRight, Check, Copy, FlaskConical, MessageSquare, RotateCcw, ShieldCheck, Trash2, X } from 'lucide-react';
import type { AgentJob } from '../../../packages/agent/service';
import type { Approval, Item, ItemDetail, Trial } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { agentStarted } from './AgentPanel';
import { Badge, Field, providerName } from './components';

/**
 * Improve and re-test from experiments (the `trialLoop` experimental feature): the Trials tab grouped by revision, re-testing the
 * current revision with a finished experiment's inputs, asking the item chat to improve the item from one, recording the user's own
 * verdict, and the Experiments section grouped by item and revision.
 */

/**
 * Opens the item chat about `itemId` with `message` already typed in the composer, not sent. App.tsx listens for this event, reveals the
 * item and opens the chat with `initialMessage`. Anything may dispatch it; whoever reworks the chat must keep this event and the prefill.
 */
export const ASK_AGENT_EVENT = 'kiln:ask-agent';
export type AskAgentDetail = { itemId: string; message: string };
export function askAgent(itemId: string, message: string) { window.dispatchEvent(new CustomEvent<AskAgentDetail>(ASK_AGENT_EVENT, { detail: { itemId, message } })); }

/** The user's verdicts on agent experiments are separate manual trials that point at the experiment they judged (see Workbench.judgeTrial). */
export const reviewOf = (t: Trial) => t.outputReference.startsWith('review-of:') ? t.outputReference.slice('review-of:'.length) : null;
export const experimentsOf = (trials: Trial[]) => trials.filter(t => !reviewOf(t));
/** The newest human judgement of each experiment, by experiment id. */
export function reviews(trials: Trial[]) {
  const latest = new Map<string, Trial>();
  for (const t of trials) { const id = reviewOf(t); if (id && (!latest.get(id) || latest.get(id)!.createdAt < t.createdAt)) latest.set(id, t); }
  return latest;
}
/** The verdict that counts: the user's own judgement when there is one, else the experiment's. */
export const verdictOf = (t: Trial, judged: Map<string, Trial>) => judged.get(t.id)?.judgement ?? t.judgement;
const who = (t: Trial) => t.provider === 'manual' ? 'Manual handoff' : providerName[t.provider];
const trimmed = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit).trimEnd()}\n…(trimmed)` : text;
const tally = (trials: Trial[], judged: Map<string, Trial>) => { const count = (v: string) => trials.filter(t => verdictOf(t, judged) === v).length; return [['pass', 'passed'], ['fail', 'failed'], ['uncertain', 'uncertain']].map(([v, word]) => [count(v), word] as const).filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(' · ') || 'no verdicts yet'; };

/** What "Improve with agent" types into the chat: the experiment's verdict, note and a trimmed excerpt of its output, and what to do about it. */
export function improveMessage(t: Trial, item: Item, job: AgentJob | undefined, review: Trial | undefined) {
  const output = job?.result && 'judgement' in job.result ? job.result.output : '';
  const current = t.revision === item.revision;
  return [
    `Please improve this ${item.kind} using the ${who(t)} experiment ${t.id} (listed in context.md under Experiments). Revise the current revision with Kiln's CLI so it addresses what the experiment found, then tell me what you changed so I can re-test it.`,
    '',
    `Experiment: ${who(t)}, ${t.case} case, on ${current ? 'the current revision' : `the earlier revision ${shortHash(t.revision)}`}${job ? `, ${job.workspace ? `project ${job.workspace}` : 'isolated example'}` : ''}.`,
    `Verdict: ${t.judgement ?? t.status} (${t.mode === 'codex' ? 'agent assessment' : 'human judgement'})${review ? `; I marked it as ${review.judgement === 'pass' ? 'passed' : 'failed'}` : ''}.`,
    `Agent's note: ${trimmed(t.note || '(none)', 600)}`,
    ...(output ? ['', 'Output excerpt:', trimmed(output, 1200)] : []),
  ].join('\n');
}

/** Test dialog: which revision to run. The current revision is the default and follows new edits; older ones are pinned. */
export function RevisionSelect({ detail, value, onChange, disabled }: { detail: ItemDetail; value: string; onChange: (hash: string) => void; disabled?: boolean }) {
  const approved = new Set(detail.approvals.filter(a => a.trust === 'local').map(a => a.revision));
  const recent = detail.revisions.slice(0, 12);
  if (!recent.some(r => r.hash === value)) { const chosen = detail.revisions.find(r => r.hash === value); if (chosen) recent.push(chosen); }
  return <Field label="Revision" hint="Experiments run against this exact revision. Older revisions are tested as they were.">
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{recent.map(r => <option key={r.hash} value={r.hash}>{r.hash === detail.item.revision ? 'Current' : shortHash(r.hash)} · {r.summary.slice(0, 60)} · {date(r.createdAt)}{approved.has(r.hash) ? ' · approved' : ''}</option>)}</select>
  </Field>;
}

type TrialsProps = { detail: ItemDetail; jobs: AgentJob[]; approved: boolean; /** The header's approve path for this item: Approve, or Approve & install for skills with locations. */ approve: { label: string; run: () => void }; onAction: (name: string, trial?: Trial) => void; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void> };
/** The Trials tab with trialLoop on: every experiment under the revision it tested, newest revision first, each with its verdict and next steps. */
export function TrialsByRevision({ detail, jobs, approved, approve, onAction, perform, refresh }: TrialsProps) {
  const { item } = detail;
  const judged = reviews(detail.trials), experiments = experimentsOf(detail.trials);
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const approvedRevisions = new Set(detail.approvals.filter(a => a.trust === 'local').map(a => a.revision));
  const revisionOf = new Map(detail.revisions.map(r => [r.hash, r]));
  const newest = (hash: string) => revisionOf.get(hash)?.createdAt ?? experiments.filter(t => t.revision === hash).map(t => t.createdAt).sort().at(-1) ?? '';
  const groups = [...new Set(experiments.map(t => t.revision))].sort((a, b) => a === item.revision ? -1 : b === item.revision ? 1 : newest(b).localeCompare(newest(a)));
  const running = jobs.some(j => j.itemId === item.id && j.kind === 'trial' && (j.status === 'running' || j.status === 'queued'));
  const retest = (t: Trial, job: AgentJob | undefined) => {
    // Without this machine's run record the project and context are unknown, so the Test dialog asks again.
    if (!job) { onAction('trial'); return; }
    void perform(async () => { await api('agent.start', { id: item.id, kind: 'trial', provider: job.provider, workspace: job.workspace, context: job.context }); agentStarted('trial'); });
  };
  const judge = (t: Trial, judgement: 'pass' | 'fail') => void perform(async () => { await api('trials.judge', { id: t.id, judgement }); await refresh(); }, judgement === 'pass' ? 'Marked as passed' : 'Marked as failed');
  const card = (t: Trial) => {
    const job = jobs.find(j => j.trialId === t.id), review = judged.get(t.id), verdict = verdictOf(t, judged), current = t.revision === item.revision;
    const output = job?.result && 'judgement' in job.result ? job.result.output : evidence[t.id];
    const agentRun = t.mode === 'codex', finished = t.status === 'completed';
    return <div className="trial-card trial-loop-card" key={t.id} aria-label={`${who(t)} experiment, ${date(t.createdAt)}`}>
      <div className="section-heading"><b>{who(t)} · {t.case === 'typical' ? 'Typical case' : 'Boundary case'}</b><span className="inline"><Badge status={t.judgement ?? t.status} />{review && <span className={`badge ${review.judgement}`} title="Your own judgement, kept separate from the agent assessment">you: {review.judgement}</span>}</span></div>
      <div className="detail-meta"><span>{agentRun ? 'Agent assessment' : 'Human judgement'}</span>{agentRun && <span title={job?.workspace || undefined}>Project: {job ? job.workspace || 'Isolated example' : 'not recorded on this machine'}</span>}<span>{date(t.completedAt ?? t.createdAt)}</span></div>
      <p>{t.note || t.task}</p>
      {review && <p className="muted small">You marked it as {review.judgement === 'pass' ? 'passed' : 'failed'} · {date(review.createdAt)}</p>}
      {output !== undefined && <details className="trial-output"><summary>Output</summary><pre className="prompt-preview">{output || 'No output available on this machine.'}</pre></details>}
      <div className="wrap-actions">
        {t.status === 'prepared' ? <><button className="button primary" onClick={() => onAction('result', t)}>Record result</button><button className="button" onClick={() => void perform(() => api('desktop.copyTrial', { id: t.id }), 'Handoff copied')}><Copy size={14} />Copy handoff</button></> : <>
          {finished && agentRun && <button className="button" disabled={running} title={running ? 'Wait for the active experiment on this item to finish' : `Same agent, project and context${current ? '' : ', on the item’s current revision'}`} onClick={() => retest(t, job)}><RotateCcw size={14} />{current ? 'Run again' : 'Re-test current revision'}</button>}
          {finished && <button className="button" title="Open the chat with a message about this result, ready to edit and send" onClick={() => askAgent(item.id, improveMessage(t, item, job, review))}><MessageSquare size={14} />Improve with agent</button>}
          {finished && agentRun && current && <><button className="button" aria-pressed={review?.judgement === 'pass'} onClick={() => judge(t, 'pass')}><Check size={14} />Mark as passed</button><button className="button" aria-pressed={review?.judgement === 'fail'} onClick={() => judge(t, 'fail')}><X size={14} />Mark as failed</button></>}
          {finished && current && !approved && verdict === 'pass' && <button className="button primary" onClick={approve.run}><ShieldCheck size={14} />{approve.label}</button>}
          {output === undefined && <button className="button" onClick={() => void perform(async () => { const local = await api<{ output: string; reference: string }>('desktop.trialOutput', { id: t.id }); setEvidence(e => ({ ...e, [t.id]: local.output || local.reference })); })}>View local evidence</button>}
          {job && <button className="text-button" onClick={() => void perform(() => api('desktop.openAgentJob', { id: job.id }))}>Run files</button>}
        </>}
        <button className="button danger-text" onClick={() => onAction('delete-trial', t)}><Trash2 size={14} />Delete experiment</button>
      </div>
    </div>;
  };
  return <>
    <div className="section-heading"><h3>Learn from real tasks</h3><button className="button" onClick={() => onAction('trial')}><FlaskConical size={15} />New trial</button></div>
    {!experiments.length && <p className="muted">Try a typical task and a boundary case. Keep your rubric and judgement alongside this revision.</p>}
    {groups.map(hash => { const revision = revisionOf.get(hash), inGroup = experiments.filter(t => t.revision === hash).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); const title = hash === item.revision ? approvedRevisions.has(hash) ? 'Current revision · approved' : 'Current draft' : approvedRevisions.has(hash) ? 'Approved' : 'Earlier revision';
      return <section className="trial-group" key={hash} aria-label={`${title} ${shortHash(hash)}`}>
        <div className="trial-group-head"><b>{title}</b><code>{shortHash(hash)}</code>{revision && <span>{date(revision.createdAt)} · {revision.summary}</span>}<span className="trial-tally">{inGroup.length} experiment{inGroup.length === 1 ? '' : 's'} · {tally(inGroup, judged)}</span></div>
        {inGroup.map(card)}
      </section>; })}
  </>;
}

type Verdict = 'all' | 'pass' | 'fail' | 'uncertain';
type TableProps = { trials: Trial[]; items: Item[]; approvals: Approval[]; busy: boolean; onOpen: (itemId: string) => void; onResult: (trial: Trial) => void; onDelete: (trial: Trial) => void };
/** The Experiments section with trialLoop on: experiments grouped by item, then revision, with a verdict filter. */
export function ExperimentsByItem({ trials, items, approvals, busy, onOpen, onResult, onDelete }: TableProps) {
  const [filter, setFilter] = useState<Verdict>('all');
  const judged = reviews(trials), experiments = experimentsOf(trials);
  const shown = experiments.filter(t => filter === 'all' || verdictOf(t, judged) === filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const itemIds = [...new Set(shown.map(t => t.itemId))];
  const approved = new Set(approvals.filter(a => a.trust === 'local').map(a => `${a.itemId}:${a.revision}`));
  return <>
    <div className="wrap-actions experiment-filter" role="group" aria-label="Filter experiments by verdict">{(['all', 'pass', 'fail', 'uncertain'] as const).map(v => <button key={v} className={`button ${filter === v ? 'primary' : ''}`} aria-pressed={filter === v} onClick={() => setFilter(v)}>{v === 'all' ? 'All' : v === 'pass' ? 'Pass' : v === 'fail' ? 'Fail' : 'Uncertain'}<small>{v === 'all' ? experiments.length : experiments.filter(t => verdictOf(t, judged) === v).length}</small></button>)}</div>
    {!shown.length ? <p className="muted">No experiments with this verdict.</p> : <div className="experiments-table experiments-grouped">{itemIds.map(itemId => {
      const item = items.find(i => i.id === itemId), rows = shown.filter(t => t.itemId === itemId), revisions = [...new Set(rows.map(t => t.revision))];
      return <section key={itemId} aria-label={item?.title ?? itemId}>
        <div className="table-group"><button className="text-button table-title" title="Open the item these experiments test" onClick={() => onOpen(itemId)}>{item?.title ?? itemId} <ArrowRight size={13} /></button><small>{rows.length} experiment{rows.length === 1 ? '' : 's'}</small></div>
        {revisions.map(hash => <div key={hash}>
          <div className="table-subgroup"><code>{shortHash(hash)}</code><span>{item?.revision === hash ? 'Current revision' : 'Earlier revision'}{approved.has(`${itemId}:${hash}`) ? ' · approved' : ''}</span><span>{tally(rows.filter(t => t.revision === hash), judged)}</span></div>
          {rows.filter(t => t.revision === hash).map(t => { const review = judged.get(t.id); return <div className="table-row" key={t.id}><div><b>{t.case === 'typical' ? 'Typical case' : 'Boundary case'}</b><small>{date(t.createdAt)}{review ? ` · you marked it ${review.judgement === 'pass' ? 'passed' : 'failed'}` : ''}</small></div><span>{who(t)}</span><code>{shortHash(t.revision)}</code><Badge status={verdictOf(t, judged) ?? t.status} /><div className="wrap-actions"><button className="text-button" onClick={() => t.status === 'prepared' ? onResult(t) : onOpen(t.itemId)}>{t.status === 'prepared' ? 'Record result' : 'Open item'} <ArrowRight size={13} /></button><button className="text-button danger-text" disabled={busy} onClick={() => onDelete(t)}><Trash2 size={14} />Delete experiment</button></div></div>; })}
        </div>)}
      </section>; })}</div>}
  </>;
}
