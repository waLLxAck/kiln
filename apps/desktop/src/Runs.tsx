import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Clock, History, Loader2, X } from 'lucide-react';
import type { AgentJob, AgentKind } from '../../../packages/agent/service';
import type { Item } from '../../../packages/protocol/schema';
import { activeRun as active, runFinished, runKindLabel, runNotice } from '../../../packages/agent/run-notice';
import { api } from './api';
import { Badge, providerName } from './components';

/**
 * runNotifications: the runs list behind the top-bar "working" pill, and the toast when a run finishes. Rendered only while the
 * flag is on; with it off App keeps its original pill. The main process sends `kiln:open-run` when a desktop notification is clicked.
 */
const RECENT_MS = 30 * 60_000;
export const OPEN_RUN_EVENT = 'kiln:open-run';
/** Detail listens for this to show the tab that holds a run's result when the item is already open. */
export const OPEN_RESULT_TAB_EVENT = 'kiln:open-result-tab';
const ended = (job: AgentJob) => job.status === 'completed' || job.status === 'failed';
const duration = (ms: number) => { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`; };
const elapsed = (job: AgentJob, at: number) => job.status === 'queued' ? `waiting ${duration(at - Date.parse(job.startedAt))}` : duration((job.finishedAt ? Date.parse(job.finishedAt) : at) - Date.parse(job.startedAt));

/** Where a run's result is: the skill a draft created, else the item it ran on; experiments are under Trials, everything else under Overview (chat replies in the chat). */
export function resultTarget(job: Pick<AgentJob, 'itemId' | 'kind' | 'createdItemId'>) { return { itemId: job.kind === 'derive' && job.createdItemId ? job.createdItemId : job.itemId, tab: job.kind === 'trial' ? 'trials' : 'overview' }; }

type Props = { jobs: AgentJob[]; items: Item[]; /** Reveal the item; `kind` 'chat' also opens the chat about it. */ onOpen: (itemId: string, kind: AgentKind) => void };
export function RunsButton({ jobs, items, onOpen }: Props) {
  const [open, setOpen] = useState(false), [toast, setToast] = useState<AgentJob[]>([]);
  const [now, setNow] = useState(Date.now()); const session = useRef(Date.now());
  const trigger = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  const title = (id: string) => items.find(i => i.id === id)?.title;
  const running = jobs.filter(active), recent = jobs.filter(j => !active(j) && j.finishedAt && (now - Date.parse(j.finishedAt) < RECENT_MS || Date.parse(j.finishedAt) >= session.current)).slice(0, 20);
  const lately = recent.some(j => now - Date.parse(j.finishedAt!) < RECENT_MS);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), open || running.length ? 1000 : 30_000); return () => clearInterval(timer); }, [open, running.length > 0]);
  // A run that was running or queued at the last poll and has now completed or failed. One that started and ended between two polls counts too; runs from before this session never do.
  const seen = useRef<Map<string, AgentJob['status']> | null>(null);
  useEffect(() => {
    const before = seen.current; seen.current = new Map(jobs.map(j => [j.id, j.status]));
    if (!before) return;
    const done = jobs.filter(j => ended(j) && (before.has(j.id) ? before.get(j.id) === 'running' || before.get(j.id) === 'queued' : Date.parse(j.startedAt) >= session.current));
    if (done.length) setToast(current => [...done, ...current.filter(j => !done.some(d => d.id === j.id))]);
  }, [jobs]);
  const openResult = (job: Pick<AgentJob, 'itemId' | 'kind' | 'createdItemId'>) => {
    const target = resultTarget(job);
    localStorage.setItem('kiln-detail-tab', target.tab); setOpen(false);
    onOpen(target.itemId, job.kind);
    window.dispatchEvent(new CustomEvent(OPEN_RESULT_TAB_EVENT, { detail: { kind: job.kind } }));
  };
  const openRef = useRef(openResult); openRef.current = openResult; const jobsRef = useRef(jobs); jobsRef.current = jobs;
  useEffect(() => {
    const fromNotification = (event: Event) => { const detail = (event as CustomEvent<{ id: string; itemId: string; kind: AgentKind }>).detail; event.preventDefault(); setToast([]); openRef.current(jobsRef.current.find(j => j.id === detail.id) ?? detail); };
    window.addEventListener(OPEN_RUN_EVENT, fromNotification); return () => window.removeEventListener(OPEN_RUN_EVENT, fromNotification);
  }, []);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => popover.current?.querySelector<HTMLElement>('button')?.focus());
    const away = (event: MouseEvent) => { if (!popover.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const cancel = (job: AgentJob) => void api('agent.cancel', { id: job.id }).finally(() => window.dispatchEvent(new CustomEvent('kiln:agent-refresh')));
  const row = (job: AgentJob) => { const last = job.steps.at(-1)?.text.split('\n')[0].slice(0, 90); const name = title(job.itemId) ?? job.focus?.title ?? 'Removed item'; return <li key={job.id} className="run-row" aria-label={`${runKindLabel[job.kind]} · ${name}`}>
    <div className="run-row-main"><b>{runKindLabel[job.kind]} · {name}</b><small>{providerName[job.provider]}{job.model ? ` · ${job.model}` : ''} · {elapsed(job, now)}</small><small className="run-phase">{job.status === 'running' ? `${job.phase}${last && last !== job.phase ? ` · ${last}` : ''}` : job.error ? job.error.split('\n')[0].slice(0, 120) : job.phase}</small></div>
    <Badge status={job.status} />
    <span className="run-row-actions"><button className="text-button" onClick={() => openResult(job)}>Open</button>{active(job) && <button className="text-button" onClick={() => cancel(job)}>Cancel</button>}</span>
  </li>; };
  const providers = [...new Set(running.filter(j => j.status === 'running').map(j => providerName[j.provider]))].join(' & ');
  const queued = running.filter(j => j.status === 'queued').length;
  const latest = toast[0], notice = latest && runNotice(runFinished(latest, title));
  return <span className="runs-anchor">
    {running.length ? <button ref={trigger} className="agent-running" aria-haspopup="dialog" aria-expanded={open} title="Show every agent run" onClick={() => setOpen(o => !o)}>{running.some(j => j.status === 'running') ? <Loader2 className="spin" size={13} /> : <Clock size={13} />}{providers || 'Agent'} {providers ? 'working' : 'queued'}{running.length - queued > 1 ? ` · ${running.length - queued}` : ''}{queued && providers ? ` · ${queued} queued` : ''}</button>
      : lately || open ? <button ref={trigger} className="icon-button runs-button" aria-label="Recent runs" aria-haspopup="dialog" aria-expanded={open} title="Agent runs from the last 30 minutes" onClick={() => setOpen(o => !o)}><History size={15} /></button> : null}
    {open && <div ref={popover} className="runs-popover" role="dialog" aria-label="Agent runs">
      <div className="runs-head"><b>Agent runs</b><small>{running.length ? `${running.length - queued} running${queued ? ` · ${queued} queued` : ''}` : 'Nothing running'}</small><button className="icon-button" aria-label="Close runs" title="Close (Esc)" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={15} /></button></div>
      {running.length > 0 && <ul className="runs-list" aria-label="Active runs">{running.map(row)}</ul>}
      {recent.length > 0 && <><div className="runs-label">Finished recently</div><ul className="runs-list" aria-label="Finished runs">{recent.map(row)}</ul></>}
      {!running.length && !recent.length && <p className="muted runs-empty">No runs in the last 30 minutes.</p>}
      <p className="muted small runs-foot">Two runs go at once; more wait their turn.</p>
    </div>}
    {latest && notice && createPortal(<RunToast key={toast.map(j => j.id).join()} ok={latest.status === 'completed'} text={toast.length > 1 ? `${toast.length} runs finished · latest: ${notice.title}` : notice.title} hint={notice.body} onOpen={() => { setToast([]); openResult(latest); }} onAll={toast.length > 1 ? () => { setToast([]); setOpen(true); } : undefined} onExpire={() => setToast([])} />, document.body)}
  </span>;
}

/** The finished-run toast. It sits above the undo and message toasts rather than replacing them, and pauses while hovered or focused. */
function RunToast({ ok, text, hint, onOpen, onAll, onExpire }: { ok: boolean; text: string; hint: string; onOpen: () => void; onAll?: () => void; onExpire: () => void }) {
  const [paused, setPaused] = useState(false); const remaining = useRef(10_000), expire = useRef(onExpire); expire.current = onExpire;
  useEffect(() => { if (paused) return; const start = performance.now(), timer = setTimeout(() => expire.current(), remaining.current); return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - start)); }; }, [paused]);
  return <div className="toast run-toast" role="status" title={hint} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocusCapture={() => setPaused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPaused(false); }}>
    {ok ? <Check size={17} /> : <AlertTriangle size={17} className="run-toast-failed" />}<span>{text}</span>
    <button className="toast-action" onClick={onOpen}>Open result</button>{onAll && <button className="toast-action" onClick={onAll}>All runs</button>}
    <button className="toast-action toast-close" aria-label="Dismiss" onClick={onExpire}><X size={14} /></button>
  </div>;
}
