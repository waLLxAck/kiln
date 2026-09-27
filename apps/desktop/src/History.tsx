import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Bot, Check, Copy, Download, FileInput, FileDiff, FlaskConical, GitCommitHorizontal, GitCompare, Github, Loader2, MinusCircle, RotateCcw, ShieldCheck, ShieldOff, Trash2, TriangleAlert, User, Wrench, X } from 'lucide-react';
import { skillLocationLabel } from '../../../packages/providers/skill-locations';
import type { Installation, ItemDetail, ProviderId, PublishJob, Snapshot, Trial } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { Badge, providerName } from './components';
import { LineDiff } from './Diff';
import { buildHistory, dayLabel, historyFilters, timeLabel, trialProject, type HistoryEvent, type HistoryFilter } from './history-model';

const publishPhase: Record<string, string> = { queued: 'Waiting to commit', composing: 'Writing the commit message', committing: 'Committing', pushing: 'Pushing to GitHub' };
/** Where this approval is on its way to GitHub: in progress, failed with a retry, or landed with its commit. */
export function PublishState({ job, ahead, onRetry, compact = false }: { job?: PublishJob; ahead: number; onRetry: () => void; /** Hash only, for the rail; the commit message is the tooltip. */ compact?: boolean }) {
  if (job && !['done', 'failed'].includes(job.status)) return <span className="publish-state"><Loader2 size={12} className="spin" />{publishPhase[job.status] ?? job.status}…</span>;
  if (job?.status === 'failed') return <span className="publish-state failed"><TriangleAlert size={12} />Not on GitHub yet: {job.error} <button className="text-button" onClick={onRetry}>Retry</button></span>;
  if (job?.status === 'done') return <span className="publish-state done" title={job.message}><Github size={12} />On GitHub · {shortHash(job.commit)}{!compact && <> · “{job.message.split('\n')[0]}”</>}</span>;
  return <span className={`publish-state ${ahead ? '' : 'done'}`}><Github size={12} />{ahead ? 'Committed on this machine; push pending' : 'On GitHub'}</span>;
}

const verdictTone = (trial: Trial) => trial.judgement === 'pass' ? 'ok' : trial.judgement === 'fail' ? 'bad' : trial.status === 'completed' ? 'warn' : 'idle';
export const trialVerdict = (trial: Trial) => trial.judgement ?? trial.status;
/** Where a copy lives, the way the install toggles name it. */
export const copyLocation = (copy: Installation, snapshot: Snapshot) => copy.location && copy.scope !== 'project' ? skillLocationLabel[copy.location] : snapshot.targets.find(t => t.id === copy.targetId)?.name ?? providerName[copy.provider];

export function EventGlyph({ event }: { event: HistoryEvent }) {
  const icon: Record<HistoryEvent['type'], ReactNode> = {
    revision: <GitCommitHorizontal size={15} />, test: <FlaskConical size={14} />, approved: <ShieldCheck size={14} />, unapproved: <ShieldOff size={14} />, published: <Github size={14} />,
    installed: <Download size={14} />, removed: <MinusCircle size={14} />, 'rolled-back': <RotateCcw size={14} />, drift: <TriangleAlert size={14} />,
  };
  return <span className={`history-glyph ${event.type === 'test' ? verdictTone(event.trial) : event.type}`} aria-hidden="true">{icon[event.type]}</span>;
}

