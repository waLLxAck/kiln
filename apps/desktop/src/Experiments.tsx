import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, CircleSlash, Clock, Copy, FileText, FlaskConical, FolderOpen, Hand, Loader2, Play, Plus, RotateCcw, ShieldCheck, SlidersHorizontal, Trash2, X, XCircle } from 'lucide-react';
import type { AgentJob } from '../../../packages/agent/service';
import type { ItemDetail, Provider, RunProviderId, Snapshot, Trial } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { ProviderSelect, retryJob, Steps, tokens, useElapsed, useStart } from './AgentPanel';
import { ContextMenu, providerName, type MenuEntry } from './components';
import './experiments.css';

export type ExperimentsGridProps = {
  detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; jobs: AgentJob[];
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>;
  /** The item page's actions: 'approve', 'trial' (the full run dialog), 'manual-trial', 'result' (record a manual result), 'delete-trial'. */
  onAction: (name: string, trial?: Trial) => void;
};

type Verdict = 'pass' | 'fail' | 'uncertain';
/**
 * Where a run happened. Canonical trial records only say "machine-private", so the project comes from this machine's job
 * record; a manual handoff's folder stays in its private run folder, and a trial with no job here cannot be placed.
 */
type Column = { key: string; kind: 'project' | 'isolated' | 'manual' | 'unknown'; label: string; path?: string };
/** One experiment: its canonical trial and, when it ran on this machine, the job that ran it. A job can arrive before the trial is refreshed. */
type Run = { id: string; trial?: Trial; job?: AgentJob; revision: string; column: string; at: string };

const isolated: Column = { key: 'isolated', kind: 'isolated', label: 'Isolated example' };
const manual: Column = { key: 'manual', kind: 'manual', label: 'Manual' };
const unknown: Column = { key: 'unknown', kind: 'unknown', label: 'Unknown project' };
const projectColumn = (path: string): Column => ({ key: `path:${path}`, kind: 'project', label: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, path });
const columnOf = (trial: Trial | undefined, job: AgentJob | undefined) => job ? job.workspace ? projectColumn(job.workspace) : isolated : trial?.mode === 'manual' ? manual : unknown;
const cellKey = (revision: string, column: string) => `${revision}|${column}`;

