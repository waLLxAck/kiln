import type { Item } from '../../../packages/protocol/schema';

/*
 * Keyboard navigation and undo: the pure parts (list keys, type-ahead, the undo stack's rules, batching), kept free of the
 * bridge so unit tests can run them. The hooks and components that use them live in keyboard.ts (used by LibraryTable.tsx),
 * UndoStack.tsx, ItemDrag.tsx and ShortcutSheet.tsx.
 */

/** The ids from the anchor row to the target row, both included, in list order. Nothing when either is out of range. */
export function rangeIds(ids: string[], anchor: number, target: number) {
  if (anchor < 0 || target < 0 || anchor >= ids.length || target >= ids.length) return [];
  return ids.slice(Math.min(anchor, target), Math.max(anchor, target) + 1);
}
/** Rows PageUp/PageDown move: a screenful less one row, so the row that was at the edge stays in sight. At least one. */
export const pageStep = (viewport: number, rowHeight: number) => rowHeight > 0 ? Math.max(1, Math.floor(viewport / rowHeight) - 1) : 1;
/** Where a list key takes the focus from row `at` of `count`: arrows by one, Home/End to the ends, Page keys by `page`. Null for other keys. */
export function targetRow(key: string, at: number, count: number, page: number) {
  if (!count) return null;
  const clamp = (n: number) => Math.max(0, Math.min(count - 1, n));
  switch (key) {
    case 'ArrowDown': return clamp(at + 1);
    case 'ArrowUp': return clamp(at - 1);
    case 'Home': return 0;
    case 'End': return count - 1;
    case 'PageDown': return clamp(at + page);
    case 'PageUp': return clamp(at - page);
    default: return null;
  }
}

/** How long type-ahead keeps collecting letters after the last one. */
export const TYPE_AHEAD_MS = 1000;
/**
 * The row type-ahead jumps to: the first title starting with `typed` (case-insensitive), searching from the row after
 * `current` for one letter (so pressing it again moves on) and from `current` itself for more (so the row stays while it
 * still matches). Repeating one letter ("ppp") cycles through the titles starting with it. -1 when nothing matches.
 */
export function typeAheadMatch(titles: string[], current: number, typed: string) {
  const text = typed.toLowerCase(); if (!text || !titles.length) return -1;
  const find = (prefix: string, from: number) => { for (let n = 0; n < titles.length; n++) { const i = (from + n + titles.length) % titles.length; if (titles[i].trim().toLowerCase().startsWith(prefix)) return i; } return -1; };
  const start = Math.max(0, current);
  const found = find(text, text.length === 1 ? start + 1 : start);
  if (found >= 0 || text.length === 1 || [...text].some(c => c !== text[0])) return found;
  return find(text[0], start + 1);
}
/** Keys that can take part in type-ahead: letters, digits and (once typing has started) spaces. */
export const typeAheadKey = (key: string) => key.length === 1 && /[\p{L}\p{N} ]/u.test(key);

/** A library field an undoable action changes. Organising never makes a revision, so these are all metadata. */
export type UndoField = 'deleted' | 'status' | 'favourite' | 'collection';
export type UndoValue = boolean | string;
export type UndoChange = { id: string; field: UndoField; before: UndoValue; after: UndoValue };
export type UndoEntry = { id: number; label: string; changes: UndoChange[] };
export const UNDO_LIMIT = 20;
/** The field's current value on an item. */
export const fieldOf = (item: Item, field: UndoField): UndoValue => field === 'deleted' ? Boolean(item.deletedAt) : field === 'status' ? item.status : field === 'favourite' ? item.favourite : item.collection;
/** The stack with `entry` on top, keeping the newest `limit`. */
export const pushUndo = (stack: UndoEntry[], entry: UndoEntry, limit = UNDO_LIMIT) => [...stack, entry].slice(-limit);
/**
 * What undoing an entry may touch: only items still exactly as the action left them. An item since purged, or changed again
 * (restored by hand, moved elsewhere, favourited back), is skipped rather than overwritten.
 */
