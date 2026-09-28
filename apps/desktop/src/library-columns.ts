import type { SortKey } from './library-sort';

/** The library table's columns. The kind icon belongs to Title; Collection gives way when a collection is chosen in the rail. */
export type ColumnKey = 'collection' | 'title' | 'status' | 'installed' | 'model' | 'test' | 'updatedAt';
/**
 * `width` is the default width in px; `min` and `max` bound what a resize can set. Title has no width of its own: it takes the
 * space the other columns leave, never less than its `min`.
 */
export type Column = { key: ColumnKey; label: string; sortable: boolean; width: number; min: number; max: number };
export const COLUMNS: Record<ColumnKey, Column> = {
  collection: { key: 'collection', label: 'Collection', sortable: true, width: 200, min: 80, max: 480 },
  title: { key: 'title', label: 'Title', sortable: true, width: 0, min: 180, max: 0 },
  status: { key: 'status', label: 'Status', sortable: true, width: 150, min: 100, max: 360 },
  installed: { key: 'installed', label: 'Installed', sortable: false, width: 150, min: 90, max: 360 },
  /** Whether a model may invoke the skill on its own, with its switch (Invocation.tsx). Shown only while a skill is listed. */
  model: { key: 'model', label: 'Invoked by', sortable: false, width: 124, min: 96, max: 240 },
  test: { key: 'test', label: 'Last test', sortable: false, width: 130, min: 90, max: 400 },
  updatedAt: { key: 'updatedAt', label: 'Updated', sortable: true, width: 110, min: 80, max: 200 },
};
/**
 * Collection first: it is what people look at before the title. Invoked by comes before Installed so a row's hover actions,
 * which cover the right end of the row, never hide its switch.
 */
export const DEFAULT_ORDER: ColumnKey[] = ['collection', 'title', 'status', 'model', 'installed', 'test', 'updatedAt'];
export const sortKeyOf = (key: ColumnKey) => key as SortKey;

/** A stored order made whole: unknown keys and repeats dropped, columns it does not name added where the default has them. */
export function normalizeOrder(stored: unknown): ColumnKey[] {
  const known = Array.isArray(stored) ? [...new Set(stored.filter((k): k is ColumnKey => typeof k === 'string' && k in COLUMNS))] : [];
  for (const key of DEFAULT_ORDER) if (!known.includes(key)) known.splice(Math.min(DEFAULT_ORDER.indexOf(key), known.length), 0, key);
  return known;
}
export const isDefaultOrder = (order: ColumnKey[]) => order.join() === DEFAULT_ORDER.join();
/** Every column but Title can be hidden from the header menu. */
export const hideable = (key: ColumnKey) => key !== 'title';
/**
 * The columns on screen, in order: hidden ones are left out, and Collection while a collection is chosen; both keep their
 * place for when they come back.
 */
export const visibleColumns = (order: ColumnKey[], collectionShown: boolean, hidden: readonly ColumnKey[] = []) => order.filter(k => !(collectionShown && k === 'collection') && !hidden.includes(k));

/**
 * Puts `key` before the visible column now at `index` (`index` = visible length puts it last). Hidden columns keep their place
 * relative to the column after them, so the order still reads naturally when Collection comes back.
 */
export function moveColumn(order: ColumnKey[], key: ColumnKey, index: number, collectionShown: boolean, hidden: readonly ColumnKey[] = []): ColumnKey[] {
  const shown = visibleColumns(order, collectionShown, hidden);
  const from = shown.indexOf(key); if (from < 0) return order;
  const target = Math.max(0, Math.min(index, shown.length));
  if (target === from || target === from + 1) return order;
  const before = shown.filter(k => k !== key)[target > from ? target - 1 : target];
  const rest = order.filter(k => k !== key);
  const at = before === undefined ? rest.length : rest.indexOf(before);
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}
/** One step left (-1) or right (+1) among the visible columns. */
export const stepColumn = (order: ColumnKey[], key: ColumnKey, direction: -1 | 1, collectionShown: boolean, hidden: readonly ColumnKey[] = []) => {
  const from = visibleColumns(order, collectionShown, hidden).indexOf(key);
  return from < 0 ? order : moveColumn(order, key, direction < 0 ? from - 1 : from + 2, collectionShown, hidden);
};

/** Widths the user set by dragging a column edge, in px. Columns not named have their default width; Title never has one. */
export type Widths = Partial<Record<ColumnKey, number>>;
export const resizable = (key: ColumnKey) => key !== 'title';
export const clampWidth = (key: ColumnKey, width: number) => Math.round(Math.max(COLUMNS[key].min, Math.min(COLUMNS[key].max, width)));
export const widthOf = (widths: Widths, key: ColumnKey) => widths[key] ?? COLUMNS[key].width;
/** A new width for one column, clamped. The default width drops the entry, so a later change of default reaches it. */
export function setWidth(widths: Widths, key: ColumnKey, width: number): Widths {
  if (!resizable(key)) return widths;
  const rest = resetWidth(widths, key), next = clampWidth(key, width);
  return next === COLUMNS[key].width ? rest : { ...rest, [key]: next };
}
export const resetWidth = (widths: Widths, key: ColumnKey): Widths => Object.fromEntries(Object.entries(widths).filter(([k]) => k !== key));
/** Stored widths made safe: unknown keys, Title and non-numbers dropped, the rest clamped to the column's bounds. */
export function normalizeWidths(stored: unknown): Widths {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  return Object.entries(stored).reduce<Widths>((widths, [key, value]) =>
    key in COLUMNS && typeof value === 'number' && Number.isFinite(value) ? setWidth(widths, key as ColumnKey, value) : widths, {});
}

