import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Brain, Clock, FileDiff, FileText, ListChecks, Loader2, MessageSquare, Search, Sparkles, Terminal, Wrench } from 'lucide-react';
import type { AgentJob, AgentJobSummary, AgentKind, AgentStep } from '../../../packages/agent/service';
import { activeRun } from '../../../packages/agent/run-notice';
import { entryTypeInfo } from '../../../packages/agent/distill';
import type { Analysis, ItemDetail, Provider, RunProviderId } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { ExperimentProject } from './ExperimentProject';
import { RevisionSelect } from './TrialLoop';
import { Field, Modal, providerName } from './components';
import { Markdown } from './Markdown';
import { useAgentJob, type JobLike } from './agent-job';

/** Announces a new run. Detail listens to jump to the tab where that kind of result appears. */
export function agentStarted(kind: AgentKind) { window.dispatchEvent(new CustomEvent('kiln:agent-started', { detail: { kind } })); }
const heading: Record<AgentKind, string> = { capture: 'notes', trial: 'experiment', derive: 'skill draft', distill: 'source analysis', chat: 'reply', score: 'score', tune: 'Tune', 'distill-repo': 'repository analysis' };
const entryLabel: Record<string, string> = { ...Object.fromEntries(Object.entries(entryTypeInfo).map(([type, info]) => [type, info.plural])), skill: 'skills' };
const stepIcon: Record<AgentStep['kind'], typeof Terminal> = { status: Loader2, message: MessageSquare, reasoning: Brain, command: Terminal, search: Search, file: FileText, tool: Wrench, todo: ListChecks, error: AlertTriangle };
export const tokens = (n: number) => n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();
const kilobytes = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString()} KB`;
export function useElapsed(job: Pick<JobLike, 'status' | 'startedAt' | 'finishedAt'>) {
  const [, tick] = useState(0);
  useEffect(() => { if (!activeRun(job)) return; const timer = setInterval(() => tick(t => t + 1), 1000); return () => clearInterval(timer); }, [job.status]);
  const seconds = Math.max(0, Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
/** What the run is doing and with what: model, effort, elapsed time, thread, tokens. Shown on every job so nothing about the CLI session stays hidden. */
function RunMeta({ job }: { job: JobLike }) {
  const elapsed = useElapsed(job);
  return <div className="run-meta">
    <span title="Model the CLI was asked to use">{job.model || (activeRun(job) ? 'Resolving model…' : 'CLI default model')}</span>
    {job.kind === 'trial' && <span title={job.workspace || 'Private run folder'}>Project: {job.workspace || 'Isolated example'}</span>}
    {job.effort && <span title="Reasoning effort">{job.effort} reasoning</span>}
    <span title="Wall-clock time">{elapsed}</span>
    {job.usage && <span title={`Input ${job.usage.input.toLocaleString()} (cached ${job.usage.cached.toLocaleString()}) · output ${job.usage.output.toLocaleString()}${job.usage.reasoning ? ` (reasoning ${job.usage.reasoning.toLocaleString()})` : ''}`}>{tokens(job.usage.input)} in · {tokens(job.usage.output)} out</span>}
    {job.threadId && <code title="CLI session id">{job.threadId.slice(0, 8)}</code>}
    {job.session && <span title="The CLI's own transcript of this session, saved in the run folder and bundled on the item as session.jsonl">session saved · {kilobytes(job.session.bytes)}</span>}
  </div>;
}
/** Compact one-line strip shown on every tab while a run is active, so the tab content underneath stays visible. */
export function AgentStatus({ itemId, jobs, onOpen }: { itemId: string; jobs: AgentJobSummary[]; onOpen: (kind: AgentKind) => void }) {
  // A queued run shows here too, as Queued, so it can be cancelled before it starts.
  const running = jobs.filter(job => job.itemId === itemId && activeRun(job));
  return <>{running.map(job => { const last = job.lastStep; return <div className="agent-status" key={job.id}>{job.status === 'queued' ? <Clock size={14} /> : <Loader2 size={14} className="spin"/>}<b>{providerName[job.provider]} {heading[job.kind]}</b><span>{job.status === 'queued' && 'Queued · '}{job.model && <>{job.model}{job.effort ? ` · ${job.effort}` : ''} · </>}{job.phase}{last ? ` · ${last.text.split('\n')[0].slice(0, 80)}` : ''}</span><button className="text-button" onClick={() => onOpen(job.kind)}>View</button><button className="text-button" onClick={() => void api('agent.cancel', { id: job.id })}>Cancel run</button></div>; })}</>;
}
/** A run's phase line and its steps. `steps` are the ones the caller already reads; without them they are read here. */
export function Steps({ job, steps: given }: { job: JobLike; steps?: AgentStep[] }) {
  useElapsed(job);
  const fetched = useAgentJob(given ? undefined : job), steps = given ?? fetched?.steps ?? [], count = stepCount(job);
  const quietSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(job.lastActivityAt ?? job.startedAt)) / 1000));
  return <>
    {job.status === 'running' && <p className="muted small" role="status">{job.phase}{job.process?.running ? ' · process running' : ''}{quietSeconds >= 15 ? ` · no new activity for ${quietSeconds}s` : ''}{quietSeconds >= 60 ? '. You can cancel or open Run files for details.' : ''}</p>}
    {count > 0 && <details className="agent-steps" open={job.status === 'running'}><summary>Activity · {count} step{count === 1 ? '' : 's'}</summary><StepList steps={steps} /></details>}
  </>;
}
/** How many steps a run has, from its summary or its full record. */
export const stepCount = (job: JobLike) => 'steps' in job ? job.steps.length : job.stepCount;
const StepList = ({ steps }: { steps: AgentStep[] }) => <ol>{steps.map(step => { const Icon = stepIcon[step.kind]; return <li key={step.id} className={step.kind}><Icon size={13} /><div><span className="step-kind">{step.kind === 'reasoning' ? 'reasoning summary' : step.kind}{step.status ? ` · ${step.status}` : ''} · {new Date(step.at).toLocaleTimeString()}</span><pre>{step.text}</pre></div></li>; })}</ol>;

/** Lets the user pick which signed-in CLI runs a job. Unavailable clients stay listed so the reason is visible. */
export function ProviderSelect({ providers, value, onChange, label = 'Run with', compact = false }: { providers: Provider[]; value: RunProviderId; onChange: (value: RunProviderId) => void; label?: string; /** Inline bars: only say something when the client is missing. */ compact?: boolean }) {
  const chosen = providers.find(p => p.id === value);
  return <Field label={label} hint={chosen ? chosen.available ? compact ? undefined : `${chosen.version} · uses its own sign-in, no API key` : `${chosen.label} was not found on PATH. Install it and sign in, then try again.` : undefined}>
    <select value={value} onChange={e => onChange(e.target.value as RunProviderId)}>{providers.filter(p => p.id !== 'copilot').map(p => <option key={p.id} value={p.id}>{p.label}{p.available ? '' : ' · not detected'}</option>)}</select>
  </Field>;
}
/** Starts a run the one way every entry point shares: the main process asks for consent, then `agentStarted` announces it. `revision` tests an earlier revision; omitted means the current one. */
export function useStart(kind: AgentKind, itemId: string, onClose: () => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const start = (provider: RunProviderId, context: string, workspace?: string, revision?: string) => { setBusy(true); setError(''); void api('agent.start', { id: itemId, kind, context, provider, workspace, revision }).then(() => { agentStarted(kind); setBusy(false); onClose(); }).catch(e => { setError(String(e)); setBusy(false); }); };
  return { busy, error, setError, start };
}
/** Runs a job again with its exact inputs: provider, project, context and revision, even if the item has been edited since. */
export const retryJob = (job: JobLike) => api('agent.start', { id: job.itemId, revision: job.revision, kind: job.kind, provider: job.provider, workspace: job.workspace, context: job.context }).then(() => agentStarted(job.kind));
export function AgentTrialDialog({ itemId, providers, initialWorkspace = '', defaultProvider, onClose, onManual, revisions }: { itemId: string; providers: Provider[]; initialWorkspace?: string; defaultProvider: RunProviderId; onClose: () => void; onManual: (workspace: string) => void; /** Offer a Revision selector over this item's history; without it the current revision runs. */ revisions?: ItemDetail }) {
  const [context, setContext] = useState(''), [provider, setProvider] = useState<RunProviderId>(defaultProvider);
  const { busy, error, start } = useStart('trial', itemId, onClose);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [revision, setRevision] = useState(revisions?.item.revision ?? '');
  return <Modal title="Run an experiment" subtitle="Test this revision against a project or an isolated example. The output and agent assessment are saved together." onClose={onClose}>
    <ProviderSelect providers={providers} value={provider} onChange={setProvider} />
    {revisions && <RevisionSelect detail={revisions} value={revision} onChange={setRevision} disabled={busy} />}
    <ExperimentProject value={workspace} onChange={setWorkspace} disabled={busy} />
    <p className="muted small">Experiments inspect files read-only. Tasks that require edits or unavailable tools are reported as uncertain.</p>
    <Field label="What should it try? (optional)"><textarea rows={4} value={context} onChange={e => setContext(e.target.value)} placeholder="Add an example input or the situation to test." /></Field>
    {error && <p role="alert" className="error-box">{error}</p>}
    <div className="modal-actions"><button className="text-button" disabled={busy} onClick={() => onManual(workspace)}>Manual handoff instead</button><button className="button primary" disabled={busy} onClick={() => start(provider, context, workspace, revisions && revision !== revisions.item.revision ? revision : undefined)}>{busy ? 'Starting…' : 'Run experiment'}</button></div>
  </Modal>;
}
export function CreateSkillDialog({ itemId, title, providers, defaultProvider, onClose }: { itemId: string; title: string; providers: Provider[]; defaultProvider: RunProviderId; onClose: () => void }) {
  const [context, setContext] = useState(''), [provider, setProvider] = useState<RunProviderId>(defaultProvider);
  const { busy, error, start } = useStart('derive', itemId, onClose);
  return <Modal title="Shape this into a skill" subtitle={title} onClose={onClose}>
    <div className="callout"><Sparkles size={18} /><span>The agent reads this item and drafts a complete SKILL.md following Kiln’s writing-for-agents guidance: sharp trigger description, steps with clear completion criteria, reference pushed behind pointers. The draft arrives as a new, unapproved skill linked to this source.</span></div>
    <ProviderSelect providers={providers} value={provider} onChange={setProvider} />
    <Field label="Anything the skill should focus on? (optional)"><textarea rows={3} value={context} onChange={e => setContext(e.target.value)} placeholder="Which situations it should cover, what to leave out, a preferred name…" /></Field>
    {error && <p role="alert" className="error-box">{error}</p>}
    <div className="modal-actions"><span className="muted">Nothing is installed. Review the draft first.</span><button className="button primary" disabled={busy} onClick={() => start(provider, context)}>{busy ? 'Starting…' : 'Draft the skill'}</button></div>
  </Modal>;
}
/** A chat reply's steps behind one collapsed line, so the answer stays on top; the phase line shows what a running turn is doing. */
export function ChatActivity({ job, steps: given }: { job: JobLike; /** Steps the caller already reads; without them they are read here. */ steps?: AgentStep[] }) {
  useElapsed(job);
  const fetched = useAgentJob(given ? undefined : job), steps = given ?? fetched?.steps ?? [], count = stepCount(job);
  const quietSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(job.lastActivityAt ?? job.startedAt)) / 1000));
  return <>
    {activeRun(job) && <p className="chat-phase" role="status">{job.status === 'queued' ? <><Clock size={13} />Queued · </> : <Loader2 size={13} className="spin" />}{job.phase}{quietSeconds >= 15 ? ` · no new activity for ${quietSeconds}s` : ''}</p>}
    {count > 0 && <details className="agent-steps chat-activity"><summary>Activity · {count} step{count === 1 ? '' : 's'}</summary><StepList steps={steps} /></details>}
  </>;
}
/** The muted line under a chat reply: model · time · tokens, then the CLI session and the run folder. */
export function ChatRunMeta({ job, onError }: { job: JobLike; onError: (message: string) => void }) {
  const elapsed = useElapsed(job);
  const usage = job.usage;
  return <div className="chat-meta">
    <span title="Model the CLI was asked to use">{job.model || (activeRun(job) ? 'Resolving model…' : 'CLI default model')}{job.effort ? ` · ${job.effort}` : ''}</span>
    <span title="Wall-clock time">{elapsed}</span>
    {usage && <span title={`Input ${usage.input.toLocaleString()} (cached ${usage.cached.toLocaleString()}) · output ${usage.output.toLocaleString()}${usage.reasoning ? ` (reasoning ${usage.reasoning.toLocaleString()})` : ''}`}>{tokens(usage.input)} in · {tokens(usage.output)} out</span>}
    {job.threadId && <code title={`CLI session id${job.session ? ` · transcript saved (${kilobytes(job.session.bytes)})` : ''}`}>{job.threadId.slice(0, 8)}</code>}
    <button type="button" className="chat-link" onClick={() => void api('desktop.openAgentJob', { id: job.id }).catch(e => onError(String(e)))}>Run files</button>
  </div>;
}
/** Result cards for this item's runs. `kinds` limits the card set to what belongs on the current tab. Conversations live in the library chat, not here. */
/** What an analysis produced, from the record kept in the library: shown when the run itself is not on this machine. */
export function AnalysisRecord({ analysis }: { analysis: Analysis }) {
  const counts = Object.entries(analysis.counts);
  return <section className="agent-result" aria-label="Recorded analysis">
    <div className="section-heading"><b>{providerName[analysis.provider]} {heading.distill}</b><span className="inline">{date(analysis.finishedAt)}</span></div>
    <div className="run-meta"><span>{analysis.model || 'CLI default model'}</span>{analysis.effort && <span>{analysis.effort} reasoning</span>}{analysis.usage && <span>{tokens(analysis.usage.input)} in · {tokens(analysis.usage.output)} out</span>}</div>
    <p>{analysis.summary}</p><p><b>Takeaway:</b> {analysis.takeaway}</p>
    <p className="distill-counts">{counts.map(([type, n]) => <span key={type}>{n} {n === 1 ? type : entryLabel[type] ?? type}</span>)}{!counts.length && <span>Nothing reusable found</span>}</p>
    {analysis.skipped && <p className="muted">Skipped: {analysis.skipped}</p>}
    <p className="muted small">The run’s steps and session stay on the machine that ran it; this summary travels with the library.</p>
  </section>;
}
/** A Tune run's card body: what it proposes and whether the user took it. */
function TuneOutcome({ job, onReview }: { /** The full record: the summary has no report. */ job: AgentJob; onReview?: (jobId: string) => void }) {
  const tune = job.tune, result = job.result && 'report' in job.result ? job.result : null;
  if (!tune || !result) return null;
  const n = tune.changes.length;
  return <>
    <p>{result.summary}</p>
    <p className="muted small">{tune.state === 'ready' ? `${n} file${n === 1 ? '' : 's'} changed · waiting for your review` : tune.state === 'accepted' ? `Accepted as draft revision ${shortHash(tune.revision ?? '')}` : tune.state === 'discarded' ? 'Discarded' : 'No changes'}</p>
    {onReview && <button className={`button ${tune.state === 'ready' ? 'primary' : ''}`} onClick={() => onReview(job.id)}><FileDiff size={14} />{tune.state === 'ready' ? 'Review changes' : 'Open report'}</button>}
  </>;
}
export function AgentPanel({ itemId, jobs, kinds, onOpen, onOpenCollection, collections, onReviewTune }: { itemId: string; jobs: AgentJobSummary[]; kinds?: AgentKind[]; onOpen: (id: string) => void; onOpenCollection?: (name: string) => void; /** Current collections: a run's collection may have been renamed or deleted since. */ collections?: string[]; /** Opens a Tune run's diff (Score.tsx's TuneReview). */ onReviewTune?: (jobId: string) => void }) {
  const [error,setError] = useState('');
  // A finished score lives on in the score panel; its card would say the same thing twice.
  const relevant = jobs.filter(job => job.itemId === itemId && job.kind !== 'chat' && (!kinds || kinds.includes(job.kind)) && !(job.kind === 'score' && job.status === 'completed'));
  return <>{error && <p className="error-box">{error}</p>}{relevant.map(job => <RunCard key={job.id} job={job} onOpen={onOpen} onOpenCollection={onOpenCollection} collections={collections} onReviewTune={onReviewTune} onError={setError} />)}</>;
}
/** One run's card. Its steps and result come from the full record, read while the card is shown. */
function RunCard({ job, onOpen, onOpenCollection, collections, onReviewTune, onError }: { job: AgentJobSummary; onOpen: (id: string) => void; onOpenCollection?: (name: string) => void; collections?: string[]; onReviewTune?: (jobId: string) => void; onError: (message: string) => void }) {
  const full = useAgentJob(job), result = job.result && full?.result;
  const retry = () => { void retryJob(job).catch(e => onError(String(e))); };
  return <section className="agent-result">
    <div className="section-heading"><b>{providerName[job.provider]} {heading[job.kind]}</b><span className="inline">{job.status === 'running' ? <Loader2 size={14} className="spin"/> : job.status === 'queued' && <Clock size={14} />}{job.status === 'running' ? job.phase : job.status === 'queued' ? `Queued · ${job.phase}` : job.status}</span></div>
    <RunMeta job={job} />
    {activeRun(job) && <button className="text-button" onClick={() => void api('agent.cancel', { id: job.id })}>Cancel run</button>}
    <Steps job={job} steps={full?.steps ?? []} />
    {job.error && <p className="error-box">{job.error}</p>}
    {result && full && ('report' in result ? <TuneOutcome job={full} onReview={onReviewTune} />
      : 'improvements' in result ? <p>Scored {result.score}/100</p>
      : 'entries' in result ? <><p>{result.summary}</p><p><b>Takeaway:</b> {result.takeaway}</p><p className="distill-counts">{Object.entries(result.entries.reduce<Record<string, number>>((acc, e) => { acc[e.type] = (acc[e.type] ?? 0) + 1; return acc; }, {})).map(([type, n]) => <span key={type}>{n} {n === 1 ? type : entryLabel[type] ?? type}</span>)}{!result.entries.length && <span>Nothing reusable found</span>}</p>{result.skipped && <p className="muted">Skipped: {result.skipped}</p>}{job.collection && onOpenCollection && (!collections || collections.includes(job.collection)) && <button className="button" onClick={() => onOpenCollection(job.collection!)}>Open “{job.collection}” <ArrowRight size={14} /></button>}</>
      : 'summary' in result ? <><p>{result.summary}</p>{result.extractedText && <details><summary>Extracted text</summary><pre className="prompt-preview">{result.extractedText}</pre></details>}<p><b>Next test:</b> {result.nextTest}</p>{result.limitations && <p className="muted">{result.limitations}</p>}</>
      : 'judgement' in result ? <><p><b>{result.judgement}</b> · Agent assessment</p><p>{result.note}</p><pre className="prompt-preview">{result.output}</pre></>
      : 'reply' in result ? <pre className="chat-text">{result.reply}</pre>
      : <><p>Drafted <b>{result.name}</b>: {result.description}</p>{result.notes && <p className="muted">{result.notes}</p>}{job.createdItemId && <button className="button" onClick={() => onOpen(job.createdItemId!)}>Open the draft skill <ArrowRight size={14} /></button>}</>)}
    <button className="text-button" onClick={() => void api('desktop.openAgentJob', { id: job.id }).catch(e => onError(String(e)))}>Run files</button>
    {['failed','cancelled','interrupted'].includes(job.status) && <button className="button" onClick={retry}>Retry with {providerName[job.provider]}</button>}
  </section>;
}
