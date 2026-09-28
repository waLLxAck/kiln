import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Check, Download, Loader2, Merge } from 'lucide-react';
import type { DuplicateGroup, Installation, Item, ItemDetail, Snapshot } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { Badge, Modal } from './components';
import { LineDiff } from './Diff';
import { locationLabel } from './library-filters';
import { experimentsOf, reviews, verdictOf } from './trial-verdicts';
import { updateInstalls } from './InstallUpdates';
import { fileDifferences, lineChanges, suggestKeep, suggestTags, summary, type FileState } from './consolidate-model';
import './consolidate.css';

/** What `items.consolidate` returns; `undo` goes back to `items.unconsolidate` unchanged. */
export type ConsolidateResult = { kept: Item; revised: boolean; merged: string[]; undo: Record<string, unknown> };
type Props = {
  group: DuplicateGroup; snapshot: Snapshot; installations: Installation[];
  /** A short way to tell copies apart: the folder an import came from, else the collection. */ where: (item: Item) => string;
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>;
  /** Called once the copies are consolidated, before any follow-up about installed copies. */ onDone: (result: ConsolidateResult) => void;
  onMessage: (message: string) => void; onClose: () => void;
};
const fileLabel: Record<FileState, string> = { same: 'same', changed: 'differs', 'only-kept': 'only in the kept text', 'only-other': 'only in this copy' };

/**
 * Consolidate duplicates: the copies side by side with what matters for choosing (collection, tags, status, installs, tests,
 * use, where it came from), a radio to keep one and another to take the text (with its bundled files) from any copy, the
 * collection and tags of the result, and a diff of the kept text against each other copy. Consolidating moves the others to
 * Trash as merged; afterwards it offers the usual update for installed copies that still hold another version.
 */
