import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { ContextMenu, type MenuEntry } from './components';
import { COLUMNS, DEFAULT_ORDER, isDefaultOrder, moveColumn, normalizeOrder, sortKeyOf, stepColumn, type ColumnKey } from './library-columns';
import type { Sort, SortKey } from './library-sort';

const storageKey = 'kiln-library-columns';
/** The column order, kept per machine like the other view preferences. The default order is not stored, so it can change later. */
export function useColumnOrder() {
  const [order, setOrder] = useState<ColumnKey[]>(() => { try { return normalizeOrder(JSON.parse(localStorage.getItem(storageKey) ?? 'null')); } catch { return [...DEFAULT_ORDER]; } });
  const update = (next: ColumnKey[]) => { setOrder(next); if (isDefaultOrder(next)) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, JSON.stringify(next)); };
  return [order, update] as const;
}

/** How far (px) the pointer travels on a header before a press becomes a drag rather than a click that sorts. */
const dragStart = 5;
type Drag = { key: ColumnKey; index: number; line: number; depth: number };

/**
 * The table's header. Clicking a sortable heading sorts by it; dragging a heading moves the column, with a line where it will
 * land. Right-click (or the menu key) offers Move left, Move right and Reset columns for the column under it.
 */
export function LibraryHead({ order, shown, collectionShown, sort, onSort, onOrder }: { order: ColumnKey[]; shown: ColumnKey[]; collectionShown: boolean; sort: NonNullable<Sort>; onSort: (key: SortKey) => void; onOrder: (order: ColumnKey[]) => void }) {
  const head = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key?: ColumnKey } | null>(null);
  const press = useRef<{ key: ColumnKey; x: number; pointerId: number; dragging: boolean; detach: () => void } | null>(null);
  // A drag ends with a click on the heading it started from; that click must not sort.
  const swallowClick = useRef(false);
  useEffect(() => () => press.current?.detach(), []);
  const cells = () => [...head.current?.querySelectorAll<HTMLElement>('[data-col]') ?? []].filter(cell => cell.offsetWidth > 0);
  const focusColumn = (key: ColumnKey) => requestAnimationFrame(() => head.current?.querySelector<HTMLElement>(`[data-col="${key}"]`)?.focus());
  /** Where a drag at `x` would drop: the index among the visible columns and the x of the line to draw. */
  const target = (x: number) => {
    const boxes = cells().map(cell => ({ key: cell.dataset.col as ColumnKey, box: cell.getBoundingClientRect() })), own = head.current!.getBoundingClientRect();
    // The line runs down through the rows to the bottom of the table, so it is clear which gap it marks.
    const depth = (head.current!.parentElement?.getBoundingClientRect().bottom ?? own.bottom) - own.top - 8;
    const index = boxes.filter(b => b.box.left + b.box.width / 2 < x).length;
    const edge = index < boxes.length ? boxes[index].box.left - 6 : boxes.at(-1)!.box.right + 6;
    // Visible cells may skip columns hidden at this width; map back to the index among `shown`.
    const shownIndex = index < boxes.length ? shown.indexOf(boxes[index].key) : shown.length;
    return { index: shownIndex, line: edge - own.left, depth };
  };
  const pointerDown = (event: ReactPointerEvent<HTMLElement>, key: ColumnKey) => {
    if (event.button !== 0) return;
    press.current?.detach();
    const move = (e: PointerEvent) => {
      const p = press.current; if (!p || e.pointerId !== p.pointerId) return;
      if (!p.dragging && Math.abs(e.clientX - p.x) < dragStart) return;
      p.dragging = true; document.body.classList.add('col-dragging');
      setDrag({ key, ...target(e.clientX) });
    };
    const up = (e: PointerEvent) => {
      const p = press.current; if (!p || e.pointerId !== p.pointerId) return;
      p.detach(); press.current = null;
      if (!p.dragging) return;
      swallowClick.current = true; setTimeout(() => { swallowClick.current = false; }, 0);
      onOrder(moveColumn(order, key, target(e.clientX).index, collectionShown));
    };
    const cancel = () => { press.current?.detach(); press.current = null; };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && press.current?.dragging) { e.stopPropagation(); cancel(); } };
    const detach = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', escape, true); document.body.classList.remove('col-dragging'); setDrag(null); };
    press.current = { key, x: event.clientX, pointerId: event.pointerId, dragging: false, detach };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', escape, true);
  };
  const click = (key: ColumnKey) => { if (swallowClick.current) { swallowClick.current = false; return; } onSort(sortKeyOf(key)); };
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    const cell = (event.target as Element).closest<HTMLElement>('[data-col]'), key = cell?.dataset.col as ColumnKey | undefined;
    // The menu key and Shift+F10 fire at the focused heading with no pointer position; open under the heading then.
    const box = cell?.getBoundingClientRect();
    setMenu(event.clientX || event.clientY || !box ? { x: event.clientX, y: event.clientY, key } : { x: box.left, y: box.bottom + 4, key });
  };
  const entries = (key?: ColumnKey): MenuEntry[] => {
    const index = key ? shown.indexOf(key) : -1;
    const step = (direction: -1 | 1) => () => { if (key) { onOrder(stepColumn(order, key, direction, collectionShown)); focusColumn(key); } };
    return [
      ...(key ? [{ heading: COLUMNS[key].label }, { label: 'Move left', icon: <ArrowLeft size={14} />, disabled: index <= 0, onSelect: step(-1) }, { label: 'Move right', icon: <ArrowRight size={14} />, disabled: index < 0 || index >= shown.length - 1, onSelect: step(1) }, 'separator' as const] : []),
      { label: 'Reset columns', icon: <RotateCcw size={14} />, disabled: isDefaultOrder(order), hint: 'Collection, Title, Status, Installed, Last test, Updated', onSelect: () => { onOrder([...DEFAULT_ORDER]); if (key) focusColumn(key); } },
    ];
  };
  return <><div ref={head} className={`lib-row head ${drag ? 'dragging' : ''}`} role="row" onContextMenu={openMenu}>
    {shown.map(key => {
      const c = COLUMNS[key], sorted = c.sortable && sort.key === key;
      const common = { 'data-col': key, role: 'columnheader', className: `lib-cell col-${key} ${sorted ? 'sorted' : ''} ${drag?.key === key ? 'moving' : ''}`, onPointerDown: (event: ReactPointerEvent<HTMLElement>) => pointerDown(event, key) };
      return c.sortable
        ? <button key={key} {...common} type="button" onClick={() => click(key)} title={`Sort by ${c.label.toLowerCase()} · drag to move the column`} aria-sort={sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>{c.label}{sorted && (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}</button>
        : <span key={key} {...common} tabIndex={0} title="Drag to move the column">{c.label}</span>;
    })}
    {drag && <i className="col-drop" style={{ left: drag.line, height: drag.depth }} aria-hidden="true" />}
  </div>
  {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries(menu.key)} onClose={() => setMenu(null)} />}</>;
}
