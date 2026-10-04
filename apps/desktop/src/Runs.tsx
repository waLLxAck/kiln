import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, CheckCircle2, CircleSlash, Clock, Loader2, X } from 'lucide-react';
import type { AgentJobSummary } from '../../../packages/agent/service';
import type { Item } from '../../../packages/protocol/schema';
import { activeRun, runFinished, runKindLabel, runNotice } from '../../../packages/agent/run-notice';
import { api } from './api';
import { providerName } from './components';

/**
 * Agent runs in the status bar: the segment with what is running or queued, the runs list behind it, and the toast when a run
 * finishes while Kiln is in front. Behind another window, main.ts shows a desktop notification instead and sends
 * `kiln:open-run` when it is clicked (see run-notifications.ts).
 */
export const RECENT_MS = 30 * 60_000;
export const OPEN_RUN_EVENT = 'kiln:open-run';
/** Detail listens for this to show the view that holds a run's result when the item is already open. */
export const OPEN_RESULT_TAB_EVENT = 'kiln:open-result-tab';
export type RunRef = Pick<AgentJobSummary, 'itemId' | 'kind' | 'createdItemId'>;
/** Where a run's result is: the skill a draft created, else the item it ran on; experiments are in its tests, chat replies in the chat. */
export function resultTarget(job: RunRef) { return { itemId: job.kind === 'derive' && job.createdItemId ? job.createdItemId : job.itemId, view: job.kind === 'trial' ? 'tests' as const : job.kind === 'chat' ? 'chat' as const : 'content' as const }; }
const ended = (job: AgentJobSummary) => job.status === 'completed' || job.status === 'failed';
/** "4 s", "2 min 5 s", "1 h 5 min". */
const duration = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor(s / 60) % 60} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`; };
const took = (job: AgentJobSummary, at: number) => job.status === 'queued' ? `waiting ${duration(at - Date.parse(job.startedAt))}` : duration((job.finishedAt ? Date.parse(job.finishedAt) : at) - Date.parse(job.startedAt));
const firstLine = (text: string, max: number) => text.split('\n')[0].slice(0, max);

type Props = { jobs: AgentJobSummary[]; items: Item[]; /** Reveal the result: the item on the right view, or the chat for a reply. */ onOpen: (job: RunRef) => void; /** A finished analysis filed its entries here. */ onOpenCollection?: (name: string) => void };
export function RunsStatus({ jobs, items, onOpen, onOpenCollection }: Props) {
  const [open, setOpen] = useState(false), [toast, setToast] = useState<AgentJobSummary[]>([]), [now, setNow] = useState(Date.now());
  const session = useRef(Date.now()), box = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const title = (id: string) => items.find(i => i.id === id)?.title;
  const active = jobs.filter(activeRun), queued = active.filter(j => j.status === 'queued').length, running = active.length - queued;
  const recent = jobs.filter(j => !activeRun(j) && j.finishedAt && now - Date.parse(j.finishedAt) < RECENT_MS).slice(0, 20);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), open || active.length ? 1000 : 30_000); return () => clearInterval(timer); }, [open, active.length > 0]);
  // A run that was running or queued at the last poll and has now completed or failed. One that started and ended between two polls counts too; runs from before this session never do.
  const seen = useRef<Map<string, AgentJobSummary['status']> | null>(null);
  useEffect(() => {
    const before = seen.current; seen.current = new Map(jobs.map(j => [j.id, j.status]));
    if (!before) return;
    const done = jobs.filter(j => ended(j) && (before.has(j.id) ? activeRun({ status: before.get(j.id)! }) : Date.parse(j.startedAt) >= session.current));
    if (done.length) setToast(current => [...done, ...current.filter(j => !done.some(d => d.id === j.id))]);
  }, [jobs]);
  const openResult = (job: RunRef) => { setOpen(false); setToast([]); onOpen(job); };
  const openRef = useRef(openResult); openRef.current = openResult;
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  // A desktop notification was clicked: open the result here and cancel the event, so main.ts doesn't open the item a second way.
  useEffect(() => {
    const fromNotification = (event: Event) => { const detail = (event as CustomEvent<{ id: string } & RunRef>).detail; event.preventDefault(); openRef.current(jobsRef.current.find(j => j.id === detail.id) ?? detail); };
    window.addEventListener(OPEN_RUN_EVENT, fromNotification); return () => window.removeEventListener(OPEN_RUN_EVENT, fromNotification);
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const cancel = (job: AgentJobSummary) => void api('agent.cancel', { id: job.id }).finally(() => window.dispatchEvent(new CustomEvent('kiln:agent-refresh')));
  const row = (job: AgentJobSummary) => {
    const name = title(job.itemId) ?? job.focus?.title ?? 'Removed item', step = job.lastStep?.text && firstLine(job.lastStep.text, 90);
    // A finished analysis says how many entries it made and opens the collection they were filed in.
    const made = job.createdItemIds?.length ?? 0, analysis = (job.kind === 'distill' || job.kind === 'distill-repo' || job.kind === 'capture') && job.status === 'completed';
    const detail = job.status === 'queued' ? 'Queued' : job.status === 'running' ? [job.phase, step !== job.phase && step].filter(Boolean).join(' · ') : job.error ? firstLine(job.error, 120) : job.status === 'completed' ? analysis && made ? `Done · ${made} entr${made === 1 ? 'y' : 'ies'}` : 'Done' : job.status[0].toUpperCase() + job.status.slice(1);
    return <li key={job.id} className={`run-row ${job.status}`} aria-label={`${runKindLabel[job.kind]} · ${name}`}>
      <span className="run-icon">{job.status === 'running' ? <Loader2 size={14} className="spin" /> : job.status === 'queued' ? <Clock size={14} /> : job.status === 'completed' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span>
      <span className="run-text"><b>{runKindLabel[job.kind]} · {name}</b><span className="muted" title={detail}>{providerName[job.provider]}{job.model ? ` · ${job.model}` : ''} · {detail}</span></span>
      <span className="run-side"><span className="run-time">{took(job, now)}</span><span className="run-actions">{analysis && made && job.collection && onOpenCollection ? <button type="button" className="text-button" onClick={() => { setOpen(false); onOpenCollection(job.collection!); }}>Open collection</button> : <button type="button" className="text-button" onClick={() => openResult(job)}>Open</button>}{activeRun(job) && <button type="button" className="text-button" onClick={() => cancel(job)}>Cancel</button>}</span></span>
    </li>;
  };
  const providers = [...new Set(active.filter(j => j.status === 'running').map(j => providerName[j.provider]))].join(' & ');
  const latest = toast[0], notice = latest && runNotice(runFinished(latest, title));
  return <div className="status-runs" ref={box}>
    <button type="button" ref={trigger} className={`status-item runs ${active.length ? 'active' : ''} ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)} title="Agent runs: two at a time, more wait their turn">
      {running ? <Loader2 size={12} className="spin" /> : queued ? <Clock size={12} /> : <CircleSlash size={12} />}
      {active.length ? [running && `${running} running`, queued && `${queued} queued`].filter(Boolean).join(' · ') : recent.length ? `${recent.length} finished recently` : 'No agent runs'}
      {providers && <span className="muted">· {providers}</span>}
    </button>
    {open && <div className="runs-pop" role="dialog" aria-label="Agent runs">
      <div className="runs-head"><span>Agent runs</span><span className="muted small">{active.length ? `${running} of 2 running${queued ? ` · ${queued} queued` : ''}` : 'Nothing running'}</span><button type="button" className="icon-button" aria-label="Close agent runs" title="Close (Esc)" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={14} /></button></div>
      {active.length > 0 && <ul className="runs-list" aria-label="Active runs">{active.map(row)}</ul>}
      {recent.length > 0 && <><div className="runs-label">Finished in the last 30 minutes</div><ul className="runs-list" aria-label="Finished runs">{recent.map(row)}</ul></>}
      {!active.length && !recent.length && <p className="muted small runs-empty">No runs in the last 30 minutes. Capture with analysis, Test or Create skill starts one.</p>}
    </div>}
    {latest && notice && createPortal(<RunToast key={toast.map(j => j.id).join()} ok={latest.status === 'completed'} text={toast.length > 1 ? `${toast.length} runs finished · latest: ${notice.title}` : notice.title} hint={notice.body} onOpen={() => openResult(latest)} onAll={toast.length > 1 ? () => { setToast([]); setOpen(true); } : undefined} onExpire={() => setToast([])} />, document.body)}
  </div>;
}

/** The finished-run toast. It sits above the undo and message toasts rather than replacing them, and pauses while hovered or focused. */
function RunToast({ ok, text, hint, onOpen, onAll, onExpire }: { ok: boolean; text: string; hint: string; onOpen: () => void; onAll?: () => void; onExpire: () => void }) {
  const [paused, setPaused] = useState(false); const remaining = useRef(10_000), expire = useRef(onExpire); expire.current = onExpire;
  useEffect(() => { if (paused) return; const start = performance.now(), timer = setTimeout(() => expire.current(), remaining.current); return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - start)); }; }, [paused]);
  return <div className="toast run-toast" role="status" title={hint} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPaused(false); }}>
    {ok ? <Check size={17} /> : <AlertTriangle size={17} className="run-toast-failed" />}<span>{text}</span>
    <button type="button" className="toast-action" onClick={onOpen}>Open result</button>{onAll && <button type="button" className="toast-action" onClick={onAll}>All runs</button>}
    <button type="button" className="toast-action toast-close" aria-label="Dismiss" onClick={onExpire}><X size={14} /></button>
  </div>;
}
