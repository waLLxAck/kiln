import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, Folder, FolderPlus, Inbox, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Item } from '../../../packages/protocol/schema';
import { depthOf, dropPlacement, isWithin, leafOf, parentOf, placeCollection, untitledName, type DropZone } from '../../../packages/domain/collections';
import { api } from './api';
import { InlineError, Modal } from './components';

/** Live items in a collection or any of its subfolders. */
export const itemsWithin = (items: Item[], name: string) => items.filter(i => !i.deletedAt && isWithin(i.collection, name));
const plural = (n: number, word = 'item') => `${n} ${word}${n === 1 ? '' : 's'}`;

type Moved = { from: string; to: string };
type Placement = { parent: string; before: string | null };
const MIME = 'application/x-kiln-collection';
/**
 * Native drag and drop for folder rows, shared by the sidebar and the Collections dialog. The top and bottom quarter of a row put
 * the folder beside it, the middle puts it inside; `top` takes it to the top level. A custom type keeps item and file drags from
 * lighting anything up, and drops that would change nothing never reach the library.
 */
export function useCollectionDrag(names: string[], onMove: (name: string, placement: Placement) => void, isOpen: (name: string) => boolean = () => true) {
  const [dragging, setDragging] = useState<string | null>(null), [drop, setDrop] = useState<{ target: string; zone: DropZone } | null>(null);
  const end = () => { setDragging(null); setDrop(null); };
  const placement = (name: string, target: string, zone: DropZone): Placement | null => target ? dropPlacement(names, name, target, zone, isOpen(target)) : { parent: '', before: null };
  const unchanged = (name: string, { parent, before }: Placement) => parent === parentOf(name) && JSON.stringify(placeCollection(names, name, before)) === JSON.stringify(names);
  const zoneOf = (event: DragEvent<HTMLElement>, target: string): DropZone => { if (!target) return 'into'; const box = event.currentTarget.getBoundingClientRect(), at = (event.clientY - box.top) / box.height; return at < .25 ? 'before' : at > .75 ? 'after' : 'into'; };
  const over = (target: string) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!dragging || !event.dataTransfer.types.includes(MIME)) return;
      const zone = zoneOf(event, target);
      if (!placement(dragging, target, zone)) { if (drop?.target === target) setDrop(null); return; }
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      if (drop?.target !== target || drop.zone !== zone) setDrop({ target, zone });
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(current => current?.target === target ? null : current); },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const name = event.dataTransfer.getData(MIME) || dragging; if (!name) return;
      event.preventDefault(); event.stopPropagation();
      const where = placement(name, target, zoneOf(event, target)); end();
      if (where && !unchanged(name, where)) onMove(name, where);
    },
    'data-drop': drop?.target === target ? drop.zone : undefined,
  });
  return {
    /** Spread on a folder's row: it can be dragged and dropped on. Pass `false` while its name is being edited, so selecting text does not drag it. */
    row: (name: string, draggable = true) => ({ ...over(name), draggable, 'data-dragging': dragging === name || undefined,
      onDragStart: (event: DragEvent<HTMLElement>) => { if (!draggable) return; event.stopPropagation(); event.dataTransfer.setData(MIME, name); event.dataTransfer.effectAllowed = 'move'; setDragging(name); },
      onDragEnd: end }),
    top: over(''),
  };
}

/**
 * Edits the last level of a folder's name in place, like a file manager: the text starts selected, Enter or leaving the field saves,
 * Escape keeps the current name. A blank or unchanged name just stops editing. The caller closes it once the rename is saved.
 */
export function CollectionNameInput({ name, onRename, onDone, onError }: { name: string; onRename: (to: string) => Promise<unknown>; onDone: () => void; onError: (message: string) => void }) {
  const [draft, setDraft] = useState(leafOf(name)), input = useRef<HTMLInputElement>(null), settled = useRef(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const commit = async () => {
    if (settled.current) return;
    const leaf = draft.trim(), parent = parentOf(name);
    if (!leaf || leaf === leafOf(name)) { settled.current = true; onDone(); return; }
    if (leaf.includes('/')) { onError('Folder names cannot contain “/”. Drag a folder onto another to nest it.'); return; }
    settled.current = true;
    try { await onRename(parent ? `${parent}/${leaf}` : leaf); } finally { settled.current = false; }
  };
  return <input ref={input} className="collection-name-input" aria-label={`Name for ${name}`} value={draft} maxLength={80} onChange={e => setDraft(e.target.value)} onBlur={() => void commit()}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); void commit(); } else if (e.key === 'Escape') { e.preventDefault(); settled.current = true; onDone(); } }} />;
}

