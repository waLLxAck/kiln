import { useEffect, useMemo, useState } from 'react';
import { Check, FileDiff, Gauge, Loader2, RotateCcw, Sparkles, Wand2, X } from 'lucide-react';
import type { AgentJob } from '../../../packages/agent/service';
import type { TuneFile } from '../../../packages/agent/tune';
import { activeRun } from '../../../packages/agent/run-notice';
import type { Item, ItemDetail, Provider, RunProviderId, Score, ScoreSummary } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { Field, InlineError, Modal, providerName } from './components';
import { ProviderSelect, useStart } from './AgentPanel';
import { ExperimentProject } from './ExperimentProject';
import { LineDiff } from './Diff';
import { Markdown } from './Markdown';
import { LoadError, useLoad, Waiting } from './Loading';
import { askAgent } from './TrialLoop';
import { applyMessage, scoreStale, scoreTone, sortedImprovements } from './score-model';
import './score.css';

/** The latest score as a small number: coloured by how good it is, faded with a ↻ when it scored an earlier revision. */
export function ScoreBadge({ score, item, onClick }: { score: ScoreSummary; item: Pick<Item, 'revision'>; onClick?: () => void }) {
  const stale = scoreStale(score, item);
  const title = `Writing-for-agents score ${score.score}/100, ${date(score.finishedAt)}${stale ? '. Scored an earlier revision; score again for this one.' : ''}`;
  const body = <>{score.score}{stale && <RotateCcw size={10} aria-label="stale" />}</>;
  return onClick ? <button type="button" className={`score-badge ${scoreTone(score.score)} ${stale ? 'stale' : ''}`} title={title} aria-label={title} onClick={onClick}>{body}</button>
    : <span className={`score-badge ${scoreTone(score.score)} ${stale ? 'stale' : ''}`} title={title}>{body}</span>;
}

/**
 * The latest score and its improvements, under the header. Each improvement opens to its reason and suggestion; its line link
 * opens the editor on that line. Apply improvements types the chosen ones into the item chat, which saves a new draft revision.
 */
export function ScorePanel({ detail, jobs, onScore, onLine, onClose }: { detail: ItemDetail; jobs: AgentJob[]; onScore: () => void; onLine: (line: number) => void; onClose: () => void }) {
  const { item } = detail;
  const latest: Score | undefined = detail.scores?.[0];
  const running = jobs.find(j => j.itemId === item.id && j.kind === 'score' && activeRun(j));
  const [chosen, setChosen] = useState<number[]>([]);
  useEffect(() => { setChosen(latest ? latest.improvements.map((p, i) => p.severity === 'low' ? -1 : i).filter(i => i >= 0) : []); }, [latest?.id]);
  const rows = useMemo(() => latest ? sortedImprovements(latest) : [], [latest?.id]);
  const stale = latest ? scoreStale(latest, item) : false;
  const toggle = (i: number) => setChosen(current => current.includes(i) ? current.filter(n => n !== i) : [...current, i]);
  return <section className="score-panel" aria-label="Score">
    <div className="score-head">
      {latest && <ScoreBadge score={latest} item={item} />}
      <b>Score</b>
      <span className="muted small">{running ? <><Loader2 size={12} className="spin" />{running.status === 'queued' ? 'Queued' : running.phase}</> : latest ? <>{stale ? <>of revision <code>{shortHash(latest.revision)}</code>, not the current one · </> : ''}{providerName[latest.provider]}{latest.model ? ` · ${latest.model}` : ''} · {date(latest.finishedAt)}</> : 'Not scored yet'}</span>
      <span className="score-actions">
        {!running && !item.deletedAt && <button type="button" className="text-button" onClick={onScore} title="Score the current revision against the writing-for-agents guidance (read-only)"><Gauge size={13} />{latest ? 'Score again' : 'Score'}</button>}
        <button type="button" className="icon-button" aria-label="Close score" onClick={onClose}><X size={14} /></button>
      </span>
    </div>
    {latest && <>
      <p className="score-summary">{latest.summary}</p>
      {rows.length > 0 ? <ul className="score-list">
        {rows.map(({ improvement: p, index }) => <li key={index} className={p.severity}>
          <input type="checkbox" aria-label={`Include “${p.title}”`} checked={chosen.includes(index)} onChange={() => toggle(index)} />
          <details>
            <summary><span className={`score-sev ${p.severity}`}>{p.severity}</span><span className="score-title">{p.title}</span>{p.line && <button type="button" className="text-button score-line" title={stale ? 'Line in the scored revision; the text may have moved since' : 'Open the editor on this line'} onClick={event => { event.preventDefault(); onLine(p.line!); }}>L{p.line}</button>}</summary>
            <p className="muted small">{p.why}</p>
            <pre className="score-suggestion">{p.suggestion}</pre>
          </details>
        </li>)}
      </ul> : <p className="muted small">No improvements suggested.</p>}
      {rows.length > 0 && !item.deletedAt && <div className="score-foot">
        <button type="button" className="text-button" onClick={() => setChosen(chosen.length === rows.length ? [] : rows.map(r => r.index))}>{chosen.length === rows.length ? 'Select none' : 'Select all'}</button>
        <span className="muted small">A new draft revision, made in the item chat; the approved revision stays.</span>
        <button type="button" className="button" disabled={!chosen.length} onClick={() => askAgent(item.id, applyMessage(item, latest, [...chosen].sort((a, b) => a - b)))}><Wand2 size={14} />Apply {chosen.length || ''} improvement{chosen.length === 1 ? '' : 's'}</button>
      </div>}
    </>}
  </section>;
}