const verdictLabel: Record<Verdict, string> = { pass: 'Pass', fail: 'Fail', uncertain: 'Uncertain' };
const VerdictIcon = ({ verdict, size = 14 }: { verdict: Verdict; size?: number }) => verdict === 'pass' ? <CheckCircle2 size={size} /> : verdict === 'fail' ? <XCircle size={size} /> : <CircleHelp size={size} />;
const verdictOf = (run: Run): Verdict | null => run.trial?.judgement ?? (run.job?.result && 'judgement' in run.job.result ? run.job.result.judgement : null);
const running = (run: Run) => run.job?.status === 'running';
const waiting = (run: Run) => !running(run) && run.trial?.status === 'prepared' && run.trial.mode === 'manual';
/** Why a run has no verdict: the job's own ending when it is on this machine, otherwise the trial's. */
const stopped = (run: Run) => run.job && ['failed', 'cancelled', 'interrupted'].includes(run.job.status) ? run.job.status : run.trial?.status === 'cancelled' ? 'cancelled' : '';
/** "Sep 27" for grid cells, where the full date and time would not fit; the full one is in the tooltip and the panel. */
const day = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const firstLine = (text: string) => text.split('\n')[0].slice(0, 90);
const seconds = (job: AgentJob) => { const s = Math.max(0, Math.round(((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.startedAt)) / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };

/** Highlights file:line references such as src/screens/Levels.tsx:4 so evidence stands out in an assessment. */
function withRefs(text: string): ReactNode[] {
  return text.split(/([\w./-]+\.\w+:\d+)/g).map((part, index) => index % 2 ? <code key={index} className="exp-ref">{part}</code> : <Fragment key={index}>{part}</Fragment>);
}

/** An item's experiments as a revision × project grid with a verdict-first result panel. */
export function ExperimentsGrid({ detail, snapshot, providers, jobs, perform, onAction }: ExperimentsGridProps) {
  const { item } = detail;
  const current = item.revision;
  const approved = new Set(detail.approvals.filter(a => a.trust === 'local' && !a.revokedAt).map(a => a.revision));
  const trialJobs = jobs.filter(j => j.itemId === item.id && j.kind === 'trial');
  const active = trialJobs.find(j => j.status === 'running');
  // Folders picked with Add project… stay as columns while the grid is open, even before anything has run there.
  const [added, setAdded] = useState<Column[]>([]);

  const runs = useMemo(() => {
    const byTrial = new Map(trialJobs.filter(j => j.trialId).map(j => [j.trialId!, j]));
    const list: Run[] = detail.trials.map(trial => { const job = byTrial.get(trial.id); return { id: trial.id, trial, job, revision: trial.revision, column: columnOf(trial, job).key, at: trial.createdAt }; });
    for (const job of trialJobs) if (!job.trialId || !detail.trials.some(t => t.id === job.trialId)) if (job.status === 'running' || job.result) list.push({ id: job.trialId ?? job.id, job, revision: job.revision, column: columnOf(undefined, job).key, at: job.startedAt });
    return list.sort((a, b) => b.at.localeCompare(a.at));
  }, [detail.trials, jobs, item.id]);

  // Two projects with the same folder name are told apart by the path under the name.
  const columns = useMemo(() => {
    const seen = new Map<string, Column>();
    // Oldest first, so a column keeps its place as new runs arrive.
    for (const run of [...runs].reverse()) if (!seen.has(run.column)) seen.set(run.column, columnOf(run.trial, run.job));
    for (const column of added) if (!seen.has(column.key)) seen.set(column.key, column);
    const order = { project: 0, isolated: 1, manual: 2, unknown: 3 };
    return [...seen.values()].sort((a, b) => order[a.kind] - order[b.kind]);
  }, [runs, added]);
  const revisions = useMemo(() => {
    const tested = new Set([current, ...runs.map(r => r.revision)]);
    const known = detail.revisions.filter(r => tested.has(r.hash));
    const missing = [...tested].filter(hash => !known.some(r => r.hash === hash)).map(hash => ({ hash, summary: 'Revision not in this library’s history', author: '', createdAt: '' }));
    return [...known, ...missing].sort((a, b) => a.hash === current ? -1 : b.hash === current ? 1 : b.createdAt.localeCompare(a.createdAt));
  }, [detail.revisions, runs, current]);

  const cells = useMemo(() => { const map = new Map<string, Run[]>(); for (const run of runs) { const key = cellKey(run.revision, run.column); map.set(key, [...map.get(key) ?? [], run]); } return map; }, [runs]);
  const [selected, setSelected] = useState<{ cell: string; run?: string } | null>(() => runs[0] ? { cell: cellKey(runs[0].revision, runs[0].column) } : null);
  // A run that appears while the grid is open (a handoff just prepared, a run started from the dialog) takes the panel, so its result is what you see next.
  const known = useRef(new Set(runs.map(r => r.id)));
  useEffect(() => {
    const fresh = runs.find(r => !known.current.has(r.id));
    known.current = new Set(runs.map(r => r.id));
    if (fresh) setSelected({ cell: cellKey(fresh.revision, fresh.column), run: fresh.id });
  }, [runs]);
  const [bar, setBar] = useState<{ revision: string; column?: Column; free: boolean } | null>(null);
  const [provider, setProvider] = useState<RunProviderId>(snapshot.settings.agentProvider);
  const [context, setContext] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [pickError, setPickError] = useState('');
  const { busy, error, setError, start } = useStart('trial', item.id, () => { setBar(null); setContext(''); });
  // Running a cell puts the result panel on it, so the live steps are what you see next.
  const run = (revision: string, column: Column, runProvider = provider, runContext = context) => {
    setSelected({ cell: cellKey(revision, column.key) });
    start(runProvider, runContext, column.path, revision === current ? undefined : revision);
  };
  const choose = async () => {
    setPickError('');
    try { const folder = await api<string | null>('desktop.chooseDirectory'); if (!folder) return null; const column = projectColumn(folder); setAdded(list => list.some(c => c.key === column.key) ? list : [...list, column]); return column; }
    catch (e) { setPickError(String(e)); return null; }
  };
  const openBar = (revision: string, column?: Column) => { setBar({ revision, column, free: !column }); setError(''); };
  const addProject = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const has = (key: string) => columns.some(c => c.key === key);
    const enrolled = [...new Map(snapshot.targets.filter(t => t.scope === 'project').map(t => [t.root, t])).values()].filter(t => !has(`path:${t.root}`));
    const pick = (column: Column) => { setAdded(list => [...list, column]); openBar(current, column); };
    setMenu({ x: rect.left, y: rect.bottom + 4, entries: [
      ...(enrolled.length ? [{ heading: 'Enrolled projects' }, ...enrolled.map(t => ({ label: t.name, hint: t.root, icon: <FolderOpen />, onSelect: () => pick(projectColumn(t.root)) }))] : []),
      ...(has('isolated') ? [] : [{ label: 'Isolated example', hint: 'No project folder; the agent works from a scratch example.', icon: <FlaskConical />, onSelect: () => pick(isolated) }]),
      ...(enrolled.length || !has('isolated') ? ['separator' as const] : []),
      { label: 'Choose folder…', icon: <FolderOpen />, onSelect: () => void choose().then(column => { if (column) openBar(current, column); }) },
    ] });
  };
  const runnable = columns.filter(c => c.kind === 'project' || c.kind === 'isolated');
  const runCurrentOn = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4, entries: [
      ...runnable.map(column => ({ label: `Run ${shortHash(current)} on ${column.label}`, hint: column.path, icon: <Play />, onSelect: () => run(current, column, provider, '') })),
      ...(runnable.length ? ['separator' as const] : []),
      { label: 'Another project…', icon: <Plus />, onSelect: () => openBar(current) },
      { label: 'All run options…', icon: <SlidersHorizontal />, hint: 'The full dialog: any project, context and provider.', onSelect: () => onAction('trial') },
      { label: 'Manual handoff…', icon: <Hand />, onSelect: () => onAction('manual-trial') },
    ] });
  };

  const selectedRuns = selected ? cells.get(selected.cell) ?? [] : [];
  const shown = selectedRuns.find(r => r.id === selected?.run) ?? selectedRuns.find(running) ?? selectedRuns[0];
  const [selRevision, selColumnKey] = selected?.cell.split('|') ?? ['', ''];
  const selColumn = columns.find(c => c.key === selColumnKey);
  const total = runs.filter(r => !running(r)).length;
  // With nothing tested yet the run bar is simply there, ready to go.
  const shownBar = bar ?? (!runs.length && !active && !busy ? { revision: current, free: true } : null);

  return <section className="exp-page" aria-label="Experiments">
    <header className="exp-head">
      <div className="exp-head-text"><h2>Experiments</h2><p className="muted small">{runs.length ? <>One cell per revision and project · {total} run{total === 1 ? '' : 's'}{active ? ' · 1 running' : ''}</> : 'Nothing tested yet'}</p></div>
      <div className="exp-head-actions">
        <button className="button" onClick={() => onAction('trial')} title="Open the full run dialog"><SlidersHorizontal size={15} />Run options…</button>
        <button className="button primary" aria-haspopup="menu" disabled={Boolean(active)} title={active ? 'An experiment is already running for this item.' : undefined} onClick={runCurrentOn}><Play size={15} />Run current revision on…<ChevronDown size={14} /></button>
      </div>
    </header>

    {shownBar && <RunBar key={`${shownBar.revision}|${shownBar.free ? '' : shownBar.column?.key}`} free={shownBar.free} closable={Boolean(bar)} revision={shownBar.revision} current={current} column={shownBar.column} columns={runnable} providers={providers} provider={provider} setProvider={setProvider} context={context} setContext={setContext} busy={busy} error={error || pickError}
      onPick={async () => { const column = await choose(); if (column) setBar({ ...shownBar, column }); }} onColumn={column => setBar({ ...shownBar, column })}
      onRun={column => run(shownBar.revision, column)} onManual={() => onAction('manual-trial')} onClose={() => { setBar(null); setError(''); }} />}
    {!shownBar && (error || pickError) && <p role="alert" className="error-box">{error || pickError}</p>}

    {!runs.length && !active ? <div className="exp-empty"><FlaskConical size={22} /><div><b>No experiments yet</b><p className="muted">Run this revision against a project, or an isolated example, and the agent’s assessment appears here with its output. Try a typical task first, then a boundary case.</p></div></div> : <div className="exp-layout">
      <div className="exp-gridwrap">
        {/* Fixed layout ignores cell min-widths, so the table asks for room per project and scrolls sideways past that. */}
        <table className="exp-grid" style={{ minWidth: 180 + columns.length * 160 + 132 }}>
          <thead><tr>
            <th className="exp-corner" scope="col">Revision <span className="exp-faint">newest first</span></th>
            {columns.map(column => <th key={column.key} scope="col" className="exp-col" title={column.path ?? (column.kind === 'unknown' ? 'Ran on another machine, or its job record is gone; the project is kept only where it ran.' : column.kind === 'manual' ? 'Manual handoffs; their project stays in the private run folder.' : undefined)}>
              <div className="exp-col-name">{column.kind === 'project' ? <FolderOpen size={14} /> : column.kind === 'manual' ? <Hand size={14} /> : column.kind === 'isolated' ? <FlaskConical size={14} /> : <CircleHelp size={14} />}<span>{column.label}</span></div>
              <div className="exp-col-path">{column.path ?? (column.kind === 'isolated' ? 'No project folder' : column.kind === 'manual' ? 'Your own session' : 'Not on this machine')}</div>
            </th>)}
            <th className="exp-addcol" scope="col"><button className="exp-add" aria-haspopup="menu" onClick={addProject}><Plus size={14} />Add project…</button></th>
          </tr></thead>
          <tbody>{revisions.map(revision => {
            const isCurrent = revision.hash === current;
            return <tr key={revision.hash} className={isCurrent ? 'exp-current' : ''}>
              <th className="exp-rev" scope="row">
                <div className="exp-rev-top"><code>{shortHash(revision.hash)}</code>{isCurrent && <span className="exp-pill accent">Current</span>}{approved.has(revision.hash) && <span className="exp-pill ok"><Check size={11} />Approved</span>}</div>
                <div className="exp-rev-note" title={revision.summary}>{revision.summary}</div>
                {revision.createdAt && <div className="exp-rev-when">{date(revision.createdAt)}{revision.author ? ` · ${revision.author}` : ''}</div>}
              </th>
              {columns.map(column => <Cell key={column.key} revision={revision.hash} column={column} runs={cells.get(cellKey(revision.hash, column.key)) ?? []} current={current}
                selected={selected?.cell === cellKey(revision.hash, column.key)} armed={bar?.revision === revision.hash && bar.column?.key === column.key} blocked={Boolean(active)}
                onSelect={() => setSelected({ cell: cellKey(revision.hash, column.key) })} onRun={() => column.kind === 'manual' ? onAction('manual-trial') : openBar(revision.hash, column)} />)}
              <td className="exp-filler" aria-hidden="true" />
            </tr>;
          })}</tbody>
        </table>
        <div className="exp-legend">
          <span className="exp-chip pass"><CheckCircle2 size={12} />Pass</span><span className="exp-chip fail"><XCircle size={12} />Fail</span><span className="exp-chip uncertain"><CircleHelp size={12} />Uncertain</span>
          <span className="muted">Chips are the agent’s assessment, or your result for a manual handoff · hover an empty cell to run it</span>
        </div>
      </div>
      <aside className="exp-panel" aria-label="Experiment result">
        {shown ? <Result key={shown.id} run={shown} others={selectedRuns} column={selColumn} current={current} approved={approved.has(current)} perform={perform} onAction={onAction} onPick={id => setSelected(s => s && { ...s, run: id })} />
          : selected && busy ? <div className="exp-result"><p className="exp-bigrunning"><Loader2 size={20} className="spin" />Starting…</p></div>
          : <div className="exp-panel-empty"><FileText size={20} /><p>{selected ? `Nothing has run on ${selColumn?.label ?? 'this project'} at ${shortHash(selRevision)} yet.` : 'Select a cell to see its result.'}</p></div>}
      </aside>
    </div>}
    {menu && <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />}
  </section>;
}

