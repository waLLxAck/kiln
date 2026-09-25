import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Folder, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Item } from '../../../packages/protocol/schema';
import { api } from './api';
import { InlineError, Modal } from './components';

type Props = { names: string[]; items: Item[]; /** Start with this collection's name open for editing. */ renaming?: string; onClose: () => void; onDone: () => Promise<void>; onDelete: (name: string) => void; onOpen: (name: string) => void };
/**
 * Collections as a list, not a textarea: rename in place, reorder with the arrows, add at the bottom, delete through the usual confirmation.
 * A rename moves every item, trashed ones included; because the collection is part of each revision, approved items return to Captured.
 */
export function CollectionsDialog({ names, items, renaming, onClose, onDone, onDelete, onOpen }: Props) {
  const [editing, setEditing] = useState<string | null>(renaming ?? null), [draft, setDraft] = useState(renaming ?? ''), [adding, setAdding] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const count = (name: string) => items.filter(i => i.collection === name && !i.deletedAt).length;
  const approved = (name: string) => items.filter(i => i.collection === name && i.status === 'approved').length;
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await onDone(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const save = (next: string[]) => run(() => api('collections.save', { names: next }));
  const rename = (from: string) => { const to = draft.trim(); if (!to || to === from) { setEditing(null); return; } void run(async () => { await api('collections.rename', { from, to }); setEditing(null); }); };
  const move = (name: string, direction: number) => { const at = names.indexOf(name), to = at + direction; if (at < 0 || to < 0 || to >= names.length) return; const next = [...names]; [next[at], next[to]] = [next[to], next[at]]; void save(next); };
  const add = () => { const name = adding.trim(); if (!name) return; if (names.some(n => n.toLowerCase() === name.toLowerCase())) { setError(`“${name}” already exists.`); return; } void run(async () => { await api('collections.save', { names: [...names, name] }); setAdding(''); }); };
  return <Modal title="Collections" subtitle="Folders you organise items into. The order here is the sidebar order." onClose={() => { if (!busy) onClose(); }}>
    <InlineError error={error} />
    <div className="collection-rows" role="list">{names.map((name, index) => <div className="collection-row" role="listitem" key={name}>
      {editing === name ? <form onSubmit={event => { event.preventDefault(); rename(name); }}>
          <input aria-label={`New name for ${name}`} value={draft} onChange={e => setDraft(e.target.value)} autoFocus maxLength={80} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } }} />
          <button type="submit" className="icon-button" aria-label="Save name" title="Save (Enter)" disabled={busy || !draft.trim()}><Check size={15} /></button>
          <button type="button" className="icon-button" aria-label="Cancel rename" title="Cancel (Esc)" onClick={() => setEditing(null)}><X size={15} /></button>
        </form>
        : <><button type="button" className="collection-name text-button" title={`Show “${name}” in the library`} onClick={() => { onOpen(name); onClose(); }}><Folder size={14} /><span>{name}</span><small>{count(name)}</small></button>
          <button type="button" className="icon-button" aria-label={`Rename ${name}`} title="Rename" disabled={busy} onClick={() => { setEditing(name); setDraft(name); }}><Pencil size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Move ${name} up`} title="Move up" disabled={busy || index === 0} onClick={() => move(name, -1)}><ArrowUp size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Move ${name} down`} title="Move down" disabled={busy || index === names.length - 1} onClick={() => move(name, 1)}><ArrowDown size={14} /></button>
          <button type="button" className="icon-button danger" aria-label={`Delete ${name}`} title={count(name) ? `Delete; its ${count(name)} item${count(name) === 1 ? '' : 's'} move to the trash` : 'Delete this empty collection'} disabled={busy} onClick={() => onDelete(name)}><Trash2 size={14} /></button></>}
    </div>)}</div>
    {editing && approved(editing) > 0 && <p className="small muted">Renaming moves {approved(editing)} approved item{approved(editing) === 1 ? '' : 's'} to a new revision, so {approved(editing) === 1 ? 'it' : 'they'} will need approving again.</p>}
    <form className="collection-add" onSubmit={event => { event.preventDefault(); add(); }}>
      <input aria-label="New collection" placeholder="New collection…" value={adding} onChange={e => setAdding(e.target.value)} maxLength={80} disabled={busy} />
      <button type="submit" className="button" disabled={busy || !adding.trim()}><Plus size={14} />Add</button>
    </form>
    <p className="muted small">Items are moved with the collection when it is renamed. A collection that still has items stays in the sidebar until they are moved or trashed; imported collections can be renamed freely, nothing ties them to their source repository.</p>
    <div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>Done</button></div>
  </Modal>;
}