/** Tune's options: which CLI, the project whose past runs it measures (optional), and the trial task. */
export function TuneDialog({ item, providers, defaultProvider, onClose }: { item: Item; providers: Provider[]; defaultProvider: RunProviderId; onClose: () => void }) {
  const [provider, setProvider] = useState<RunProviderId>(defaultProvider), [workspace, setWorkspace] = useState(''), [context, setContext] = useState('');
  const { busy, error, start } = useStart('tune', item.id, onClose);
  return <Modal title="Tune this skill" subtitle={item.title} onClose={onClose}>
    <div className="callout"><Sparkles size={18} /><span>Runs the bundled tune-skill on a private copy of this revision: measures past runs, rewrites SKILL.md with writing-for-agents, moves plumbing into a script and field-tests it with a trial agent. About 25 minutes; Kiln stops it at 45. You review the diff before anything becomes a draft.</span></div>
    <ProviderSelect providers={providers} value={provider} onChange={setProvider} />
    <ExperimentProject value={workspace} onChange={setWorkspace} disabled={busy} label="Project to measure (optional)" hint="Tune reads this project’s Claude Code transcripts for past runs of the skill. Without one it searches every project on this machine." empty="No project — search every project" />
    <Field label="Trial task (optional)"><textarea rows={3} value={context} onChange={e => setContext(e.target.value)} placeholder="The real job the trial agent should do with the skill. Left empty, the agent picks one." /></Field>
    <p className="notice warning small">Tune has write access: it edits files and runs commands in its own run folder, and Claude Code’s commands are not confined to it. Your library changes only when you accept the diff.</p>
    {error && <p role="alert" className="error-box">{error}</p>}
    <div className="modal-actions"><span className="muted">Skills only · one run at a time per skill</span><button className="button primary" disabled={busy} onClick={() => start(provider, context, workspace)}>{busy ? 'Starting…' : 'Start Tune'}</button></div>
  </Modal>;
}