export function ConsolidateDialog({ group, snapshot, installations, where, perform, refresh, onDone, onMessage, onClose }: Props) {
  const items = group.ids.flatMap(id => snapshot.items.find(i => i.id === id) ?? []);
  const [details, setDetails] = useState<Record<string, ItemDetail> | null>(null), [error, setError] = useState('');
  useEffect(() => { let active = true; void Promise.all(group.ids.map(id => api<ItemDetail>('items.read', { id }))).then(list => { if (active) setDetails(Object.fromEntries(list.map(d => [d.item.id, d]))); }).catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); }); return () => { active = false; }; }, [group.ids.join()]);
  const approvedNow = (item: Item) => snapshot.approvals.some(a => a.itemId === item.id && a.revision === item.revision && a.trust === 'local');
  const [keep, setKeep] = useState(() => suggestKeep(items, snapshot.approvals, installations, snapshot.usage).id);
  const kept = items.find(i => i.id === keep) ?? items[0], others = items.filter(i => i.id !== kept.id);
  const [text, setText] = useState(keep), [compare, setCompare] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>(() => suggestTags(kept, others, approvedNow(kept))), [collection, setCollection] = useState(kept.collection);
  // Choosing another copy to keep resets the choices that follow from it.
  const choose = (id: string) => { const next = items.find(i => i.id === id)!, rest = items.filter(i => i.id !== id); setKeep(id); setText(id); setTags(suggestTags(next, rest, approvedNow(next))); setCollection(next.collection); setCompare(null); };
  const [after, setAfter] = useState<{ kept: Item; outdated: number; waiting: number; drifted: number } | null>(null), [working, setWorking] = useState(false);

  const allTags = [...new Set(items.flatMap(i => i.tags))];
  const collections = [...new Set(items.map(i => i.collection))];
  const chosen = details?.[text]?.revision, keptRevision = details?.[kept.id]?.revision;
  // The kept text against one other copy at a time; with three or more copies a switch picks which.
  const against = items.filter(i => i.id !== text), other = against.find(i => i.id === compare) ?? against[0];
  const otherText = other && details?.[other.id]?.revision;
  const textChanged = text !== kept.id && Boolean(chosen && keptRevision && (chosen.content !== keptRevision.content || JSON.stringify(chosen.files) !== JSON.stringify(keptRevision.files)));
  const tagsChanged = [...tags].sort().join('\n') !== [...kept.tags].sort().join('\n');
  const line = useMemo(() => summary({ kept, merged: others, where, textChanged, tagsChanged, collectionChanged: collection !== kept.collection, approved: approvedNow(kept) }), [kept, others, textChanged, tagsChanged, collection]);

  // Copies that are this item's: installed by Kiln for it, or a folder holding exactly its files. A same-named folder with other files is not.
  const copiesHere = (item: Item) => installations.filter(c => c.itemId === item.id && (c.state !== 'external' || c.matches)).map(c => `${c.scope === 'project' ? snapshot.targets.find(t => t.id === c.targetId)?.name ?? 'a project' : c.location ? locationLabel[c.location] : c.provider}${c.state === 'drifted' ? ' (edited)' : ''}`);
  const tests = (item: Item) => { const d = details?.[item.id]; if (!d) return '…'; const runs = experimentsOf(d.trials).filter(t => t.status === 'completed'), judged = reviews(d.trials); if (!runs.length) return 'none'; const passed = runs.filter(t => verdictOf(t, judged) === 'pass').length; return `${runs.length} · ${passed} passed`; };
  const used = (item: Item) => { const n = snapshot.usage[item.id]; return n ? `copied ${n.copied}× · used ${n.used}×` : 'not yet'; };
  const status = (item: Item) => approvedNow(item) ? <Badge status="approved" /> : snapshot.approvals.some(a => a.itemId === item.id && a.trust === 'local') ? <span className="cons-inline"><Badge status={item.status === 'testing' ? 'testing' : 'draft'} /><small className="muted">approved earlier</small></span> : <Badge status={item.status === 'testing' ? 'testing' : 'draft'} />;
  const textNote = (item: Item) => {
    if (!chosen) return '…';
    if (item.id === text) return <b>This text</b>;
    const revision = details?.[item.id]?.revision; if (!revision) return '…';
    const { added, removed } = lineChanges(chosen.content, revision.content), files = fileDifferences(chosen.files, revision.files).length;
    const words = [added || removed ? `+${added} −${removed} lines` : 'same text', files ? `${files} file${files === 1 ? '' : 's'} differ` : ''].filter(Boolean).join(' · ');
    return <span className="muted">{words}</span>;
  };

  const consolidate = () => void perform(async () => {
    setWorking(true);
    try {
      const result = await api<ConsolidateResult>('items.consolidate', { keep: kept.id, expect: kept.revision, merge: others.map(i => ({ id: i.id, expect: i.revision })), content: text, tags, collection });
      await refresh(); onDone(result);
      // Copies installed for the merged items are the kept item's now; offer the usual, safe update for any that hold another version.
      const copies = await api<Installation[]>('deploy.installations', { itemId: result.kept.id });
      const outdated = copies.filter(c => c.outdated).length, drifted = copies.filter(c => c.state === 'drifted').length;
      // Copies Kiln wrote for a merged copy wait for an approval of the kept item before they can be updated.
      const fromMerged = copies.filter(c => c.state === 'installed' && snapshot.receipts.find(r => r.id === c.receiptId)?.itemId !== result.kept.id);
      const waiting = snapshot.approvals.some(a => a.itemId === result.kept.id && a.trust === 'local') ? 0 : fromMerged.length;
      if (outdated || drifted || waiting) setAfter({ kept: result.kept, outdated, waiting, drifted }); else onClose();
    } finally { setWorking(false); }
  });
  const update = () => after && void perform(async () => { const note = await updateInstalls(after.kept, false); await refresh(); onMessage(note); onClose(); });

  if (after) return <Modal title="Consolidated" subtitle={`“${after.kept.title}” is the only copy now. Undo is in the toast, or restore the others from Trash.`} onClose={onClose}>
    {after.outdated > 0 && <p><b>{after.outdated} installed {after.outdated === 1 ? 'copy holds' : 'copies hold'} another version.</b> Kiln wrote {after.outdated === 1 ? 'it' : 'them'} and nobody changed {after.outdated === 1 ? 'it' : 'them'} since, so updating to the approved revision is safe.</p>}
    {after.waiting > 0 && <p><b>{after.waiting} installed {after.waiting === 1 ? 'copy holds' : 'copies hold'} another version.</b> Approve “{after.kept.title}” to update {after.waiting === 1 ? 'it' : 'them'}.</p>}
    {after.drifted > 0 && <p className="muted">{after.drifted} {after.drifted === 1 ? 'copy was' : 'copies were'} edited outside Kiln and {after.drifted === 1 ? 'stays' : 'stay'} as {after.drifted === 1 ? 'it is' : 'they are'}. Compare {after.drifted === 1 ? 'it' : 'them'} in the item’s Installs section.</p>}
    <div className="modal-actions"><button className="button" onClick={onClose}>{after.outdated ? 'Not now' : 'Close'}</button>{after.outdated > 0 && <button className="button primary" onClick={update}><Download size={14} />Update {after.outdated === 1 ? 'it' : 'them'}</button>}</div>
  </Modal>;

  return <Modal title={`Consolidate ${items.length} copies of “${kept.title}”`} subtitle="Keep one. The others move to Trash, marked as merged into it." onClose={onClose} wide>
    <div className={`cons n${Math.min(items.length, 4)}`}>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="cons-scroll">
        <table className="cons-table" style={{ '--cons-cols': items.length } as CSSProperties}>
          <thead><tr><th scope="row" aria-label="Copy" />{items.map(item => <th key={item.id} scope="col" className={item.id === kept.id ? 'kept' : ''}>
            <label className="cons-keep"><input type="radio" name="cons-keep" checked={item.id === kept.id} onChange={() => choose(item.id)} /><span><b>{item.id === kept.id ? 'Keep' : 'Merge into kept'}</b><span className="cons-title" title={item.title}>{item.title}</span><small className="muted">{where(item)}</small></span></label>
          </th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">Collection</th>{items.map(item => <td key={item.id}>{item.collection.replaceAll('/', ' / ') || <span className="muted">Unfiled</span>}</td>)}</tr>
            <tr><th scope="row">Tags</th>{items.map(item => <td key={item.id}>{item.tags.length ? item.tags.map(t => <span key={t} className="cons-chip">{t}</span>) : <span className="muted">none</span>}</td>)}</tr>
            <tr><th scope="row">Status</th>{items.map(item => <td key={item.id}>{status(item)}</td>)}</tr>
            <tr><th scope="row">Installed here</th>{items.map(item => { const places = copiesHere(item); return <td key={item.id}>{places.length ? places.join(', ') : <span className="muted">no copy</span>}</td>; })}</tr>
            <tr><th scope="row">Tests</th>{items.map(item => <td key={item.id}>{tests(item)}</td>)}</tr>
            <tr><th scope="row">Use</th>{items.map(item => <td key={item.id}>{used(item)}</td>)}</tr>
            <tr><th scope="row">Updated</th>{items.map(item => <td key={item.id} className="muted">{date(item.updatedAt)} · {shortHash(item.revision)}</td>)}</tr>
            <tr className="cons-text-row"><th scope="row">Text</th>{items.map(item => <td key={item.id}>
              <label className="cons-use"><input type="radio" name="cons-text" checked={item.id === text} disabled={!details} onChange={() => { setText(item.id); setCompare(null); }} /><span>Use this text</span></label>
              <div className="small">{textNote(item)}</div>
            </td>)}</tr>
          </tbody>
        </table>
      </div>

      <div className="cons-result">
        <label className="cons-field"><span>Collection</span><select aria-label="Collection of the kept item" value={collection} onChange={event => setCollection(event.target.value)}>{collections.map(c => <option key={c} value={c}>{c.replaceAll('/', ' / ') || 'Unfiled'}</option>)}</select></label>
        <div className="cons-field"><span id="cons-tags">Tags</span><div className="cons-tags" role="group" aria-labelledby="cons-tags">{allTags.length ? allTags.map(t => { const on = tags.includes(t); return <button key={t} type="button" className={`cons-tag ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setTags(on ? tags.filter(x => x !== t) : [...tags, t])}>{on && <Check size={11} />}{t}</button>; }) : <span className="muted small">No copy has tags.</span>}</div></div>
      </div>

      <section className="cons-diff" aria-label="Differences">
        {!details ? <p className="muted"><Loader2 size={14} className="spin" /> Reading the copies…</p> : other && chosen && otherText ? <>
          <div className="cons-diff-head">
            <span>The text you keep against</span>
            {against.length > 1 ? <span className="item-seg" role="group" aria-label="Compare with">{against.map(i => <button key={i.id} type="button" aria-pressed={i.id === other.id} className={i.id === other.id ? 'on' : ''} onClick={() => setCompare(i.id)}>{where(i)}</button>)}</span> : <b>{where(other)}</b>}
            <span className="cons-legend"><span className="removed">only in that copy</span><span className="added">only in the text you keep</span></span>
          </div>
          {chosen.content === otherText.content ? <p className="muted small">Same text.</p> : <LineDiff before={otherText.content} after={chosen.content} names={{ before: 'that copy', after: 'the text you keep' }} className="cons-linediff" />}
          {(() => { const files = fileDifferences(chosen.files, otherText.files); return files.length ? <ul className="cons-files">{files.map(f => <li key={f.name}><code>{f.name}</code><span className={`cons-file ${f.state}`}>{fileLabel[f.state]}</span></li>)}</ul> : Object.keys(chosen.files).length ? <p className="muted small">Same bundled files.</p> : null; })()}
        </> : null}
      </section>

      <p className="cons-summary" role="status">{line} Approvals and tests stay with their own items.</p>
      <div className="modal-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={!details || working} onClick={consolidate}>{working ? <Loader2 size={14} className="spin" /> : <Merge size={14} />}Consolidate</button></div>
    </div>
  </Modal>;
}
