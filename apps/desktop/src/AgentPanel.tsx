import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Brain, FileText, ListChecks, Loader2, MessageSquare, Search, Send, Sparkles, Terminal, Wrench } from 'lucide-react';
import type { AgentJob, AgentKind, AgentStep, ChatResult } from '../../../packages/agent/service';
import type { Provider, RunProviderId, Target } from '../../../packages/protocol/schema';
import { api } from './api';
import { ExperimentProject } from './ExperimentProject';
import { Field, Modal, providerName } from './components';

/** Announces a new run. Detail listens to jump to the tab where that kind of result appears. */
export function agentStarted(kind: AgentKind) { window.dispatchEvent(new CustomEvent('kiln:agent-started', { detail: { kind } })); }
const heading: Record<AgentKind, string> = { capture: 'notes', trial: 'experiment', derive: 'skill draft', distill: 'source analysis', chat: 'reply' };
const entryLabel: Record<string, string> = { prompt: 'prompts', tool: 'tools', technique: 'techniques', resource: 'resources', insight: 'insights' };
const stepIcon: Record<AgentStep['kind'], typeof Terminal> = { status: Loader2, message: MessageSquare, reasoning: Brain, command: Terminal, search: Search, file: FileText, tool: Wrench, todo: ListChecks, error: AlertTriangle };
const tokens = (n: number) => n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();
const kilobytes = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString()} KB`;
function useElapsed(job: AgentJob) {
  const [, tick] = useState(0);
  useEffect(() => { if (job.status !== 'running') return; const timer = setInterval(() => tick(t => t + 1), 1000); return () => clearInterval(timer); }, [job.status]);
  const seconds = Math.max(0, Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
/** What the run is doing and with what: model, effort, elapsed time, thread, tokens. Shown on every job so nothing about the CLI session stays hidden. */
function RunMeta({ job }: { job: AgentJob }) {
  const elapsed = useElapsed(job);
  return <div className="run-meta">
    <span title="Model the CLI was asked to use">{job.model || (job.status === 'running' ? 'Resolving model…' : 'CLI default model')}</span>
    {job.kind === 'trial' && <span title={job.workspace || 'Private run folder'}>Project: {job.workspace || 'Isolated example'}</span>}
    {job.effort && <span title="Reasoning effort">{job.effort} reasoning</span>}
    <span title="Wall-clock time">{elapsed}</span>
    {job.usage && <span title={`Input ${job.usage.input.toLocaleString()} (cached ${job.usage.cached.toLocaleString()}) · output ${job.usage.output.toLocaleString()}${job.usage.reasoning ? ` (reasoning ${job.usage.reasoning.toLocaleString()})` : ''}`}>{tokens(job.usage.input)} in · {tokens(job.usage.output)} out</span>}
    {job.threadId && <code title="CLI session id">{job.threadId.slice(0, 8)}</code>}
    {job.session && <span title="The CLI's own transcript of this session, saved in the run folder and bundled on the item as session.jsonl">session saved · {kilobytes(job.session.bytes)}</span>}
  </div>;
}
/** Compact one-line strip shown on every tab while a run is active, so the tab content underneath stays visible. */
export function AgentStatus({ itemId, jobs, onOpen }: { itemId: string; jobs: AgentJob[]; onOpen: (kind: AgentKind) => void }) {
  const running = jobs.filter(job => job.itemId === itemId && job.status === 'running');
  return <>{running.map(job => { const last = job.steps.at(-1); return <div className="agent-status" key={job.id}><Loader2 size={14} className="spin"/><b>{providerName[job.provider]} {heading[job.kind]}</b><span>{job.model && <>{job.model}{job.effort ? ` · ${job.effort}` : ''} · </>}{job.phase}{last ? ` · ${last.text.split('\n')[0].slice(0, 80)}` : ''}</span><button className="text-button" onClick={() => onOpen(job.kind)}>View</button><button className="text-button" onClick={() => void api('agent.cancel', { id: job.id })}>Cancel run</button></div>; })}</>;
}
function Steps({ job }: { job: AgentJob }) {
  useElapsed(job);
  const quietSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(job.lastActivityAt ?? job.startedAt)) / 1000));
  return <>
    {job.status === 'running' && <p className="muted small" role="status">{job.phase}{job.process?.running ? ' · process running' : ''}{quietSeconds >= 15 ? ` · no new activity for ${quietSeconds}s` : ''}{quietSeconds >= 60 ? '. You can cancel or open Run files for details.' : ''}</p>}
    {job.steps.length > 0 && <details className="agent-steps" open={job.status === 'running'}><summary>Activity · {job.steps.length} step{job.steps.length === 1 ? '' : 's'}</summary><ol>{job.steps.map(step => { const Icon = stepIcon[step.kind]; return <li key={step.id} className={step.kind}><Icon size={13} /><div><span className="step-kind">{step.kind === 'reasoning' ? 'reasoning summary' : step.kind}{step.status ? ` · ${step.status}` : ''} · {new Date(step.at).toLocaleTimeString()}</span><pre>{step.text}</pre></div></li>; })}</ol></details>}
  </>;
}

/** Lets the user pick which signed-in CLI runs a job. Unavailable clients stay listed so the reason is visible. */
export function ProviderSelect({ providers, value, onChange, label = 'Run with' }: { providers: Provider[]; value: RunProviderId; onChange: (value: RunProviderId) => void; label?: string }) {
  const chosen = providers.find(p => p.id === value);
  return <Field label={label} hint={chosen ? chosen.available ? `${chosen.version} · uses its own sign-in, no API key` : `${chosen.label} was not found on PATH. Install it and sign in, then try again.` : undefined}>
    <select value={value} onChange={e => onChange(e.target.value as RunProviderId)}>{providers.filter(p => p.id !== 'copilot').map(p => <option key={p.id} value={p.id}>{p.label}{p.available ? '' : ' · not detected'}</option>)}</select>
  </Field>;
}
function useStart(kind: AgentKind, itemId: string, onClose: () => void) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const start = (provider: RunProviderId, context: string, workspace?: string) => { setBusy(true); setError(''); void api('agent.start', { id: itemId, kind, context, provider, workspace }).then(() => { agentStarted(kind); onClose(); }).catch(e => { setError(String(e)); setBusy(false); }); };
  return { busy, error, start };
}
export function AgentTrialDialog({ itemId, providers, targets, initialWorkspace = '', defaultProvider, onClose, onManual }: { itemId: string; providers: Provider[]; targets: Target[]; initialWorkspace?: string; defaultProvider: RunProviderId; onClose: () => void; onManual: (workspace: string) => void }) {
  const [context, setContext] = useState(''), [provider, setProvider] = useState<RunProviderId>(defaultProvider);
  const { busy, error, start } = useStart('trial', itemId, onClose);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  return <Modal title="Run an experiment" subtitle="Test this revision against a project or an isolated example. The output and agent assessment are saved together." onClose={onClose}>
    <ProviderSelect providers={providers} value={provider} onChange={setProvider} />
    <ExperimentProject targets={targets} value={workspace} onChange={setWorkspace} disabled={busy} />
    <p className="muted small">Experiments inspect files read-only. Tasks that require edits or unavailable tools are reported as uncertain.</p>
    <Field label="What should it try? (optional)"><textarea rows={4} value={context} onChange={e => setContext(e.target.value)} placeholder="Add an example input or the situation to test." /></Field>
    {error && <p role="alert" className="error-box">{error}</p>}
    <div className="modal-actions"><button className="text-button" disabled={busy} onClick={() => onManual(workspace)}>Manual handoff instead</button><button className="button primary" disabled={busy} onClick={() => start(provider, context, workspace)}>{busy ? 'Starting…' : 'Run experiment'}</button></div>
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
/** The turns of one conversation, oldest first, and the box to add the next one. Each turn is its own job so its steps and usage stay visible. */
export function ChatThread({ turns, busy, error, onSend, placeholder, hint, onOpenItem }: { turns: AgentJob[]; busy: boolean; error: string; onSend: (message: string) => Promise<void>; placeholder: string; hint: string; onOpenItem?: (id: string) => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false), [fileError, setFileError] = useState('');
  const send = async () => { const question = text.trim(); if (!question || busy || sending) return; setSending(true); try { await onSend(question); setText(''); } catch { /* Keep the draft; the caller shows the error. */ } finally { setSending(false); } };
  return <>
    {turns.length > 0 && <ol className="chat-turns">{turns.map(turn => <li key={turn.id}>
      <div className="chat-question"><span>You{turn.focus?.title ? <> · about {onOpenItem && turn.focus.itemId ? <button type="button" className="text-button" onClick={() => onOpenItem(turn.focus!.itemId!)}>{turn.focus.title}</button> : turn.focus.title}</> : turn.focus?.collection ? ` · in ${turn.focus.collection}` : ''}</span><p>{turn.question}</p></div>
      <div className="chat-reply"><span>{providerName[turn.provider]}</span>
        {turn.status === 'running' && <p className="muted"><Loader2 size={13} className="spin" /> {turn.phase}</p>}
        {turn.status === 'running' && <button className="text-button" onClick={() => void api('agent.cancel', { id: turn.id })}>Cancel</button>}
        {turn.error && <p className="error-box">{turn.error}</p>}
        {turn.result && 'reply' in turn.result && <pre className="chat-text">{(turn.result as ChatResult).reply}</pre>}
        <Steps job={turn} />
        <RunMeta job={turn} />
        <button className="text-button" onClick={() => void api('desktop.openAgentJob', { id: turn.id }).catch(e => setFileError(String(e)))}>Run files</button>
      </div>
    </li>)}</ol>}
    <form className="chat-compose" onSubmit={event => { event.preventDefault(); send(); }}>
      <textarea rows={3} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} placeholder={placeholder} aria-label="Your message" disabled={busy} />
      {(error || fileError) && <p role="alert" className="error-box">{error || fileError}</p>}
      <div className="modal-actions"><span className="muted small">{hint}</span><button className="button primary" type="submit" disabled={busy || sending || !text.trim()}>{busy ? <><Loader2 size={14} className="spin" />Replying…</> : <><Send size={14} />Send</>}</button></div>
    </form>
  </>;
}
/** Result cards for this item's runs. `kinds` limits the card set to what belongs on the current tab. Conversations live in the library chat, not here. */
export function AgentPanel({ itemId, jobs, kinds, onOpen, onOpenCollection }: { itemId: string; jobs: AgentJob[]; kinds?: AgentKind[]; onOpen: (id: string) => void; onOpenCollection?: (name: string) => void }) {
  const [error,setError] = useState('');
  const relevant = jobs.filter(job => job.itemId === itemId && job.kind !== 'chat' && (!kinds || kinds.includes(job.kind)));
  const retry = (job: AgentJob) => { void api('agent.start', { id: itemId, revision: job.revision, kind: job.kind, provider: job.provider, workspace: job.workspace, context: job.context }).then(() => agentStarted(job.kind)).catch(e => setError(String(e))); };
  return <>{error && <p className="error-box">{error}</p>}{relevant.map(job => <section className="agent-result" key={job.id}>
    <div className="section-heading"><b>{providerName[job.provider]} {heading[job.kind]}</b><span className="inline">{job.status === 'running' && <Loader2 size={14} className="spin"/>}{job.status === 'running' ? job.phase : job.status}</span></div>
    <RunMeta job={job} />
    {job.status === 'running' && <button className="text-button" onClick={() => void api('agent.cancel', { id: job.id })}>Cancel run</button>}
    <Steps job={job} />
    {job.error && <p className="error-box">{job.error}</p>}
    {job.result && ('entries' in job.result ? <><p>{job.result.summary}</p><p><b>Takeaway:</b> {job.result.takeaway}</p><p className="distill-counts">{Object.entries(job.result.entries.reduce<Record<string, number>>((acc, e) => { acc[e.type] = (acc[e.type] ?? 0) + 1; return acc; }, {})).map(([type, n]) => <span key={type}>{n} {n === 1 ? type : entryLabel[type] ?? type}</span>)}{!job.result.entries.length && <span>Nothing reusable found</span>}</p>{job.result.skipped && <p className="muted">Skipped: {job.result.skipped}</p>}{job.collection && onOpenCollection && <button className="button" onClick={() => onOpenCollection(job.collection!)}>Open “{job.collection}” <ArrowRight size={14} /></button>}</>
      : 'summary' in job.result ? <><p>{job.result.summary}</p>{job.result.extractedText && <details><summary>Extracted text</summary><pre className="prompt-preview">{job.result.extractedText}</pre></details>}<p><b>Next test:</b> {job.result.nextTest}</p>{job.result.limitations && <p className="muted">{job.result.limitations}</p>}</>
      : 'judgement' in job.result ? <><p><b>{job.result.judgement}</b> · Agent assessment</p><p>{job.result.note}</p><pre className="prompt-preview">{job.result.output}</pre></>
      : 'reply' in job.result ? <pre className="chat-text">{job.result.reply}</pre>
      : <><p>Drafted <b>{job.result.name}</b>: {job.result.description}</p>{job.result.notes && <p className="muted">{job.result.notes}</p>}{job.createdItemId && <button className="button" onClick={() => onOpen(job.createdItemId!)}>Open the draft skill <ArrowRight size={14} /></button>}</>)}
    <button className="text-button" onClick={() => void api('desktop.openAgentJob', { id: job.id }).catch(e => setError(String(e)))}>Run files</button>
    {['failed','cancelled','interrupted'].includes(job.status) && <button className="button" onClick={() => retry(job)}>Retry with {providerName[job.provider]}</button>}
  </section>)}</>;
}