/** The event's one-line title: a type label and what it was about. */
export function eventTitle(event: HistoryEvent, snapshot: Snapshot): ReactNode {
  const target = (id: string) => snapshot.targets.find(t => t.id === id)?.name ?? 'an environment Kiln no longer manages';
  switch (event.type) {
    case 'revision': return <><b>Revision saved</b><span>{event.revision.summary}</span></>;
    case 'test': return <><b>Test run</b><Badge status={trialVerdict(event.trial)} /><span>on {trialProject(event.trial)}</span></>;
    case 'approved': return <><b>Approved</b><span>by {event.approval.reviewer}</span></>;
    case 'unapproved': return <><b>Approval removed</b></>;
    case 'published': return <><b>Published to GitHub</b></>;
    case 'installed': return <><b>Installed</b><span>to {target(event.receipt.targetId)}</span>{event.receipt.status !== 'applied' && <Badge status={event.receipt.status} />}</>;
    case 'removed': return <><b>Removed</b><span>{event.activity.message}</span></>;
    case 'rolled-back': return <><b>Rolled back</b><span>{event.activity.message}</span></>;
    case 'drift': return <><b>Changed outside Kiln</b><span>in {copyLocation(event.installation, snapshot)}</span></>;
  }
}
const eventRevision = (event: HistoryEvent) => event.type === 'revision' ? event.revision.hash : event.type === 'test' ? event.trial.revision : event.type === 'approved' ? event.approval.revision : event.type === 'unapproved' ? event.revision : event.type === 'published' ? event.job.revision : event.type === 'installed' ? event.receipt.revision : event.type === 'drift' ? '' : event.activity.revision ?? '';