function Cell({ revision, column, runs, current, selected, armed, blocked, onSelect, onRun }: { revision: string; column: Column; runs: Run[]; current: string; selected: boolean; armed: boolean; blocked: boolean; onSelect: () => void; onRun: () => void }) {
  const latest = runs.find(running) ?? runs[0];
  const where = `${shortHash(revision)} on ${column.label}`;
  if (!latest) {
    // Unknown-project runs cannot be repeated here, and a manual handoff always tests the current revision.
    const canRun = !blocked && (column.kind === 'project' || column.kind === 'isolated' || column.kind === 'manual' && revision === current);
    return <td className={`exp-cell exp-isempty ${armed ? 'exp-armed' : ''}`}>{canRun
      ? <button onClick={onRun} aria-label={`Run ${where}`}><span className="exp-dash">—</span><span className="exp-runhint"><Play size={12} />{column.kind === 'manual' ? 'Hand off' : 'Run'}</span></button>
      : <span className="exp-dash" title={blocked ? 'An experiment is already running for this item.' : undefined}>—</span>}</td>;
  }
  const verdict = verdictOf(latest), job = latest.job, ended = stopped(latest);
  const who = job ? providerName[job.provider] : latest.trial?.provider === 'manual' ? 'Manual' : latest.trial ? providerName[latest.trial.provider] : '';
  const label = running(latest) ? 'running' : verdict ? verdictLabel[verdict] : waiting(latest) ? 'waiting for result' : ended || 'no result';
  return <td className={`exp-cell ${selected ? 'exp-active' : ''}`}>
    <button onClick={onSelect} aria-pressed={selected} aria-label={`${where}: ${label}`}>
      {running(latest) ? <><span className="exp-running"><Loader2 size={13} className="spin" />Running</span><span className="exp-step">{job!.steps.at(-1) ? firstLine(job!.steps.at(-1)!.text) : job!.phase}</span></>
        : <><CellChip run={latest} /><span className="exp-cell-meta">{who}{who && ' · '}<span title={date(latest.at)}>{day(latest.at)}</span>{runs.length > 1 && <span className="exp-more" title={`${runs.length} runs in this cell`}>+{runs.length - 1}</span>}</span></>}
    </button>
  </td>;
}
function CellChip({ run }: { run: Run }) {
  const verdict = verdictOf(run);
  if (verdict) return <span className={`exp-chip ${verdict}`}><VerdictIcon verdict={verdict} size={13} />{verdictLabel[verdict]}</span>;
  if (waiting(run)) return <span className="exp-chip waiting"><Clock size={13} />Waiting for result</span>;
  const ended = stopped(run);
  return <span className="exp-chip neutral"><CircleSlash size={13} />{ended ? ended[0].toUpperCase() + ended.slice(1) : 'No result'}</span>;
}

