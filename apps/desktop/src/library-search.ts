/** The library's search box: which items match, and (with the betterSearch experiment) in what order and how steadily. */
import { useEffect, useMemo, useState } from 'react';
import type { Item, Snapshot } from '../../../packages/protocol/schema';
import { api } from './api';
import { experimentOn } from './ExperimentalFeatures';
import type { Sort } from './library-sort';

/** What `items.search` returns: best matches first, how many there were before any limit, and whether they are only close matches. */
export type SearchResults = { items: Item[]; total: number; close: boolean };
/** An order picked while a search is active: a regular sort, or relevance. */
export type SearchSort = NonNullable<Sort> | 'relevance';

/**
 * `searchIds` is null until a query has results. With betterSearch on, results are re-fetched whenever any item's content
 * changes (not only when the count does), come ranked, and a sort picked during a search lasts until the search is cleared.
 */
export function useLibrarySearch(query: string, snapshot: Snapshot | null, onError: (message: string) => void) {
  const better = experimentOn(snapshot?.settings, 'betterSearch');
  const [searchIds, setSearchIds] = useState<string[] | null>(null);
  const [close, setClose] = useState(false), [searching, setSearching] = useState(false);
  const [searchSort, setSearchSort] = useState<SearchSort | null>(null);
  // A rename or retag keeps the item count, so the flag-on search watches what the index holds for every item.
  const items = snapshot?.items;
  const signature = useMemo(() => better ? items?.map(i => `${i.id}:${i.revision}:${i.updatedAt}:${i.deletedAt}:${i.status}:${i.title}:${i.tags.join(',')}:${i.description}`).join('|') : items?.length, [better, items]);
  useEffect(() => {
    if (!query.trim()) { setSearchIds(null); setClose(false); setSearching(false); setSearchSort(null); return; }
    let active = true;
    if (better) setSearching(true);
    const timer = setTimeout(() => {
      if (better) void api<SearchResults>('items.search', { query, archived: true }).then(result => { if (active) { setSearchIds(result.items.map(i => i.id)); setClose(result.close); setSearching(false); } }).catch(e => { if (active) { onError(String(e)); setSearching(false); } });
      else void api<Item[]>('items.list', { query, archived: true }).then(items => { if (active) setSearchIds(items.map(i => i.id)); }).catch(e => { if (active) onError(String(e)); });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query, signature, better]);
  return { better, searchIds, close: better && close, searching: better && searching, searchSort: better ? searchSort : null, setSearchSort };
}