/** What the table keeps per machine: the column order, any widths set by hand, and the columns hidden from the header menu. */
export type Layout = { order: ColumnKey[]; widths: Widths; /** Absent when every column shows. */ hidden?: ColumnKey[] };
/** Hidden columns made safe: known, hideable, each once, in the default order. */
export const normalizeHidden = (stored: unknown): ColumnKey[] => Array.isArray(stored) ? DEFAULT_ORDER.filter(k => hideable(k) && stored.includes(k)) : [];
/** The layout with `key` hidden or shown again. */
export function setHidden(layout: Layout, key: ColumnKey, hide: boolean): Layout {
  const hidden = normalizeHidden(hide ? [...(layout.hidden ?? []), key] : (layout.hidden ?? []).filter(k => k !== key));
  const { hidden: _old, ...rest } = layout;
  return hidden.length ? { ...rest, hidden } : rest;
}
/** The stored layout in either format: 0.23.0 stored only the order, as an array; now it is `{ order, widths }`. */
export function parseLayout(stored: unknown): Layout {
  if (Array.isArray(stored)) return { order: normalizeOrder(stored), widths: {} };
  const record = stored && typeof stored === 'object' ? stored as { order?: unknown; widths?: unknown; hidden?: unknown } : {};
  const hidden = normalizeHidden(record.hidden);
  return { order: normalizeOrder(record.order), widths: normalizeWidths(record.widths), ...(hidden.length ? { hidden } : {}) };
}
export const isDefaultLayout = (layout: Layout) => isDefaultOrder(layout.order) && !Object.keys(layout.widths).length && !layout.hidden?.length;
/**
 * What to store: nothing for the default layout (so defaults can change later), the bare order while no width is set (the
 * format 0.23.0 reads, so going back a version keeps the order), otherwise both.
 */
export function storedLayout(layout: Layout): ColumnKey[] | Layout | null {
  if (isDefaultLayout(layout)) return null;
  if (layout.hidden?.length) return { order: layout.order, widths: layout.widths, hidden: layout.hidden };
  return Object.keys(layout.widths).length ? { order: layout.order, widths: layout.widths } : layout.order;
}

/**
 * Which edge of `key`'s heading resizes it. Title takes the space left over, so every other column is resized from its edge
 * away from Title: that edge then follows the pointer and Title gives or takes the difference. Title has no handle of its own;
 * dragging either of its edges resizes the neighbour there.
 */
export function resizeEdge(shown: ColumnKey[], key: ColumnKey): 'left' | 'right' | null {
  if (!resizable(key) || !shown.includes(key)) return null;
  return shown.indexOf(key) < shown.indexOf('title') ? 'right' : 'left';
}

/** Columns that give way as the window narrows (see library.css): Last test first, then Installed, Invoked by and Collection. */
const dropsAt = { mid: ['test'], narrow: ['test', 'installed', 'model', 'collection'] } as const;
/**
 * A column's grid track. It never grows past its width, and shrinks toward its minimum only when the window cannot fit every
 * width with Title at its minimum, so saved widths never make the table wider than the window.
 */
const track = (key: ColumnKey, widths: Widths) => resizable(key) ? `minmax(${COLUMNS[key].min}px, ${widthOf(widths, key)}px)` : `minmax(${COLUMNS[key].min}px, 1fr)`;
/** The grid tracks for each window width: the header and every row share them, so they line up whatever the order. */
export function gridTracks(shown: ColumnKey[], widths: Widths = {}) {
  const tracks = (drop: readonly string[]) => shown.filter(k => !drop.includes(k)).map(k => track(k, widths)).join(' ');
  return { full: tracks([]), mid: tracks(dropsAt.mid), narrow: tracks(dropsAt.narrow) };
}
/** Each shown column's 1-based grid column at each window width (0 where it is hidden), to place its resize handle. */
export function gridColumns(shown: ColumnKey[]) {
  const at = (drop: readonly string[], key: ColumnKey) => drop.includes(key) ? 0 : shown.filter(k => !drop.includes(k)).indexOf(key) + 1;
  return Object.fromEntries(shown.map(key => [key, { full: at([], key), mid: at(dropsAt.mid, key), narrow: at(dropsAt.narrow, key) }])) as Record<ColumnKey, { full: number; mid: number; narrow: number }>;
}
