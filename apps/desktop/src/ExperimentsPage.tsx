import { useState } from 'react';
import { ArrowRight, Check, FlaskConical, Trash2 } from 'lucide-react';
import type { AgentJob } from '../../../packages/agent/service';
import type { Snapshot, Trial } from '../../../packages/protocol/schema';
import { date, shortHash } from './api';
import { Empty, providerName } from './components';
import { CellChip, countedVerdict, type Run } from './Experiments';
import { trialPlace, trialPlaces } from './trial-place';
import { experimentsOf, reviews } from './TrialLoop';
import './experiments.css';

type Filter = 'all' | 'pass' | 'fail' | 'uncertain';
const filters: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'pass', label: 'Pass' }, { id: 'fail', label: 'Fail' }, { id: 'uncertain', label: 'Uncertain' }];
const tallyWords: [Filter, string][] = [['pass', 'passed'], ['fail', 'failed'], ['uncertain', 'uncertain']];
/** "2 passed · 1 failed", counting your verdict over the agent's. */
const tally = (runs: Run[]) => tallyWords.map(([v, word]) => [runs.filter(r => countedVerdict(r) === v).length, word] as const).filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(' · ');
const firstLine = (text: string) => text.split('\n')[0];

type Props = {
  snapshot: Snapshot; jobs: AgentJob[]; busy: boolean;
  /** Opens the item on its experiments grid. */ onOpen: (itemId: string) => void;
  onResult: (trial: Trial) => void; onDelete: (trial: Trial) => void; onLibrary: () => void;
};

/** Every experiment in the library, grouped by item and then by the revision it tested, with a verdict filter. */
export function ExperimentsPage({ snapshot, jobs, busy, onOpen, onResult, onDelete, onLibrary }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const judged = reviews(snapshot.trials), places = trialPlaces(jobs);
  const jobOf = new Map(jobs.filter(j => j.kind === 'trial' && j.trialId).map(j => [j.trialId!, j]));
  // Your verdicts are trials of their own; they show on the run they judge, not as runs.
  const runs: Run[] = experimentsOf(snapshot.trials).map(trial => ({ id: trial.id, trial, job: jobOf.get(trial.id), review: judged.get(trial.id), revision: trial.revision, column: '', at: trial.createdAt })).sort((a, b) => b.at.localeCompare(a.at));
  if (!runs.length) return <Empty icon={<FlaskConical size={30} />} title="A good prompt earns your trust." action={<button className="button" onClick={onLibrary}>Choose an item to test <ArrowRight size={15} /></button>}>Start with a typical task. Add a boundary case. Record what happened.</Empty>;

  const count = (f: Filter) => f === 'all' ? runs.length : runs.filter(r => countedVerdict(r) === f).length;
  const shown = runs.filter(r => filter === 'all' || countedVerdict(r) === filter);
  const items = new Map(snapshot.items.map(i => [i.id, i]));
  const approved = new Set(snapshot.approvals.filter(a => a.trust === 'local' && !a.revokedAt).map(a => `${a.itemId}:${a.revision}`));
  // Newest activity first, for items and for revisions within an item (runs are already newest first).
  const itemIds = [...new Set(shown.map(r => r.trial!.itemId))];

  return <section className="exps" aria-label="All experiments">
    <div className="exps-bar">
      <div className="exps-filter" role="group" aria-label="Filter experiments by verdict">{filters.map(f => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}<small>{count(f.id)}</small></button>)}</div>
      <span className="muted small">Where you marked an agent run as passed or failed, your verdict counts.</span>
    </div>
    {!shown.length ? <p className="muted exps-none">No experiments with this verdict.</p> : itemIds.map(itemId => {
      const item = items.get(itemId), inItem = shown.filter(r => r.trial!.itemId === itemId), revisions = [...new Set(inItem.map(r => r.revision))];
      const title = item?.title ?? 'Item no longer in the library';
      return <section key={itemId} className="exps-item" aria-label={title}>
        <header className="exps-item-head">
          {item ? <button className="exps-title" title="Open this item’s experiments grid" onClick={() => onOpen(itemId)}>{title}<ArrowRight size={14} /></button> : <span className="exps-title muted">{title}</span>}
          <span className="muted small">{inItem.length} experiment{inItem.length === 1 ? '' : 's'}{tally(inItem) && ` · ${tally(inItem)}`}</span>
        </header>
        {revisions.map(hash => { const inRevision = inItem.filter(r => r.revision === hash); return <div key={hash} className="exps-rev" role="group" aria-label={`Revision ${shortHash(hash)}`}>
          <div className="exps-rev-head"><code>{shortHash(hash)}</code>{item?.revision === hash ? <span className="exp-pill accent">Current</span> : <span className="muted small">Earlier revision</span>}{approved.has(`${itemId}:${hash}`) && <span className="exp-pill ok"><Check size={11} />Approved</span>}<span className="exp-grow" /><span className="muted small">{tally(inRevision)}</span></div>
          {inRevision.map(run => {
            // An unfinished agent run's record has no finding yet; a prepared handoff shows the task it is waiting on.
            const t = run.trial!, text = t.status === 'prepared' ? t.mode === 'manual' ? t.task : '' : t.note || t.task;
            return <div key={run.id} className="exps-row">
              <CellChip run={run} />
              <span className="exps-who">{t.provider === 'manual' ? 'Manual' : providerName[t.provider]}{t.mode === 'manual' && t.provider !== 'manual' ? ' · manual' : ''}</span>
              <span className="exps-where" title={run.job?.workspace}>{trialPlace(t, places)}</span>
              <span className="exps-note" title={text}>{t.case === 'boundary' && <span className="exps-case">Boundary case</span>}{firstLine(text)}</span>
              <span className="muted small exps-when">{date(t.createdAt)}</span>
              <span className="exps-actions">
                {t.status === 'prepared' && t.mode === 'manual' && <button className="text-button" onClick={() => onResult(t)}>Record result</button>}
                <button className="icon-button" aria-label="Delete experiment" title="Delete experiment" disabled={busy} onClick={() => onDelete(t)}><Trash2 size={14} /></button>
              </span>
            </div>;
          })}
        </div>; })}
      </section>;
    })}
  </section>;
}
