import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, EyeOff, MoveHorizontal, RotateCcw } from 'lucide-react';
import { ContextMenu, menuPoint, type MenuEntry } from './components';
import { COLUMNS, DEFAULT_ORDER, gridColumns, gridTracks, hideable, isDefaultLayout, moveColumn, parseLayout, resetWidth, resizeEdge, setHidden, setWidth, sortKeyOf, stepColumn, storedLayout, widthOf, type ColumnKey, type Layout } from './library-columns';
import type { Sort, SortKey } from './library-sort';

const storageKey = 'kiln-library-columns';
/** The column order and widths, kept per machine like the other view preferences (library-columns.ts has the stored format). */
export function useColumnLayout() {
  const [layout, setLayout] = useState<Layout>(() => { try { return parseLayout(JSON.parse(localStorage.getItem(storageKey) ?? 'null')); } catch { return parseLayout(null); } });
  const update = (next: Layout) => { setLayout(next); const stored = storedLayout(next); if (stored) localStorage.setItem(storageKey, JSON.stringify(stored)); else localStorage.removeItem(storageKey); };
  return [layout, update] as const;
}

/** How far (px) the pointer travels on a header before a press becomes a drag rather than a click that sorts. */
const dragStart = 5;
/** How far the arrow keys move a column edge. */
const keyStep = 16;
type Drag = { key: ColumnKey; index: number; line: number; depth: number };
/** The custom properties the table's rows take their grid tracks from (library.css). */
const trackVars = ['--lib-cols', '--lib-cols-mid', '--lib-cols-narrow'] as const;

/**
 * The table's header. Clicking a sortable heading sorts by it; dragging a heading moves the column, with a line where it will
 * land. The edge of each heading away from Title resizes that column: drag it, use the arrow keys on it, or double-click it to
 * fit the column to its content. Right-click (or the menu key) offers Move left, Move right, Reset width and Hide column for the
 * column under it, the hidden columns to show again, and Reset columns. `sort` is null while a search orders the list by relevance: then no heading shows as sorted.
 */
