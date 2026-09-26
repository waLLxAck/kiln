/** How the library list is ordered: the sort choices, the default, and sources leading inside a collection. Kept free of React so it can be tested. */
import type { Item, Usage } from '../../../packages/protocol/schema';

export type SortKey = 'title' | 'kind' | 'collection' | 'status' | 'updatedAt' | 'createdAt' | 'site' | 'copied' | 'used' | 'order';
export type Sort = { key: SortKey; dir: 'asc' | 'desc' } | null;
/** What the list shows until someone picks another order: newest captures first, everywhere. */
export const defaultSort = { key: 'createdAt', dir: 'desc' } as const satisfies Sort;
/** Clicking a heading sorts by it; clicking again flips the direction. Dates start newest first, text starts A to Z. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'updatedAt' || key === 'createdAt' ? 'desc' : 'asc' };
}
/** The orders offered in the sort menu. Custom order is the hand-arranged `order` field, the only one the move arrows change. */
export const sortChoices: { label: string; sort: NonNullable<Sort>; hint?: string }[] = [
  { label: 'Recently added', sort: defaultSort }, { label: 'Recently updated', sort: { key: 'updatedAt', dir: 'desc' } },
  { label: 'Most copied', sort: { key: 'copied', dir: 'desc' }, hint: 'Times copied from Kiln' },
  { label: 'Most used', sort: { key: 'used', dir: 'desc' }, hint: 'Copies, opens, tests and agent use Kiln has seen' },
  { label: 'Title A–Z', sort: { key: 'title', dir: 'asc' } }, { label: 'Custom order', sort: { key: 'order', dir: 'asc' }, hint: 'Arranged by hand with the move arrows' },
];
const headingLabel: Partial<Record<SortKey, string>> = { kind: 'Type', collection: 'Collection', status: 'State', site: 'Site', title: 'Title Z–A', createdAt: 'Oldest added', updatedAt: 'Least recently updated', copied: 'Least copied', used: 'Least used' };
/** A heading click can pick an order the menu does not list; the pill still names it. */
export const sortLabel = (sort: NonNullable<Sort>) => sortChoices.find(c => c.sort.key === sort.key && c.sort.dir === sort.dir)?.label ?? `${headingLabel[sort.key] ?? 'Custom order'}${['kind', 'collection', 'status', 'site'].includes(sort.key) && sort.dir === 'desc' ? ' (reversed)' : ''}`;
export const site = (item: Item) => { try { return new URL(item.source).hostname.replace(/^www\./, ''); } catch { return item.source || '—'; } };
const statusRank: Record<string, number> = { approved: 0, testing: 1, captured: 2, rejected: 3, archived: 4 };
/** `usage` holds copy and use counts per item id; counts tie often, so ties fall back to newest added. A null sort is the default. */
export function sortItems(items: Item[], sort: Sort, usage: Usage = {}): Item[] {
  const { key, dir } = sort ?? defaultSort;
  if (key === 'copied' || key === 'used') return [...items].sort((a, b) => ((usage[b.id]?.[key] ?? 0) - (usage[a.id]?.[key] ?? 0)) * (dir === 'asc' ? -1 : 1) || b.createdAt.localeCompare(a.createdAt));
  if (key === 'order') return [...items].sort((a, b) => a.order - b.order || b.updatedAt.localeCompare(a.updatedAt));
  const value = (i: Item): string | number => key === 'site' ? site(i).toLowerCase() : key === 'status' ? statusRank[i.status] ?? 9 : String(i[key]).toLowerCase();
  const direction = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : a.title.localeCompare(b.title)) * direction; });
}
/**
 * The list as shown. Inside a collection its sources are the material everything else was made from, so they lead, sorted
 * among themselves; across the whole library they mix in with the rest.
 */
export function arrangeItems(items: Item[], sort: Sort, usage: Usage = {}, pinSources = false): Item[] {
  const sorted = sortItems(items, sort, usage);
  return pinSources ? [...sorted.filter(i => i.kind === 'source'), ...sorted.filter(i => i.kind !== 'source')] : sorted;
}
/**
 * The ids in their new custom order after moving one item a step, or null when it cannot move that way. With sources pinned,
 * a move never crosses between sources and the rest: the list would show it back in place.
 */
export function moveInOrder(shown: Item[], id: string, direction: number, pinSources = false): string[] | null {
  const at = shown.findIndex(i => i.id === id), to = at + direction;
  if (at < 0 || to < 0 || to >= shown.length || (pinSources && (shown[at].kind === 'source') !== (shown[to].kind === 'source'))) return null;
  const ids = shown.map(i => i.id); [ids[at], ids[to]] = [ids[to], ids[at]]; return ids;
}