type Props = { names: string[]; items: Item[]; onClose: () => void; /** Refreshes the app; `moved` says a collection now lives elsewhere, so a view showing it can follow. */ onDone: (moved?: Moved) => Promise<void>; onDelete: (name: string) => void; onOpen: (name: string) => void };
/**
 * Collections as a tree, not a textarea: rename in place, drag to nest or reorder (the arrows reorder from the keyboard), add a
 * collection or a subfolder, delete through the usual confirmation. Items keep their revisions and approvals.
 */
export function CollectionsDialog({ names, items, onClose, onDone, onDelete, onOpen }: Props) {
  const [editing, setEditing] = useState<string | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const count = (name: string) => itemsWithin(items, name).length;
  const run = async (action: () => Promise<Moved | void>) => { setBusy(true); setError(''); try { const moved = await action(); await onDone(moved || undefined); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const rename = (from: string, to: string) => run(async () => { const moved = await api<Moved>('collections.rename', { from, to }); setEditing(null); return moved; });
  /** A new folder exists straight away as "New Folder" and opens for naming, so there is nothing to type first. */
  const create = (parent = '') => void run(async () => { const created = await api<{ name: string }>('collections.create', { name: untitledName(names, parent) }); setEditing(created.name); });
  const place = (name: string, { parent, before }: Placement) => void run(() => api<Moved>('collections.move', { name, parent, before }));
  const drag = useCollectionDrag(names, place);
  const siblings = (name: string) => names.filter(n => parentOf(n) === parentOf(name));
  return <Modal title="Collections" subtitle="Folders you organise items into. The order here is the sidebar order." onClose={() => { if (!busy) onClose(); }}>
    <InlineError error={error} />
    <div className="collection-rows" role="list">{names.map(name => { const row = siblings(name), at = row.indexOf(name); return <div className="collection-row" role="listitem" key={name} style={{ marginLeft: depthOf(name) * 18 }} {...drag.row(name, !busy && editing !== name)}>
      {editing === name ? <><Folder size={14} /><CollectionNameInput name={name} onRename={to => rename(name, to)} onDone={() => setEditing(null)} onError={setError} /></>
        : <><button type="button" className="collection-name text-button" title={`Show “${name}” in the library`} onClick={() => { onOpen(name); onClose(); }}><Folder size={14} /><span>{leafOf(name)}</span><small>{count(name)}</small></button>
          <button type="button" className="icon-button" aria-label={`Add a subfolder to ${name}`} title="Add a subfolder" disabled={busy} onClick={() => create(name)}><FolderPlus size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Rename ${name}`} title="Rename" disabled={busy} onClick={() => setEditing(name)}><Pencil size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Move ${name} up`} title="Move up" disabled={busy || at === 0} onClick={() => place(name, { parent: parentOf(name), before: row[at - 1] })}><ArrowUp size={14} /></button>
          <button type="button" className="icon-button" aria-label={`Move ${name} down`} title="Move down" disabled={busy || at === row.length - 1} onClick={() => place(name, { parent: parentOf(name), before: row[at + 2] ?? null })}><ArrowDown size={14} /></button>
          <button type="button" className="icon-button danger" aria-label={`Delete ${name}`} title="Delete; you choose whether its items stay in the library or go to the trash" disabled={busy} onClick={() => onDelete(name)}><Trash2 size={14} /></button></>}
    </div>; })}</div>
    <div className="collection-add"><button type="button" className="button" disabled={busy} onClick={() => create()}><Plus size={14} />New folder</button></div>
    <p className="muted small">Drag a folder onto another to nest it, or above or below a row to reorder it. Renaming or moving a collection takes its subfolders and items with it. Organising never creates a revision, so approved items stay approved. Imported collections can be renamed freely; nothing ties them to their source repository.</p>
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
