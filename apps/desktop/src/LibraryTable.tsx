import { Fragment, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref, type UIEvent } from 'react';
import { ChevronDown, ChevronRight, Copy, Download, FlaskConical, Star, Tags, X } from 'lucide-react';
import type { Approval, Installation, Item, Trial } from '../../../packages/protocol/schema';
import { ContextMenu, KindIcon, type MenuEntry } from './components';
import { date } from './api';
import { InstalledCell, StatusCell, TableHead, TestCell, type Location } from './Library';
import { installable } from './library-filters';
import { site, type GroupKey, type Sort, type SortKey } from './library-sort';
import { SwipeToArchive } from './Swipe';

type Row = { item: Item; published: boolean; trial?: Trial; from?: { label: string; full: string }; made?: number };
type Props = {
  groups: { key: string; label: string; items: Item[] }[]; group: GroupKey; collectionShown: boolean;
  row: (item: Item) => Row; locations: Location[]; installations: Installation[]; approvals: Approval[];
  selected: string; picked: string[]; sort: NonNullable<Sort>; onSort: (key: SortKey) => void;
  onClick: (event: MouseEvent, item: Item) => void; onMenu: (event: MouseEvent, item: Item) => void;
  /** Keyboard: move focus, open, pick everything, and the menu's single-key shortcuts. */
  onFocusRow: (id: string) => void; onOpen: (id: string) => void; onSelectAll: () => void; onShortcut: (event: KeyboardEvent, id: string) => boolean;
  canSwipe: (item: Item) => boolean; onArchive: (item: Item) => void;
  onCopy: (item: Item) => void; onTest: (item: Item) => void; installEntries: (item: Item) => MenuEntry[];
  scroll: { ref: Ref<HTMLDivElement>; onScroll: (event: UIEvent<HTMLDivElement>) => void };
  empty: ReactNode; hint: string;
};

/**
 * The library as a table, one line per item. Click opens an item; Ctrl-click and Shift-click pick rows, arrows move between them
 * and Enter opens the focused one. Hovering a row shows Copy, Test and Install; swiping it sideways archives it.
 */
export function LibraryTable({ groups, group, collectionShown, row, locations, installations, approvals, selected, picked, sort, onSort, onClick, onMenu, onFocusRow, onOpen, onSelectAll, onShortcut, canSwipe, onArchive, onCopy, onTest, installEntries, scroll, empty, hint }: Props) {
  const [folded, setFolded] = useState<string[]>([]);
  const [install, setInstall] = useState<{ x: number; y: number; item: Item } | null>(null);
  const table = useRef<HTMLDivElement>(null);
  const many = picked.length > 1;
  // Rows in the order shown, skipping folded groups: what the arrows walk through.
  const visible = groups.flatMap(g => group !== 'none' && folded.includes(g.key) ? [] : g.items);
  const focusable = visible.some(i => i.id === selected) ? selected : visible[0]?.id;
  const focusSelected = () => requestAnimationFrame(() => table.current?.querySelector<HTMLElement>('.item-card.selected')?.focus());
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); onSelectAll(); return; }
    if (install || !(event.target instanceof HTMLElement) || !event.target.classList.contains('item-card')) return;
    // Keys act on the row that has focus, which Tab or a script may have moved away from the highlighted one.
    const id = event.target.dataset.id ?? selected;
    if (event.key === 'Enter') { event.preventDefault(); if (id) onOpen(id); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') { if (onShortcut(event, id)) event.preventDefault(); return; }
    const index = visible.findIndex(i => i.id === id), next = visible[index < 0 ? 0 : index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault(); onFocusRow(next.id); focusSelected();
  };
  const actions = (item: Item) => <span className="row-actions" onClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    {item.kind !== 'source' && <button type="button" className="row-action" title="Copy to the clipboard" onClick={() => onCopy(item)}><Copy size={13} />Copy</button>}
    {item.kind !== 'source' && !item.deletedAt && <button type="button" className="row-action" title="Run an experiment" onClick={() => onTest(item)}><FlaskConical size={13} />Test</button>}
    {installable(item) && !item.deletedAt && <button type="button" className="row-action" aria-haspopup="menu" title="Install into a skill folder" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setInstall({ x: box.right - 240, y: box.bottom + 4, item }); }}><Download size={13} />Install<ChevronDown size={11} /></button>}
  </span>;
  return <div className="lib-table" ref={table} role="table" aria-label="Library items" aria-rowcount={visible.length}>
    <TableHead collectionShown={collectionShown} sort={sort} onSort={onSort} />
    <div className="item-list" ref={scroll.ref} onScroll={scroll.onScroll} onKeyDown={keyDown}>
      {groups.map(g => { const shut = group !== 'none' && folded.includes(g.key); return <Fragment key={g.key || 'all'}>
        {group !== 'none' && <button type="button" className="lib-group" aria-expanded={!shut} onClick={() => setFolded(current => shut ? current.filter(k => k !== g.key) : [...current, g.key])}>
          {shut ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span className="ellipsis">{g.label}</span><span className="lib-group-count">{g.items.length}</span>
          {shut && <span className="faint ellipsis lib-group-hint">{g.items.slice(0, 3).map(i => i.title).join(', ')}{g.items.length > 3 ? '…' : ''}</span>}
        </button>}
        {!shut && g.items.map(item => { const { published, trial, from, made } = row(item), isPicked = many && picked.includes(item.id);
          const subtitle = [from ? `from ${from.label}` : '', item.description || (item.kind === 'link' ? site(item) : item.tags.slice(0, 3).map(t => `#${t}`).join('  '))].filter(Boolean).join(' · ');
          return <SwipeToArchive key={item.id} enabled={!many && canSwipe(item)} label="Archive" onArchive={() => onArchive(item)}>
            <div role="row" data-id={item.id} tabIndex={item.id === focusable ? 0 : -1} aria-selected={item.id === selected || isPicked} className={`item-card lib-row ${collectionShown ? 'no-collection' : ''} ${selected === item.id ? 'selected' : ''} ${isPicked ? 'picked' : ''} ${install?.item.id === item.id ? 'menu-open' : ''}`}
              onClick={event => onClick(event, item)} onContextMenu={event => onMenu(event, item)}>
              <span className={`item-kind ${item.kind}`} role="cell" title={item.kind}><KindIcon kind={item.kind} size={14} /></span>
              <span className="lib-title" role="cell"><span className="item-title">{item.title}</span>{item.favourite && <Star size={12} className="lib-star" fill="currentColor" aria-label="Favourite" />}<span className="lib-sub" title={from ? `From ${from.full}` : subtitle || undefined}>{subtitle}</span></span>
              {!collectionShown && <span className="lib-cell col-collection muted" role="cell" title={item.collection}>{item.collection.replaceAll('/', ' / ') || <span className="faint">—</span>}</span>}
              <span className="lib-cell col-status" role="cell"><StatusCell item={item} approvals={approvals} published={published} made={made} /></span>
              <span className="lib-cell col-installed" role="cell"><InstalledCell item={item} locations={locations} installations={installations} /></span>
              <span className="lib-cell col-test" role="cell"><TestCell item={item} trial={trial} /></span>
              <span className="lib-cell col-updatedAt muted" role="cell" title={`Updated ${date(item.updatedAt)} · added ${date(item.createdAt)}`}>{date(item.updatedAt)}</span>
              {actions(item)}
            </div>
          </SwipeToArchive>; })}
      </Fragment>; })}
      {!visible.length && !groups.some(g => g.items.length) && empty}
      {visible.length > 0 && <p className="muted small lib-hint">{hint}</p>}
    </div>
    {install && <ContextMenu x={install.x} y={install.y} entries={installEntries(install.item)} onClose={() => setInstall(null)} />}
  </div>;
}