export function LibraryHead({ layout, shown, collectionShown, sort, onSort, onLayout }: { layout: Layout; shown: ColumnKey[]; collectionShown: boolean; sort: Sort; onSort: (key: SortKey) => void; onLayout: (layout: Layout) => void }) {
  const { order, widths } = layout, hidden = layout.hidden ?? [];
  const head = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resizing, setResizing] = useState<ColumnKey | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; key?: ColumnKey } | null>(null);
  const press = useRef<{ key: ColumnKey; x: number; pointerId: number; dragging: boolean; detach: () => void } | null>(null);
  const resize = useRef<{ detach: () => void } | null>(null);
  // A drag ends with a click on the heading it started from; that click must not sort.
  const swallowClick = useRef(false);
  useEffect(() => () => { press.current?.detach(); resize.current?.detach(); }, []);
  const onOrder = (next: ColumnKey[]) => onLayout({ ...layout, order: next });
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
      onOrder(moveColumn(order, key, target(e.clientX).index, collectionShown, hidden));
    };
    const cancel = () => { press.current?.detach(); press.current = null; };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && press.current?.dragging) { e.stopPropagation(); cancel(); } };
    const detach = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', escape, true); document.body.classList.remove('col-dragging'); setDrag(null); };
    press.current = { key, x: event.clientX, pointerId: event.pointerId, dragging: false, detach };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', escape, true);
  };
  const click = (key: ColumnKey) => { if (swallowClick.current) { swallowClick.current = false; return; } onSort(sortKeyOf(key)); };

  // Resizing. Widths are read from the headings as drawn, which is what the user sees even when a narrow window squeezes them.
  const table = () => head.current?.closest<HTMLElement>('.lib-table') ?? null;
  const drawn = (key: ColumnKey) => head.current?.querySelector<HTMLElement>(`[data-col="${key}"]`)?.getBoundingClientRect().width || widthOf(widths, key);
  /** The widest `key` can be made now: Title gives up space down to its minimum and no further, so the table never overflows. */
  const widest = (key: ColumnKey) => Math.max(COLUMNS[key].min, Math.min(COLUMNS[key].max, drawn(key) + Math.max(0, drawn('title') - COLUMNS.title.min)));
  const bounded = (key: ColumnKey, width: number) => Math.round(Math.max(COLUMNS[key].min, Math.min(widest(key), width)));
  const resizeTo = (key: ColumnKey, width: number) => onLayout({ ...layout, widths: setWidth(widths, key, width) });
  /**
   * Dragging an edge. The rows take their tracks from custom properties on the table, so each frame sets those directly and
   * nothing re-renders until the pointer is let go; Esc puts the old widths back.
   */
  const resizeDown = (event: ReactPointerEvent<HTMLElement>, key: ColumnKey, edge: 'left' | 'right') => {
    if (event.button !== 0) return;
    // Keep the press from reaching anything that would start a reorder, a sort, an item drag or a text selection.
    event.preventDefault(); event.stopPropagation();
    const el = table(), handle = event.currentTarget; if (!el) return;
    resize.current?.detach();
    const start = event.clientX, from = drawn(key), most = widest(key), before = trackVars.map(name => el.style.getPropertyValue(name));
    let width = Math.round(from), moved = false, frame = 0;
    const paint = () => {
      frame = 0;
      const tracks = gridTracks(shown, setWidth(widths, key, width));
      [tracks.full, tracks.mid, tracks.narrow].forEach((value, i) => el.style.setProperty(trackVars[i], value));
      handle.setAttribute('aria-valuenow', String(width));
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      const dx = e.clientX - start;
      if (!moved && Math.abs(dx) < 2) return;
      if (!moved) { moved = true; setResizing(key); document.body.classList.add('col-resizing'); }
      width = Math.round(Math.max(COLUMNS[key].min, Math.min(most, from + (edge === 'right' ? dx : -dx))));
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const finish = (keep: boolean) => {
      detach(); resize.current = null;
      if (!moved) return;
      if (keep) resizeTo(key, width);
      else { trackVars.forEach((name, i) => el.style.setProperty(name, before[i])); handle.setAttribute('aria-valuenow', String(widthOf(widths, key))); }
    };
    const up = (e: PointerEvent) => { if (e.pointerId === event.pointerId) finish(true); };
    const cancel = () => finish(false);
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(false); } };
    const detach = () => { cancelAnimationFrame(frame); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', escape, true); document.body.classList.remove('col-resizing'); setResizing(null); };
    resize.current = { detach };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', escape, true);
  };
  /** The width that shows `key`'s heading and its content in every row drawn, found by letting those cells size to their content for one layout. */
  const fit = (key: ColumnKey) => {
    const el = table(); if (!el) return;
    const measured = [...el.querySelectorAll<HTMLElement>(`.lib-row > .lib-cell.col-${key}`)];
    measured.forEach(cell => cell.classList.add('col-measure'));
    const content = Math.max(0, ...measured.map(cell => cell.getBoundingClientRect().width));
    measured.forEach(cell => cell.classList.remove('col-measure'));
    if (content) resizeTo(key, bounded(key, Math.ceil(content) + 1));
  };
  const edgeKey = (event: ReactKeyboardEvent<HTMLElement>, key: ColumnKey, edge: 'left' | 'right') => {
    // The arrows move the edge itself, so on an edge left of its column Right makes the column narrower.
    const step = event.key === 'ArrowRight' ? keyStep : event.key === 'ArrowLeft' ? -keyStep : 0;
    const width = step ? drawn(key) + (edge === 'right' ? step : -step) : event.key === 'Home' ? COLUMNS[key].min : event.key === 'End' ? widest(key) : null;
    if (width === null) return;
    event.preventDefault(); event.stopPropagation();
    resizeTo(key, bounded(key, width));
  };

  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    const cell = (event.target as Element).closest<HTMLElement>('[data-col], [data-resize]'), key = (cell?.dataset.col ?? cell?.dataset.resize) as ColumnKey | undefined;
    // The menu key and Shift+F10 fire at the focused heading with no pointer position; open under the heading then.
    setMenu({ ...menuPoint({ clientX: event.clientX, clientY: event.clientY, currentTarget: cell ?? null }), key });
  };
  const entries = (key?: ColumnKey): MenuEntry[] => {
    const index = key ? shown.indexOf(key) : -1;
    const step = (direction: -1 | 1) => () => { if (key) { onOrder(stepColumn(order, key, direction, collectionShown, hidden)); focusColumn(key); } };
    return [
      ...(key ? [{ heading: COLUMNS[key].label }, { label: 'Move left', icon: <ArrowLeft size={14} />, disabled: index <= 0, onSelect: step(-1) }, { label: 'Move right', icon: <ArrowRight size={14} />, disabled: index < 0 || index >= shown.length - 1, onSelect: step(1) }] : []),
      ...(key && key !== 'title' ? [{ label: 'Reset width', icon: <MoveHorizontal size={14} />, disabled: widths[key] === undefined, hint: `${COLUMNS[key].width}px`, onSelect: () => onLayout({ ...layout, widths: resetWidth(widths, key) }) }] : []),
      ...(key && hideable(key) ? [{ label: 'Hide column', icon: <EyeOff size={14} />, hint: 'Show it again from this menu', onSelect: () => onLayout(setHidden(layout, key, true)) }] : []),
      ...(key ? ['separator' as const] : []),
      ...(hidden.length ? [{ heading: 'Hidden columns' }, ...hidden.map(k => ({ label: `Show ${COLUMNS[k].label}`, onSelect: () => onLayout(setHidden(layout, k, false)) })), 'separator' as const] : []),
      { label: 'Reset columns', icon: <RotateCcw size={14} />, disabled: isDefaultLayout(layout), hint: `${DEFAULT_ORDER.map(k => COLUMNS[k].label).join(', ')}, at their default widths`, onSelect: () => { onLayout({ order: [...DEFAULT_ORDER], widths: {} }); if (key) focusColumn(key); } },
    ];
  };
  const at = gridColumns(shown);
  /** The resize handle for `key`, in the gap on the side away from Title; it takes that column's place in the grid at each window width. */
  const resizer = (key: ColumnKey) => {
    const edge = resizeEdge(shown, key), c = COLUMNS[key]; if (!edge) return null;
    const place = { '--at': at[key].full, '--at-mid': at[key].mid || 'auto', '--at-narrow': at[key].narrow || 'auto' } as CSSProperties;
    return <span key={`resize-${key}`} data-resize={key} className={`col-edge ${edge} col-${key} ${resizing === key ? 'active' : ''}`} style={place}
      role="separator" aria-orientation="vertical" aria-label={`Resize ${c.label} column`} aria-valuenow={Math.round(widthOf(widths, key))} aria-valuemin={c.min} aria-valuemax={c.max} tabIndex={0}
      title="Drag to resize · double-click to fit the content" onPointerDown={event => resizeDown(event, key, edge)} onDoubleClick={() => fit(key)} onClick={event => event.stopPropagation()} onKeyDown={event => edgeKey(event, key, edge)} />;
  };
  return <><div ref={head} className={`lib-row head ${drag ? 'dragging' : ''}`} role="row" onContextMenu={openMenu}>
    {shown.flatMap(key => {
      const c = COLUMNS[key], dir = c.sortable && sort?.key === key ? sort.dir : null, sorted = dir !== null;
      const common = { 'data-col': key, role: 'columnheader', className: `lib-cell col-${key} ${sorted ? 'sorted' : ''} ${drag?.key === key ? 'moving' : ''}`, onPointerDown: (event: ReactPointerEvent<HTMLElement>) => pointerDown(event, key) };
      const heading = c.sortable
        ? <button key={key} {...common} type="button" onClick={() => click(key)} title={`Sort by ${c.label.toLowerCase()} · drag to move the column`} aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>{c.label}{dir && (dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}</button>
        : <span key={key} {...common} tabIndex={0} title="Drag to move the column">{c.label}</span>;
      // Handles sit out of the grid flow; keeping each beside its heading makes Tab walk the header from left to right.
      return resizeEdge(shown, key) === 'left' ? [resizer(key), heading] : [heading, resizer(key)];
    })}
    {drag && <i className="col-drop" style={{ left: drag.line, height: drag.depth }} aria-hidden="true" />}
  </div>
  {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries(menu.key)} onClose={() => setMenu(null)} />}</>;
}