/** Inline replacement for the run dialog: same start call, consent and errors, with the project fixed by the cell. */
function RunBar({ free, closable, revision, current, column, columns, providers, provider, setProvider, context, setContext, busy, error, onPick, onColumn, onRun, onManual, onClose }: { revision: string; current: string; column?: Column; columns: Column[]; providers: Provider[]; provider: RunProviderId; setProvider: (p: RunProviderId) => void; context: string; setContext: (v: string) => void; busy: boolean; error: string; onPick: () => void; onColumn: (column: Column) => void; onRun: (column: Column) => void; onManual: () => void; onClose: () => void; free: boolean; closable: boolean }) {
  const target = column ?? isolated;
  const options = [...new Map([...columns, isolated, ...(column ? [column] : [])].map(c => [c.key, c])).values()];
  return <div className="exp-runbar" role="region" aria-label="Run an experiment">
    <div className="exp-runbar-title"><Play size={14} />Run <code>{shortHash(revision)}</code>{revision !== current && <span className="muted small">(earlier revision)</span>} on {free
      ? <span className="exp-runbar-project"><span className="field"><select aria-label="Project" value={target.key} disabled={busy} onChange={event => { const next = options.find(c => c.key === event.target.value); if (next) onColumn(next); }}>{options.map(c => <option key={c.key} value={c.key}>{c.label}{c.path ? ` — ${c.path}` : ''}</option>)}</select></span><button type="button" className="text-button" disabled={busy} onClick={onPick}>Choose folder…</button></span>
      : <strong title={column!.path}>{column!.label}</strong>}</div>
    <div className="exp-runbar-provider"><ProviderSelect providers={providers} value={provider} onChange={setProvider} compact /></div>
    <input className="exp-focus" aria-label="What should it try? (optional)" value={context} disabled={busy} onChange={event => setContext(event.target.value)} placeholder="What should it try? (optional)" onKeyDown={event => { if (event.key === 'Enter' && !busy) onRun(target); if (event.key === 'Escape') onClose(); }} autoFocus />
    <button className="button primary" disabled={busy} onClick={() => onRun(target)}>{busy ? <><Loader2 size={14} className="spin" />Starting…</> : <><Play size={14} />Run</>}</button>
    {revision === current && <button className="text-button" disabled={busy} onClick={onManual}><Hand size={14} />Manual handoff instead</button>}
    {closable && <button className="icon-button" aria-label="Close run bar" onClick={onClose}><X size={16} /></button>}
    <p className="muted small exp-runbar-note">Read-only: the agent inspects files but does not change them. Tasks that need edits or missing tools come back uncertain.</p>
    {error && <p role="alert" className="error-box">{error}</p>}
  </div>;
}