/**
 * Shown instead of the saved-view row when two or more rows are picked: the bulk actions of the right-click menu as buttons,
 * with Status as a menu. Everything runs over the picked items, then the selection clears.
 */
export function BulkBar({ items, entries, busy, onClear }: { items: Item[]; entries: MenuEntry[]; busy: boolean; onClear: () => void }) {
  const [status, setStatus] = useState<{ x: number; y: number } | null>(null);
  const labelled = entries.filter((e): e is Extract<MenuEntry, { label: string }> => typeof e === 'object' && 'label' in e);
  const start = entries.findIndex(e => typeof e === 'object' && 'heading' in e && e.heading === 'Status');
  const statuses = start < 0 ? [] : entries.slice(start + 1, entries.indexOf('separator', start + 1) < 0 ? undefined : entries.indexOf('separator', start + 1));
  const button = (label: string) => { const entry = labelled.find(e => e.label === label || e.label.startsWith(label)); return entry && <button key={entry.label} type="button" className={`bulk-button ${entry.danger ? 'danger' : ''}`} disabled={busy || entry.disabled} title={entry.hint} onClick={entry.onSelect}>{entry.icon}{entry.label}</button>; };
  const kinds = Object.entries(items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {})).map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`).join(' · ');
  return <div className="bulk-bar" role="toolbar" aria-label={`${items.length} items selected`}>
    <span className="bulk-count"><b>{items.length} selected</b><small className="muted">{kinds}</small></span>
    <span className="bulk-sep" />
    {button('Move to collection')}
    {statuses.length > 0 && <button type="button" className="bulk-button" aria-haspopup="menu" disabled={busy} onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setStatus({ x: box.left, y: box.bottom + 4 }); }}><Tags size={14} />Status<ChevronDown size={12} /></button>}
    {button('Add to favourites') ?? button('Remove from favourites')}
    {button('Remove local copies')}
    {button('Restore from trash')}
    {button('Move to trash') ?? button('Delete permanently')}
    <span className="bulk-grow" />
    <small className="muted bulk-hint">Ctrl-click adds or removes · Shift-click picks a range</small>
    <button type="button" className="icon-button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}><X size={14} /></button>
    {status && <ContextMenu x={status.x} y={status.y} entries={statuses} onClose={() => setStatus(null)} />}
  </div>;
}