export function planUndo(entry: UndoEntry, items: Item[]) {
  const byId = new Map(items.map(i => [i.id, i]));
  const apply: (UndoChange & { expect: string })[] = [], skipped: string[] = [];
  for (const change of entry.changes) { const item = byId.get(change.id); if (item && fieldOf(item, change.field) === change.after) apply.push({ ...change, expect: item.revision }); else skipped.push(change.id); }
  return { apply, skipped };
}
/** What is left to undo of `entry` after an attempt: the changes neither put back (`done`) nor skipped as changed since, or null. */
export function unfinishedUndo(entry: UndoEntry, done: string[], skipped: string[]): UndoEntry | null {
  const changes = entry.changes.filter(c => !done.includes(c.id) && !skipped.includes(c.id));
  return changes.length ? { ...entry, changes } : null;
}
/** One backend request that sets a field on some items; `ids` counts toward progress. */
export type FieldRequest = { method: 'items.meta' | 'items.move'; args: Record<string, unknown>; ids: string[] };
/**
 * Requests that set each item's field to `to`: one `items.meta` per item for trash, status and favourite, and one
 * `items.move` per destination collection (it already takes many ids).
 */
export function fieldRequests(changes: { id: string; expect: string; field: UndoField; to: UndoValue }[]): FieldRequest[] {
  const requests: FieldRequest[] = [], moves = new Map<string, string[]>();
  for (const c of changes) {
    if (c.field === 'collection') { const to = String(c.to); moves.set(to, [...(moves.get(to) ?? []), c.id]); continue; }
    requests.push({ method: 'items.meta', args: { id: c.id, expect: c.expect, [c.field]: c.to }, ids: [c.id] });
  }
  for (const [collection, ids] of moves) requests.push({ method: 'items.move', args: { ids, collection }, ids });
  return requests;
}
/** How many requests are in flight at once: well under the backend's cap of 100 pending calls, leaving room for polling. */
export const BATCH_SIZE = 8;
/**
 * Runs tasks a few at a time, in order: each batch starts after the previous one settled, so the backend queue receives them
 * in list order and never holds more than `size` of them. One failure does not stop the rest; `onProgress` gets the running
 * count of finished units (a task's `weight`, one by default).
 */
export async function runBatched<T>(tasks: T[], run: (task: T) => Promise<unknown>, { size = BATCH_SIZE, weight = () => 1, onProgress }: { size?: number; weight?: (task: T) => number; onProgress?: (done: number) => void } = {}) {
  const failed: { task: T; error: unknown }[] = [], succeeded: T[] = []; let done = 0;
  for (let start = 0; start < tasks.length; start += size) {
    const batch = tasks.slice(start, start + size);
    const results = await Promise.allSettled(batch.map(task => run(task)));
    results.forEach((result, i) => { if (result.status === 'fulfilled') succeeded.push(batch[i]); else failed.push({ task: batch[i], error: result.reason }); done += weight(batch[i]); });
    onProgress?.(done);
  }
  return { succeeded, failed };
}

const quote = (items: { title: string }[]) => items.length === 1 ? `“${items[0].title}”` : `${items.length} items`;
const place = (collection: string) => collection ? `“${collection}”` : 'no collection';
/** The toast line for an undoable action, like "Moved 3 items to Trash". */
export function undoLabel(field: UndoField, to: UndoValue, items: { title: string }[]) {
  const what = quote(items);
  if (field === 'deleted') return to ? `Moved ${what} to Trash` : `Restored ${what}`;
  if (field === 'favourite') return to ? `Added ${what} to favourites` : `Removed ${what} from favourites`;
  if (field === 'status') return to === 'archived' ? `Archived ${what}` : `Moved ${what} to ${to}`;
  return `Moved ${what} to ${place(String(to))}`;
}
/** The progress line while a batch runs, like "Moving 120 of 300 to Trash…". */
export function progressLabel(field: UndoField, to: UndoValue, done: number, total: number, undoing = false) {
  const count = `${done} of ${total}`;
  if (undoing) return `Undoing ${count}…`;
  if (field === 'deleted') return to ? `Moving ${count} to Trash…` : `Restoring ${count}…`;
  if (field === 'collection') return `Moving ${count} to ${place(String(to))}…`;
  return `Updating ${count}…`;
}
/** What an undo says afterwards: what it put back and what it left alone because it had changed since. */
export function undoneLabel(entry: UndoEntry, applied: number, skipped: number) {
  const total = entry.changes.length;
  if (!applied) return `Nothing undone: ${total === 1 ? 'the item has' : `all ${total} items have`} changed since “${entry.label}”`;
  const rest = skipped ? `; ${skipped} ${skipped === 1 ? 'item had' : 'items had'} changed since and ${skipped === 1 ? 'was' : 'were'} left as ${skipped === 1 ? 'it is' : 'they are'}` : '';
  return `Undone: ${entry.label}${rest}`;
}