/** The selected cell's result, verdict first; how it ran is folded away under Run details. */
function Result({ run, others, column, current, approved, perform, onAction, onPick }: { run: Run; others: Run[]; column?: Column; current: string; approved: boolean; perform: ExperimentsGridProps['perform']; onAction: ExperimentsGridProps['onAction']; onPick: (id: string) => void }) {
  const { trial, job } = run;
  const verdict = verdictOf(run), isManual = trial?.mode === 'manual', ended = stopped(run);
  const [output, setOutput] = useState<{ output: string; reference: string } | null>(null), [error, setError] = useState('');
  const inline = job?.result && 'output' in job.result ? job.result.output : '';
  // The output is read from this machine's run folder when the cell is opened, not for every cell in the grid.
  useEffect(() => { if (inline || !trial || trial.status !== 'completed') return; let live = true; void api<{ output: string; reference: string }>('desktop.trialOutput', { id: trial.id }).then(value => { if (live) setOutput(value); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [trial?.id, trial?.status, inline]);
  const note = trial?.note || (job?.result && 'note' in job.result ? job.result.note : '');
  const where = <div className="exp-result-where"><strong title={column?.path}>{column?.label ?? 'Unknown project'}</strong><code className="muted">{shortHash(run.revision)}</code>{run.revision === current && <span className="exp-pill accent">Current</span>}<span className="exp-grow" /><span className="muted small">{date(run.at)}</span></div>;
  const history = others.length > 1 && <div className="exp-others"><span className="eyebrow">Runs in this cell</span>{others.map(other => <button key={other.id} className={other.id === run.id ? 'active' : ''} aria-pressed={other.id === run.id} onClick={() => onPick(other.id)}><CellChip run={other} /><span className="muted small">{date(other.at)}</span></button>)}</div>;
  const remove = trial && <button className="button danger-text" onClick={() => onAction('delete-trial', trial)}><Trash2 size={14} />Delete experiment</button>;

  if (running(run)) return <div className="exp-result">
    {where}
    <div className="eyebrow">Agent run in progress</div>
    <RunningHeadline job={job!} />
    <p className="muted small" role="status">{job!.phase}{job!.context ? ` · asked to try “${job!.context}”` : ''}</p>
    <Steps job={job!} />
    <div className="exp-actions"><button className="button" onClick={() => void api('agent.cancel', { id: job!.id })}><X size={14} />Cancel run</button></div>
    <p className="muted small">Read-only: the agent can’t change files in {column?.label ?? 'the project'}.</p>
    {history}
  </div>;

  return <div className="exp-result">
    {where}
    {verdict ? <><div className="eyebrow">{isManual ? 'Your result' : 'Agent’s assessment'}</div>
      <div className={`exp-verdict ${verdict}`}><VerdictIcon verdict={verdict} size={26} />{verdictLabel[verdict]}</div></>
      : waiting(run) ? <><div className="eyebrow">Manual handoff</div><div className="exp-verdict waiting"><Clock size={24} />Waiting for result</div><p className="muted">Run the handoff prompt in your own agent session, then record what happened.</p></>
      : <><div className="eyebrow">{isManual ? 'Manual handoff' : 'Agent run'}</div><div className="exp-verdict neutral"><CircleSlash size={24} />{ended ? ended[0].toUpperCase() + ended.slice(1) : 'No result'}</div></>}
    {note && <p className="exp-finding">{withRefs(note)}</p>}
    {job?.error && <p className="error-box">{job.error}</p>}
    {job?.context && <p className="muted small">Asked to try: “{job.context}”</p>}
    {verdict && !isManual && <p className="muted small exp-human">This is the agent’s view, not yours. To record your own result, run a manual handoff.</p>}
    <div className="exp-actions">
      {run.revision === current && verdict === 'pass' && !approved && <button className="button primary" onClick={() => onAction('approve')}><ShieldCheck size={15} />Approve {shortHash(current)}</button>}
      {waiting(run) && <><button className="button primary" onClick={() => onAction('result', trial)}>Record result</button><button className="button" onClick={() => void perform(() => api('desktop.copyTrial', { id: trial!.id }), 'Handoff copied')}><Copy size={14} />Copy handoff</button></>}
      {job && !running(run) && <button className="button" onClick={() => void retryJob(job).catch(e => setError(String(e)))} title="Same provider, project, context and revision"><RotateCcw size={14} />{ended ? `Retry with ${providerName[job.provider]}` : 'Run again'}</button>}
      {remove}
    </div>
    {error && <p role="alert" className="error-box">{error}</p>}
    {verdict && <section className="exp-output"><div className="eyebrow">{isManual ? 'Output' : 'Agent’s output'}</div>
      {inline || output ? <pre className="prompt-preview">{inline || output!.output || output!.reference || 'No output on this machine.'}</pre> : !error && <p className="muted small"><Loader2 size={12} className="spin" /> Loading output…</p>}</section>}
    <RunDetails run={run} perform={perform} />
    {history}
  </div>;
}
function RunningHeadline({ job }: { job: AgentJob }) {
  const elapsed = useElapsed(job);
  return <p className="exp-bigrunning"><Loader2 size={20} className="spin" />Running with {providerName[job.provider]}<span className="muted small">{elapsed}</span></p>;
}
function RunDetails({ run, perform }: { run: Run; perform: ExperimentsGridProps['perform'] }) {
  const { trial, job } = run;
  const provider = job ? providerName[job.provider] : trial?.provider === 'manual' ? 'Another agent (manual)' : trial ? `${providerName[trial.provider]}${trial.mode === 'manual' ? ' (manual)' : ''}` : '';
  const model = job?.model || (trial && trial.model !== 'reported by official client' ? trial.model : '');
  return <details className="exp-details"><summary><ChevronRight size={14} className="exp-caret" />Run details<span className="muted">{provider}{job ? ` · ${seconds(job)}` : ''}</span></summary>
    <dl>
      <dt>Provider</dt><dd>{provider || '—'}</dd>
      {model && <><dt>Model</dt><dd><code>{model}</code></dd></>}
      {job?.effort && <><dt>Effort</dt><dd>{job.effort} reasoning</dd></>}
      {job && <><dt>Elapsed</dt><dd>{seconds(job)}</dd></>}
      {job?.usage && <><dt>Tokens</dt><dd title={`Input ${job.usage.input.toLocaleString()} (cached ${job.usage.cached.toLocaleString()}) · output ${job.usage.output.toLocaleString()}`}>{tokens(job.usage.input)} in · {tokens(job.usage.output)} out</dd></>}
      {job && job.steps.length > 0 && <><dt>Steps</dt><dd>{job.steps.length}</dd></>}
      {job?.threadId && <><dt>Session</dt><dd><code>{job.threadId.slice(0, 8)}</code>{job.session ? ' · transcript saved' : ''}</dd></>}
      {trial && <><dt>Case</dt><dd>{trial.case === 'typical' ? 'Typical case' : 'Boundary case'}</dd></>}
      {trial && trial.rubric.length > 0 && <><dt>Rubric</dt><dd><ul>{trial.rubric.map(r => <li key={r}>{r}</li>)}</ul></dd></>}
      <dt>Files</dt><dd className="exp-links">
        {job && <button className="text-button" onClick={() => void perform(() => api('desktop.openAgentJob', { id: job.id }))}>Run files</button>}
        {trial && <button className="text-button" onClick={() => void perform(() => api('desktop.openRun', { id: trial.id }))}>Trial folder</button>}
      </dd>
    </dl>
    {job && job.steps.length > 0 && <Steps job={job} />}
  </details>;
}
