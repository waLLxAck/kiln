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
/** Search results best match first (`ranked` is the order search returned them in); inside a collection its sources still lead. */
export function rankItems(items: Item[], ranked: string[], pinSources = false): Item[] {
  const at = new Map(ranked.map((id, i) => [id, i])), rank = (item: Item) => at.get(item.id) ?? ranked.length;
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));
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

/** Every kind, in the order kind groups and suggestions list them. */
export const KINDS: Item['kind'][] = ['source', 'prompt', 'skill', 'agent', 'insight', 'technique', 'tool', 'resource', 'link', 'instruction', 'image', 'file', 'reference'];
export const kindPlural: Record<Item['kind'], string> = { source: 'Sources', prompt: 'Prompts', skill: 'Skills', agent: 'Agents', insight: 'Insights', technique: 'Techniques', tool: 'Tools', resource: 'Resources', link: 'Links', instruction: 'Instructions', image: 'Images', file: 'Files', reference: 'References' };
export type GroupKey = 'none' | 'collection' | 'kind' | 'status';
const statusGroup: Record<Item['status'], string> = { captured: 'Drafts', testing: 'Testing', approved: 'Approved', rejected: 'Rejected', archived: 'Archived' };
/**
 * The shown list cut into groups, each keeping the list's order inside it. Collections sort by name with unfiled items last;
 * kinds and statuses follow their usual order. `none` is one unlabelled group.
 */
export function groupItems(items: Item[], key: GroupKey): { key: string; label: string; items: Item[] }[] {
  if (key === 'none') return [{ key: '', label: '', items }];
  const keyOf = (i: Item) => key === 'collection' ? i.collection : key === 'kind' ? i.kind : i.status;
  const groups = new Map<string, Item[]>();
  for (const item of items) { const k = keyOf(item); groups.set(k, [...(groups.get(k) ?? []), item]); }
  const rank = (k: string) => key === 'kind' ? KINDS.indexOf(k as Item['kind']) : statusRank[k] ?? 9;
  const order = [...groups.keys()].sort((a, b) => key === 'collection' ? (!a ? 1 : !b ? -1 : a.localeCompare(b)) : rank(a) - rank(b));
  return order.map(k => ({ key: k, label: key === 'collection' ? k.replaceAll('/', ' / ') || 'No collection' : key === 'kind' ? kindPlural[k as Item['kind']] : statusGroup[k as Item['status']], items: groups.get(k)! }));
}