type Proposal = { jobId: string; itemId: string; revision: string; state: 'ready' | 'unchanged' | 'accepted' | 'discarded'; summary: string; report: string; skipped: string[]; files: TuneFile[] };
const fileLabel: Record<TuneFile['status'], string> = { same: 'unchanged', changed: 'changed', added: 'new', removed: 'removed' };
const fileBadge: Record<TuneFile['status'], string> = { same: 'current', changed: 'review', added: 'create', removed: 'drifted' };
function TuneFileView({ file }: { file: TuneFile }) {
  if (!file.text) return <p className="muted small">Binary or large file; not shown as text.</p>;
  if (file.status === 'changed') return <LineDiff before={file.before ?? ''} after={file.after ?? ''} names={{ before: 'the revision', after: 'the tuned skill' }} className="compare-diff" />;
  return <div className="diff compare-diff"><pre className={file.status === 'added' ? 'added' : file.status === 'removed' ? 'removed' : ''}>{file.after ?? file.before}</pre></div>;
}
/** What a Tune run proposes, file by file against the revision it started from, with its report. Accept saves one draft revision. */
export function TuneReview({ jobId, onClose, onAccepted }: { jobId: string; onClose: () => void; onAccepted: () => void }) {
  const [error, setError] = useState(''), [open, setOpen] = useState<string | null>(null), [busy, setBusy] = useState(false), [summary, setSummary] = useState('');
  const reading = useLoad(async () => { const p = await api<Proposal>('agent.tuneProposal', { id: jobId }); setSummary(`Tuned: ${p.summary}`.slice(0, 500)); setOpen(p.files.find(f => f.status !== 'same')?.path ?? null); return p; }, [jobId]), data = reading.data;
  const act = (method: 'agent.tuneAccept' | 'agent.tuneDiscard') => { setBusy(true); setError(''); void api(method, { id: jobId, ...(method === 'agent.tuneAccept' ? { summary } : {}) }).then(() => { if (method === 'agent.tuneAccept') onAccepted(); onClose(); }).catch(e => { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }); };
  const differing = data?.files.filter(f => f.status !== 'same') ?? [];
  return <Modal title="Review Tune changes" subtitle={data ? `From revision ${shortHash(data.revision)}` : undefined} onClose={onClose} wide>
    <InlineError error={error} />
    {!data ? reading.error ? <LoadError error={reading.error} onRetry={reading.retry} /> : <Waiting since={reading.since} label="Reading the tuned skill">Reading the tuned skill…</Waiting> : <>
      <div className="compare-summary"><b>{differing.length ? `${differing.length} of ${data.files.length} file${data.files.length === 1 ? '' : 's'} changed` : 'Nothing changed'}</b>{data.skipped.length > 0 && <span title={data.skipped.join('\n')}>{data.skipped.length} left out</span>}</div>
      <ul className="compare-files">{data.files.map(file => <li key={file.path} className={file.status}><button className={`compare-file ${open === file.path ? 'open' : ''}`} onClick={() => setOpen(open === file.path ? null : file.path)}><FileDiff size={13} /><code>{file.path}</code><span className={`badge ${fileBadge[file.status]}`}>{fileLabel[file.status]}</span></button>{open === file.path && <TuneFileView file={file} />}</li>)}</ul>
      <details className="tune-report"><summary>Run report</summary><Markdown>{data.report}</Markdown></details>
      {data.state === 'ready' && <Field label="Revision note"><input value={summary} maxLength={500} onChange={e => setSummary(e.target.value)} /></Field>}
      {data.state !== 'ready' && <p className="notice">{data.state === 'accepted' ? 'Already accepted as a draft revision.' : data.state === 'discarded' ? 'Discarded.' : 'The run changed nothing.'}</p>}
    </>}
    <div className="modal-actions">
      {data?.state === 'ready' ? <><button className="button" disabled={busy} onClick={() => act('agent.tuneDiscard')}>Discard</button><button className="button primary" disabled={busy || !summary.trim()} title="Save the tuned SKILL.md and bundled files as one new draft revision. The approved revision stays approved." onClick={() => act('agent.tuneAccept')}><Check size={14} />Accept as draft</button></>
        : <button className="button primary" onClick={onClose}>Close</button>}
    </div>
  </Modal>;
}