type Props = {
  detail: ItemDetail; snapshot: Snapshot; installations: Installation[];
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>;
  onAction: (name: string, trial?: Trial) => void; onToggleInstall: (provider: ProviderId, targetId?: string) => void;
  /** Opens the install dialog on an approved revision; absent for kinds that are not installed. */
  onInstallRevision?: (revision: string) => void;
  onBack: () => void;
};
const PAGE = 40;
/** Design 15: everything that happened to one item as a single timeline, with pick-two compare, restore and install. */
export function History({ detail, snapshot, installations, perform, refresh, onAction, onToggleInstall, onInstallRevision, onBack }: Props) {
  const { item, revision } = detail;
  const events = useMemo(() => buildHistory(detail, snapshot, installations), [detail, snapshot, installations]);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<string[]>([]);
  const [output, setOutput] = useState<{ id: string; text: string } | null>(null);
  const types = historyFilters.find(f => f.id === filter)!.types;
  const visible = events.filter(e => types.includes(e.type));
  const page = visible.slice(0, shown);
  const days = [...new Set(page.map(e => dayLabel(e.at)))];
  const pick = (hash: string) => setPicked(current => current.includes(hash) ? current.filter(h => h !== hash) : [...current, hash].slice(-2));
  // Older on the left. One pick compares with the current draft, as the old History tab did.
  const pair = (picked.length === 1 && picked[0] !== item.revision ? [picked[0], item.revision] : picked.length === 2 ? picked : [])
    .map(hash => detail.revisions.find(r => r.hash === hash)).filter(r => r !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const name = (hash: string) => hash === item.revision ? 'the current draft' : `revision ${shortHash(hash)}`;
  const restore = (hash: string) => void perform(async () => { await api('items.restore', { id: item.id, expect: item.revision, revision: hash }); setPicked([]); await refresh(); }, 'Revision restored as a new draft. Installed snapshots are unchanged.');
  const retry = (job: PublishJob) => void perform(async () => { await api('publish.retry', { id: job.id }); await refresh(); });
  const viewOutput = (trial: Trial) => output?.id === trial.id ? setOutput(null) : void perform(async () => { const found = await api<{ output: string; reference: string }>('desktop.trialOutput', { id: trial.id }); setOutput({ id: trial.id, text: found.output || found.reference || 'No output available on this machine.' }); });

  const meta = (event: HistoryEvent): ReactNode => {
    const hash = eventRevision(event);
    const chip = hash && <code className="history-hash" title={hash}>{shortHash(hash)}</code>;
    switch (event.type) {
      case 'revision': {
        const who = { person: [<User size={12} key="i" />, event.revision.author || 'You'], agent: [<Bot size={12} key="i" />, 'Agent'], import: [<FileInput size={12} key="i" />, 'Imported'], outside: [<Wrench size={12} key="i" />, 'Edited outside Kiln'], kiln: [<Wrench size={12} key="i" />, 'Kiln'] }[event.author];
        return <>{chip}<span className="history-author">{who}</span>{event.approved && <Badge status="approved" />}{event.current && <span className="badge current">current</span>}</>;
      }
      case 'test': return <>{chip}<span>{event.trial.provider === 'manual' ? 'Manual handoff' : providerName[event.trial.provider]}{event.trial.model ? ` · ${event.trial.model}` : ''} · {event.trial.case === 'typical' ? 'typical case' : 'boundary case'}</span></>;
      case 'approved': {
        const job = snapshot.publish.find(j => j.itemId === item.id && j.revision === event.approval.revision && j.action === 'approve');
        return <>{chip}<span>{event.approval.scope}</span>{job && job.status !== 'done' && <PublishState job={job} ahead={snapshot.git.ahead} onRetry={() => retry(job)} />}</>;
      }
      case 'published': return <>{chip}<span className="history-github" title={event.job.message}><Github size={12} />{shortHash(event.job.commit)} · “{event.job.message.split('\n')[0]}”</span></>;
      case 'installed': return <>{chip}<code className="path-text history-path">{event.receipt.destination}</code></>;
      case 'drift': return <code className="path-text history-path">{event.installation.destination}</code>;
      default: return chip || null;
    }
  };
  const body = (event: HistoryEvent): ReactNode => {
    switch (event.type) {
      case 'revision': return <div className="history-actions">
        {!event.current && <button className="history-action" onClick={() => restore(event.revision.hash)}><RotateCcw size={12} />Restore as new draft</button>}
        {onInstallRevision && event.approved && <button className="history-action" onClick={() => onInstallRevision(event.revision.hash)}><Download size={12} />Install this revision…</button>}
        {!event.current && <button className="history-action" onClick={() => setPicked([event.revision.hash])}><GitCompare size={12} />Compare with current</button>}
      </div>;
      case 'test': { const t = event.trial; return <>
        {(t.note || t.task) && <p className="history-summary">{t.note || t.task}</p>}
        {t.rubric.length > 0 && <ul className="history-rubric">{t.rubric.map(r => <li key={r}>{r}</li>)}</ul>}
        <div className="history-actions">
          {t.status === 'prepared' ? <><button className="history-action strong" onClick={() => onAction('result', t)}>Record result</button><button className="history-action" onClick={() => void perform(() => api('desktop.copyTrial', { id: t.id }), 'Handoff copied')}><Copy size={12} />Copy handoff</button></>
            : <button className="history-action" aria-expanded={output?.id === t.id} onClick={() => viewOutput(t)}>{output?.id === t.id ? 'Hide local evidence' : 'View local evidence'}</button>}
          <button className="history-action danger" onClick={() => { setOutput(null); onAction('delete-trial', t); }}><Trash2 size={12} />Delete experiment</button>
        </div>
        {output?.id === t.id && <pre className="prompt-preview history-output">{output.text}</pre>}
      </>; }
      case 'approved': return event.approval.note || event.approval.waivedChecks ? <p className="history-summary">{event.approval.note}{event.approval.waivedChecks && <> Checks waived: {event.approval.waivedChecks}</>}</p> : null;
      case 'installed': return <>{event.receipt.error && <p className="error-box">{event.receipt.error}</p>}{event.receipt.status === 'applied' && <div className="history-actions"><button className="history-action" onClick={() => onAction(`rollback:${event.receipt.id}`)}><RotateCcw size={12} />Review rollback</button></div>}</>;
      case 'drift': { const copy = event.installation; return <div className="history-actions">
        {copy.targetId && <button className="history-action strong" title="See which files differ and how" onClick={() => onAction(`compare:${copy.itemId}:${copy.targetId}`)}><FileDiff size={12} />Compare</button>}
        <button className="history-action" title="Reinstall the approved version, or remove the copy" onClick={() => onToggleInstall(copy.provider, copy.targetId)}>Resolve…</button>
      </div>; }
      default: return null;
    }
  };

  return <div className="history-view">
    <div className="item-subbar"><button className="text-button" onClick={onBack}><ArrowLeft size={14} />Content</button><h2>History</h2><span className="muted small">{events.length} event{events.length === 1 ? '' : 's'} · restoring library content does not change installed files</span></div>
    <div className="history-filters" role="group" aria-label="Show">
      {historyFilters.map(f => { const n = events.filter(e => f.types.includes(e.type)).length; return <button key={f.id} className={`history-chip ${filter === f.id ? 'on' : ''}`} aria-pressed={filter === f.id} disabled={!n && f.id !== 'all'} onClick={() => { setFilter(f.id); setShown(PAGE); }}>{f.label}<span>{n}</span></button>; })}
    </div>
    <div className={`history-cols ${pair.length === 2 ? 'comparing' : ''}`}>
      <div className="history-timeline">
        {days.map(day => <section key={day} className="history-day" aria-label={day}>
          <div className="history-day-label"><span>{day}</span></div>
          {page.filter(e => dayLabel(e.at) === day).map(event => {
            const isRevision = event.type === 'revision', on = isRevision && picked.includes(event.revision.hash);
            return <div key={event.id} className={`history-event ${event.type} ${on ? 'picked' : ''}`}>
              <span className="history-time">{timeLabel(event.at)}</span>
              <EventGlyph event={event} />
              <div className="history-card">
                <div className="history-card-top">
                  {isRevision && <label className="history-check" title="Tick two revisions to compare them"><input type="checkbox" checked={on} aria-label={`Compare revision ${shortHash(event.revision.hash)}`} onChange={() => pick(event.revision.hash)} /><span>{on && <Check size={11} strokeWidth={3} />}</span></label>}
                  <div className="history-title">{eventTitle(event, snapshot)}</div>
                </div>
                <div className="history-meta">{meta(event)}</div>
                {body(event)}
              </div>
            </div>;
          })}
        </section>)}
        {!visible.length && <p className="empty-inline">Nothing of this kind yet.</p>}
        {visible.length > shown ? <button className="button history-more" onClick={() => setShown(shown + PAGE)}>Show more ({visible.length - shown} older)</button>
          : visible.length > 0 && filter === 'all' && <p className="history-end">Start of history · captured {date(item.createdAt)}</p>}
      </div>
      <aside className="history-diff" aria-label="Comparison">
        {pair.length === 2 ? <>
          <div className="history-diff-head">
            <GitCompare size={15} /><code className="history-hash big">{shortHash(pair[0].hash)}</code><ArrowRight size={14} className="muted" /><code className="history-hash big">{pair[1].hash === item.revision ? 'current' : shortHash(pair[1].hash)}</code>
            <span className="history-diff-note muted">{pair[0].summary} → {pair[1].summary}</span>
            <button className="icon-button" aria-label="Clear comparison" onClick={() => setPicked([])}><X size={16} /></button>
          </div>
          <div className="history-diff-actions">{pair[0].hash !== item.revision && <button className="button" onClick={() => restore(pair[0].hash)}><RotateCcw size={14} />Restore {shortHash(pair[0].hash)} as new draft</button>}{pair[1].hash !== item.revision && <button className="button" onClick={() => restore(pair[1].hash)}><RotateCcw size={14} />Restore {shortHash(pair[1].hash)}</button>}</div>
          <LineDiff before={pair[0].content} after={pair[1].content} names={{ before: name(pair[0].hash), after: name(pair[1].hash) }} />
          <details><summary>Metadata and files of both versions</summary><pre className="prompt-preview">{JSON.stringify(pair.map(r => ({ revision: shortHash(r.hash), title: r.title, source: r.source, tags: r.tags, licence: r.licence, files: Object.keys(r.files) })), null, 2)}</pre></details>
        </> : <div className="history-diff-empty">
          <GitCompare size={22} />
          <b>{picked.length === 1 ? 'Tick an older revision' : 'Tick two revisions to compare'}</b>
          <p className="muted small">{picked.length === 1 ? 'You ticked the current draft; tick another revision to see what changed.' : `A single ticked revision is compared with the current draft (${shortHash(revision.hash)}).`}</p>
        </div>}
      </aside>
    </div>
  </div>;
}
