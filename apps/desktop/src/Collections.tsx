import { useState } from 'react';
import { ArrowDown, ArrowUp, Check, Folder, FolderPlus, Inbox, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Item } from '../../../packages/protocol/schema';
import { depthOf, isWithin, leafOf, parentOf } from '../../../packages/domain/collections';
import { api } from './api';
import { InlineError, Modal } from './components';

/** Live items in a collection or any of its subfolders. */
export const itemsWithin = (items: Item[], name: string) => items.filter(i => !i.deletedAt && isWithin(i.collection, name));
const plural = (n: number, word = 'item') => `${n} ${word}${n === 1 ? '' : 's'}`;

type Props = { names: string[]; items: Item[]; /** Start with this collection's name open for editing. */ renaming?: string; /** Start the add field inside this collection. */ subfolderOf?: string; onClose: () => void; onDone: () => Promise<void>; onDelete: (name: string) => void; onOpen: (name: string) => void };
/**
 * Collections as a tree, not a textarea: rename in place, reorder among siblings, add a collection or a subfolder, delete through the usual confirmation.
 * A path in the name nests it ("Game Design/Puzzles"); renaming to a path moves the collection with its subfolders. Items keep their revisions and approvals.
 */
export function CollectionsDialog({ names, items, renaming, subfolderOf, onClose, onDone, onDelete, onOpen }: Props) {
  const [editing, setEditing] = useState<string | null>(renaming ?? null), [draft, setDraft] = useState(renaming ?? ''), [adding, setAdding] = useState(subfolderOf ? `${subfolderOf}/` : '');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const count = (name: string) => itemsWithin(items, name).length;
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await onDone(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const rename = (from: string) => { const to = draft.trim(); if (!to || to === from) { setEditing(null); return; } void run(async () => { await api('collections.rename', { from, to }); setEditing(null); }); };
  const siblings = (name: string) => names.filter(n => parentOf(n) === parentOf(name));
  /** Swapping two siblings is enough: the saved list keeps each subfolder after its parent. */
  const move = (name: string, direction: number) => { const row = siblings(name), other = row[row.indexOf(name) + direction]; if (!other) return; const next = [...names], a = next.indexOf(name), b = next.indexOf(other); [next[a], next[b]] = [next[b], next[a]]; void run(() => api('collections.save', { names: next })); };
  const add = () => { const name = adding.trim(); if (!name) return; void run(async () => { await api('collections.create', { name }); setAdding(''); }); };
  return <Modal title="Collections" subtitle="Folders you organise items into. The order here is the sidebar order." onClose={() => { if (!busy) onClose(); }}>
    <InlineError error={error} />
    <div className="collection-rows" role="list">{names.map(name => { const row = siblings(name), at = row.indexOf(name); return <div className="collection-row" role="listitem" key={name} style={{ marginLeft: depthOf(name) * 18 }}>
      {editing === name ? <form onSubmit={event => { event.preventDefault(); rename(name); }}>
          <input aria-label={`New name for ${name}`} title="Use / to nest it in another collection" value={draft} onChange={e => setDraft(e.target.value)} autoFocus maxLength={80} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } }} />
          <button type="submit" className="icon-button" aria-label="Save name" title="Save (Enter)" disabled={busy || !draft.trim()}><Check size={15} /></button>
          <button type="button" className="icon-button" aria-label="Cancel rename" title="Cancel (Esc)" onClick={() => setEditing(null)}><X size={15} /></button>
        </form>
        : <><button type="button" className="collection-name text-button" title={`Show “${name}” in the library`} onClick={() => { onOpen(name); onClose(); }}><Folder size={14} /><span>{leafOf(name)}</span><small>{count(name)}</small></button>
          <button type="button" className="icon-button" aria-label={`Add a subfolder to ${name}`} title="Add a subfolder" disabled={busy} onClick={() => setAdding(`${name}/`)}><FolderPlus size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Rename ${name}`} title="Rename or move (use / to nest it)" disabled={busy} onClick={() => { setEditing(name); setDraft(name); }}><Pencil size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Move ${name} up`} title="Move up" disabled={busy || at === 0} onClick={() => move(name, -1)}><ArrowUp size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Move ${name} down`} title="Move down" disabled={busy || at === row.length - 1} onClick={() => move(name, 1)}><ArrowDown size={14} /></button>
          <button type="button" className="icon-button danger" aria-label={`Delete ${name}`} title="Delete; you choose whether its items stay in the library or go to the trash" disabled={busy} onClick={() => onDelete(name)}><Trash2 size={14} /></button></>}
    </div>; })}</div>
    <form className="collection-add" onSubmit={event => { event.preventDefault(); add(); }}>
      <input aria-label="New collection" placeholder="New collection… (Parent/Name for a subfolder)" value={adding} onChange={e => setAdding(e.target.value)} maxLength={80} disabled={busy} />
      <button type="submit" className="button" disabled={busy || !adding.trim()}><Plus size={14} />Add</button>
    </form>
    <p className="muted small">Renaming or moving a collection takes its subfolders and items with it. Organising never creates a revision, so approved items stay approved. Imported collections can be renamed freely; nothing ties them to their source repository.</p>
    <div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>Done</button></div>
  </Modal>;
}

/** Files items in a collection, a new one, or none. Only where they are filed changes; content, approvals and installs stay. */
export function MoveItemsDialog({ names, items, onClose, onDone }: { names: string[]; items: Item[]; onClose: () => void; onDone: (collection: string, moved: number) => Promise<void> }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [name, setName] = useState('');
  const current = items.length === 1 ? items[0].collection : null;
  const move = async (collection: string) => { setBusy(true); setError(''); try { const result = await api<{ collection: string; moved: string[] }>('items.move', { ids: items.map(i => i.id), collection }); await onDone(result.collection, result.moved.length); } catch (e) { setError(String(e)); setBusy(false); } };
  return <Modal title={items.length === 1 ? `Move “${items[0].title}”` : `Move ${plural(items.length)}`} subtitle="Choose where to file it. Content, approval and installed copies do not change." onClose={() => { if (!busy) onClose(); }}>
    <InlineError error={error} />
    <div className="collection-rows" role="list">
      <div className="collection-row" role="listitem"><button type="button" className="collection-name text-button" disabled={busy || current === ''} onClick={() => void move('')}><Inbox size={14} /><span>No collection</span><small>{current === '' ? 'current' : 'unfiled, in the library only'}</small></button></div>
      {names.map(n => <div className="collection-row" role="listitem" key={n} style={{ marginLeft: depthOf(n) * 18 }}><button type="button" className="collection-name text-button" aria-label={`Move to ${n}`} disabled={busy || current === n} onClick={() => void move(n)}><Folder size={14} /><span>{leafOf(n)}</span>{current === n && <small>current</small>}</button></div>)}
    </div>
    <form className="collection-add" onSubmit={event => { event.preventDefault(); if (name.trim()) void move(name); }}>
      <input aria-label="New collection for the items" placeholder="Or a new collection… (Parent/Name for a subfolder)" value={name} onChange={e => setName(e.target.value)} maxLength={80} disabled={busy} />
      <button type="submit" className="button" disabled={busy || !name.trim()}><FolderPlus size={14} />Move</button>
    </form>
    <div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>Cancel</button></div>
  </Modal>;
}

/** Deleting asks what happens to the items: they stay in the library one level up, or they go to the trash with the collection. */
export function DeleteCollectionDialog({ name, names, items, onClose, onDelete }: { name: string; names: string[]; items: Item[]; onClose: () => void; onDelete: (mode: 'keep' | 'trash', note: string) => void }) {
  const inside = itemsWithin(items, name), subfolders = names.filter(n => n !== name && isWithin(n, name)).length, parent = parentOf(name);
  const destination = parent ? `“${parent}”` : 'the library, outside any collection';
  const what = [inside.length ? plural(inside.length) : '', subfolders ? plural(subfolders, 'subfolder') : ''].filter(Boolean).join(' and ');
  if (!inside.length && !subfolders) return <Modal title={`Delete “${name}”?`} subtitle="This collection is empty." onClose={onClose}><p>The collection disappears from the sidebar. Assigning it to an item again recreates it.</p><div className="modal-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button primary" onClick={() => onDelete('keep', `Deleted “${name}”`)}><Trash2 size={14} />Delete collection</button></div></Modal>;
  return <Modal title={`Delete “${name}”?`} subtitle={`It holds ${what}.`} onClose={onClose}>
    <p><b>Keep items</b> moves {subfolders ? 'its items and subfolders' : 'its items'} to {destination}. Nothing else changes: approvals and installed copies stay.</p>
    <p><b>Move items to trash</b> trashes {inside.length ? `the ${plural(inside.length)}` : 'nothing but the folders'}{subfolders ? ', subfolders included' : ''}. They keep their history and can be restored from Trash; restoring one brings the collection back. Installed copies in agent folders are not touched.</p>
    <div className="modal-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button danger-text" onClick={() => onDelete('trash', inside.length ? `Deleted “${name}”; ${plural(inside.length)} moved to the trash` : `Deleted “${name}”`)}><Trash2 size={14} />Move items to trash</button><button className="button primary" autoFocus onClick={() => onDelete('keep', `Deleted “${name}”; ${what} moved to ${parent ? `“${parent}”` : 'the library'}`)}>Keep items</button></div>
  </Modal>;
}
