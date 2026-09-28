import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Github, Loader2, X } from 'lucide-react';
import type { Snapshot, UpdateStatus } from '../../../packages/protocol/schema';
import type { AgentJob } from '../../../packages/agent/service';
import { providerName } from './components';
import { UpdateAction } from './Updates';

/** "owner/name" from a GitHub remote URL, for display. */
export const repoName = (remote: string) => !/github\.com[/:]/.test(remote) && remote ? remote.split(/[\\/]/).filter(Boolean).at(-1)!.replace(/\.git$/, '') : remote.replace(/^(https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '') || 'GitHub remote';
/** "4 s", "2 min", "1 h 5 min": how long a run has taken. */
export const elapsed = (from: string, to = Date.now()) => { const s = Math.max(0, Math.round((to - new Date(from).getTime()) / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; };
const kindLabel: Record<AgentJob['kind'], string> = { capture: 'Analysis', distill: 'Analysis', trial: 'Experiment', derive: 'Skill draft', chat: 'Chat' };

type Props = { snapshot: Snapshot; jobs: AgentJob[]; agentError: string; busy: boolean; update: UpdateStatus | null; updating: boolean; onUpdate: (restart: boolean) => void; onSettings: () => void; onOpenJob: (job: AgentJob) => void; /** A finished analysis filed its entries here. */ onOpenCollection?: (name: string) => void };

/**
 * The thin bar along the bottom of the window: where the repository stands with GitHub, the agent runs (with a list of them),
 * and the version with its update action.
 */
export function StatusBar({ snapshot, jobs, agentError, busy, update, updating, onUpdate, onSettings, onOpenJob, onOpenCollection }: Props) {
  const [open, setOpen] = useState(false), [now, setNow] = useState(Date.now());
  const pop = useRef<HTMLDivElement>(null);
  const running = jobs.filter(j => j.status === 'running');
  useEffect(() => { if (!open && !running.length) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [open, running.length]);
  useEffect(() => { if (!open) return; const away = (event: MouseEvent) => { if (!pop.current?.contains(event.target as Node)) setOpen(false); }; const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }; window.addEventListener('mousedown', away); window.addEventListener('keydown', key, true); return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true); }; }, [open]);
  const failed = snapshot.publish.filter(j => j.status === 'failed').length, publishing = snapshot.publish.filter(j => !['done', 'failed'].includes(j.status)).length;
  const repo = failed ? { tone: 'bad', text: `${failed} approval${failed === 1 ? '' : 's'} failed to publish` } : publishing ? { tone: 'busy', text: `publishing ${publishing}…` }
    : snapshot.git.ahead ? { tone: 'warn', text: `${snapshot.git.ahead} not on GitHub yet` } : { tone: 'ok', text: 'everything on GitHub' };
  const title = (job: AgentJob) => snapshot.items.find(i => i.id === job.itemId)?.title ?? job.focus?.title ?? 'Removed item';
  // Running first, then the latest finished runs so a result that just landed is one click away.
  const listed = [...running, ...jobs.filter(j => j.status !== 'running').slice(0, 6)];
  return <footer className="status-bar">
    <button type="button" className={`status-item repo ${repo.tone}`} onClick={onSettings} title={`${snapshot.git.remote || 'No remote'} · open Settings & repository`}>
      {repo.tone === 'busy' ? <Loader2 size={12} className="spin" /> : repo.tone === 'bad' ? <AlertTriangle size={12} /> : <Github size={12} />}
      <b>{repoName(snapshot.git.remote)}</b><span className="status-sep">·</span>{snapshot.git.branch || 'no branch'}<span className="status-sep">·</span><span className="repo-state">{repo.text}</span>
    </button>
    <span className="status-divider" />
    <div className="status-runs" ref={pop}>
      <button type="button" className={`status-item runs ${running.length ? 'active' : ''} ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)} title="Agent runs: up to two at a time">
        {running.length ? <Loader2 size={12} className="spin" /> : <CircleSlash size={12} />}{running.length ? `${running.length} running` : 'No agent runs'}
        {running.length > 0 && <span className="muted">· {[...new Set(running.map(j => providerName[j.provider]))].join(' & ')}</span>}
      </button>
      {open && <div className="runs-pop" role="dialog" aria-label="Agent runs">
        <div className="runs-head"><span>Agent runs</span><span className="muted small">{running.length} of 2 running</span><button type="button" className="icon-button" aria-label="Close agent runs" onClick={() => setOpen(false)}><X size={14} /></button></div>
        {listed.length ? listed.map(job => {
          // A finished capture names where its results went: the collection its entries were filed in, or the item itself.
          const made = job.createdItemIds?.length ?? 0, analysis = job.kind === 'distill' || job.kind === 'capture';
          const go = analysis && job.status === 'completed' ? job.collection && made && onOpenCollection ? { label: 'Open collection', run: () => onOpenCollection(job.collection!) } : { label: 'Open', run: () => onOpenJob(job) } : null;
          return <div key={job.id} className={`run-line ${go ? 'has-action' : ''}`}>
            <button type="button" className={`run-row ${job.status}`} onClick={() => { setOpen(false); onOpenJob(job); }}>
              <span className="run-icon">{job.status === 'running' ? <Loader2 size={14} className="spin" /> : job.status === 'completed' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span>
              <span className="run-text"><b>{title(job)}</b><span className="muted">{kindLabel[job.kind]} · {providerName[job.provider]} · {job.status === 'running' ? job.phase : job.status === 'completed' ? analysis ? `done · ${made} entr${made === 1 ? 'y' : 'ies'}` : 'done' : job.status}</span></span>
              <span className="run-time">{job.status === 'running' ? elapsed(job.startedAt, now) : job.finishedAt ? elapsed(job.startedAt, new Date(job.finishedAt).getTime()) : ''}</span>
            </button>
            {go && <button type="button" className="text-button run-go" onClick={() => { setOpen(false); go.run(); }}>{go.label}</button>}
          </div>;
        }) : <p className="muted small runs-empty">No runs yet. Capture with analysis, Test or Create skill starts one.</p>}
      </div>}
    </div>
    {agentError && <span className="status-item bad" role="alert" title={agentError}><AlertTriangle size={12} />Agent updates disconnected. Retrying…</span>}
    <span className="status-grow" />
    {busy && <span className="status-item muted" aria-live="polite"><Loader2 size={12} className="spin" />Working…</span>}
    <span className="status-item version" title={update?.packaged === false ? 'Running from source' : 'Installed version'}>Kiln {update?.current ?? '…'}</span>
    <UpdateAction update={update} working={updating} onPrepare={() => onUpdate(false)} onRestart={() => onUpdate(true)} compact />
  </footer>;
}
