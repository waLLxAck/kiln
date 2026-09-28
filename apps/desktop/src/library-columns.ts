import type { SortKey } from './library-sort';

/** The library table's columns. The kind icon belongs to Title; Collection gives way when a collection is chosen in the rail. */
export type ColumnKey = 'collection' | 'title' | 'status' | 'installed' | 'test' | 'updatedAt';
export type Column = { key: ColumnKey; label: string; sortable: boolean; /** Grid track. Title takes the flexible space. */ width: string };
export const COLUMNS: Record<ColumnKey, Column> = {
  collection: { key: 'collection', label: 'Collection', sortable: true, width: 'minmax(100px, 200px)' },
  title: { key: 'title', label: 'Title', sortable: true, width: 'minmax(180px, 1fr)' },
  status: { key: 'status', label: 'Status', sortable: true, width: '150px' },
  installed: { key: 'installed', label: 'Installed', sortable: false, width: '150px' },
  test: { key: 'test', label: 'Last test', sortable: false, width: '130px' },
  updatedAt: { key: 'updatedAt', label: 'Updated', sortable: true, width: '110px' },
};
/** Collection first: it is what people look at before the title. */
export const DEFAULT_ORDER: ColumnKey[] = ['collection', 'title', 'status', 'installed', 'test', 'updatedAt'];
export const sortKeyOf = (key: ColumnKey) => key as SortKey;

/** A stored order made whole: unknown keys and repeats dropped, columns it does not name added where the default has them. */
export function normalizeOrder(stored: unknown): ColumnKey[] {
  const known = Array.isArray(stored) ? [...new Set(stored.filter((k): k is ColumnKey => typeof k === 'string' && k in COLUMNS))] : [];
  for (const key of DEFAULT_ORDER) if (!known.includes(key)) known.splice(Math.min(DEFAULT_ORDER.indexOf(key), known.length), 0, key);
  return known;
}
export const isDefaultOrder = (order: ColumnKey[]) => order.join() === DEFAULT_ORDER.join();
/** The columns on screen, in order: Collection is left out while a collection is chosen, keeping its place for later. */
export const visibleColumns = (order: ColumnKey[], collectionShown: boolean) => order.filter(k => !(collectionShown && k === 'collection'));

/**
 * Puts `key` before the visible column now at `index` (`index` = visible length puts it last). Hidden columns keep their place
 * relative to the column after them, so the order still reads naturally when Collection comes back.
 */
export function moveColumn(order: ColumnKey[], key: ColumnKey, index: number, collectionShown: boolean): ColumnKey[] {
  const shown = visibleColumns(order, collectionShown);
  const from = shown.indexOf(key); if (from < 0) return order;
  const target = Math.max(0, Math.min(index, shown.length));
  if (target === from || target === from + 1) return order;
  const before = shown.filter(k => k !== key)[target > from ? target - 1 : target];
  const rest = order.filter(k => k !== key);
  const at = before === undefined ? rest.length : rest.indexOf(before);
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}
/** One step left (-1) or right (+1) among the visible columns. */
export const stepColumn = (order: ColumnKey[], key: ColumnKey, direction: -1 | 1, collectionShown: boolean) => {
  const from = visibleColumns(order, collectionShown).indexOf(key);
  return from < 0 ? order : moveColumn(order, key, direction < 0 ? from - 1 : from + 2, collectionShown);
};

/** Columns that give way as the window narrows (see library.css): Last test first, then Installed and Collection. */
const dropsAt = { mid: ['test'], narrow: ['test', 'installed', 'collection'] } as const;
/** The grid tracks for each width: the header and every row share them, so they line up whatever the order. */
export function gridTracks(shown: ColumnKey[]) {
  const tracks = (drop: readonly string[]) => shown.filter(k => !drop.includes(k)).map(k => COLUMNS[k].width).join(' ');
  return { full: tracks([]), mid: tracks(dropsAt.mid), narrow: tracks(dropsAt.narrow) };
}
