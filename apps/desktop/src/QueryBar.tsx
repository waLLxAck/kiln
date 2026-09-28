import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowDown, ArrowDownUp, ArrowUp, Bookmark, Check, CornerDownLeft, Loader2, Plus, Search, Star, X } from 'lucide-react';
import type { Installation, Item } from '../../../packages/protocol/schema';
import { KindIcon, type MenuEntry } from './components';
import { candidateTokens, facets, matchesQuery, parseTyped, sameToken, stateHint, tokenLabel, type Facet, type InstallState, type QueryToken } from './library-filters';
import { GroupMenu, MenuPill } from './Library';
import { sortChoices, sortLabel, type GroupKey, type Sort } from './library-sort';
import type { SavedView } from './view-memory';
import './query.css';

type Suggestion = { token: QueryToken; count: number };
type Props = {
  tokens: QueryToken[]; onTokens: (tokens: QueryToken[]) => void; query: string; onQuery: (query: string) => void;
  /** Items the view shows before any token applies: its section, collection or stage, and the search text. Counts come from these. */
  pool: Item[]; installations: Installation[]; sources: Item[]; /** Ids of items in a duplicate group, for `is:duplicate`. */ duplicates?: ReadonlySet<string>;
  saved: { views: SavedView[]; save: (name: string, tokens: QueryToken[], query: string) => void; remove: (id: string) => void };
  sort: NonNullable<Sort>; onSort: (sort: Sort) => void; group: GroupKey; onGroup: (group: GroupKey) => void;
  canReorder: boolean; reorder: (direction: number) => void; reorderDisabled: [boolean, boolean];
  /** While free text is searched: whether the list is in relevance order, and how to go back to it after picking another sort. */
  relevance?: { active: boolean; onPick: () => void };
  /** A search is on its way; the list keeps showing the previous results meanwhile. */
  searching?: boolean;
  /** Nothing matched exactly, so the list holds close matches (typos). */
  close?: boolean;
  /** Arrow down with the suggestions closed moves into the list. */
  onLeave: () => void;
};
const favourite: QueryToken = { facet: 'is', value: 'favourite' };
/** The Sort pill. While searching it also offers Relevance (best match first), which is what a search starts with. */
function SortPill({ sort, onSort, relevance }: { sort: NonNullable<Sort>; onSort: (sort: Sort) => void; relevance?: Props['relevance'] }) {
  const byRelevance = Boolean(relevance?.active);
  const entries: MenuEntry[] = [
    ...(relevance ? [{ label: 'Relevance', hint: 'Best matches for the search first', checked: byRelevance, onSelect: relevance.onPick }, 'separator' as const] : []),
    ...sortChoices.flatMap(c => [...(c.sort.key === 'order' ? ['separator' as const] : []), { label: c.label, hint: c.hint, checked: !byRelevance && c.sort.key === sort.key && c.sort.dir === sort.dir, onSelect: () => onSort(c.sort) }]),
  ];
  return <MenuPill icon={<ArrowDownUp size={13} />} name="Sort" value={byRelevance ? 'Relevance' : sortLabel(sort)} entries={entries} title={relevance ? 'Order of the search results' : 'Order of the list'} />;
}
const sameSet = (a: QueryToken[], b: QueryToken[]) => a.length === b.length && a.every(t => b.some(u => sameToken(t, u)));

/**
 * One field for finding things: filter tokens as chips (picked from suggestions grouped by facet, each with the count it would
 * show) and free text that searches titles, descriptions, content and tags, best match first. Saved views, Group and Sort sit on the row under it.
 */
export function QueryBar({ tokens, onTokens, query, onQuery, pool, installations, sources, duplicates, saved, sort, onSort, group, onGroup, canReorder, reorder, reorderDisabled, relevance, searching, close, onLeave }: Props) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1), [naming, setNaming] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null), box = useRef<HTMLDivElement>(null);
  useEffect(() => { const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); }; window.addEventListener('mousedown', away); return () => window.removeEventListener('mousedown', away); }, []);
  const title = (id: string) => sources.find(s => s.id === id)?.title;
  const typed = parseTyped(query);
  // Counted only while the suggestions are open: each is what adding that token would show.
  const suggestions = useMemo(() => {
    if (!open) return [];
    const rows: { facet: Facet; rows: Suggestion[] }[] = [];
    for (const facet of facets) {
      if (typed.facet && facet.key !== typed.facet) continue;
      // Values come from what the other facets leave, so a second value of this facet (matching either) is still offered.
      const others = tokens.filter(t => t.facet !== facet.key), base = pool.filter(i => matchesQuery(i, installations, others, duplicates));
      const matching = candidateTokens(base, installations, sources, duplicates).filter(t => t.facet === facet.key && !tokens.some(u => sameToken(t, u)))
        .filter(t => { const q = typed.rest; if (!q) return true; const label = tokenLabel(t, title).toLowerCase(); return label.includes(q) || t.value.toLowerCase().includes(q) || (!typed.facet && facet.key.startsWith(q)); })
        .map(token => ({ token, count: pool.filter(i => matchesQuery(i, installations, [...tokens, token], duplicates)).length })).filter(s => s.count > 0);
      const limit = typed.facet ? 12 : typed.rest ? 4 : 3;
      if (matching.length) rows.push({ facet: facet.key, rows: facet.key === 'kind' || facet.key === 'tag' ? matching.sort((a, b) => b.count - a.count).slice(0, limit) : matching.slice(0, limit) });
    }
    return rows;
  }, [open, pool, installations, sources, duplicates, tokens, query]);
  const flat = suggestions.flatMap(g => g.rows);
  useEffect(() => setActive(-1), [query, tokens]);
  /** Adds a token; whatever was typed to find it is cleared by the caller, so it does not also search. */
  const add = (token: QueryToken) => { onTokens([...tokens, token]); input.current?.focus(); };
  const remove = (token: QueryToken) => onTokens(tokens.filter(t => !sameToken(t, token)));
  const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); if (open && flat.length && (active >= 0 || query.trim())) setActive(i => Math.min(flat.length - 1, i + 1)); else { setOpen(false); onLeave(); } }
    else if (event.key === 'ArrowUp') { if (open) { event.preventDefault(); setActive(i => Math.max(-1, i - 1)); } }
    else if (event.key === 'Enter') { event.preventDefault(); const pick = flat[active] ?? (typed.facet ? flat[0] : undefined); if (open && pick) { add(pick.token); onQuery(''); } else setOpen(false); }
    else if (event.key === 'Tab' && open && query.trim() && flat.length) { event.preventDefault(); add((flat[active] ?? flat[0]).token); onQuery(''); }
    else if (event.key === 'Backspace' && !query && tokens.length) onTokens(tokens.slice(0, -1));
    else if (event.key === 'Escape') { event.preventDefault(); if (open) setOpen(false); else if (query) onQuery(''); else input.current?.blur(); }
  };
  const viewIs = (view: { tokens: QueryToken[]; query: string }) => sameSet(view.tokens, tokens) && view.query === query.trim();
  const current = viewIs({ tokens: [], query: '' }) ? 'all' : viewIs({ tokens: [favourite], query: '' }) ? 'favourites' : saved.views.find(viewIs)?.id;
  const icon = (token: QueryToken) => token.facet === 'kind' ? <KindIcon kind={token.value as Item['kind']} size={13} /> : <span className={`q-dot f-${token.facet}`} />;

  return <div className="query">
    <div className="query-box" ref={box}>
      <div className={`query-field ${open ? 'open' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); setOpen(true); } }}>
        {searching ? <Loader2 size={15} className="query-icon spin" aria-label="Searching" /> : <Search size={15} className="query-icon" aria-hidden="true" />}
        {tokens.map(token => <span key={token.facet + token.value} className={`q-token f-${token.facet}`} title={token.facet === 'state' ? stateHint[token.value as InstallState] : undefined}>
          <span className="q-facet">{token.facet}:</span><span className="q-value">{tokenLabel(token, title)}</span>
          <button type="button" onClick={() => remove(token)} aria-label={`Remove ${token.facet}: ${tokenLabel(token, title)}`}><X size={12} /></button>
        </span>)}
        <input ref={input} aria-label="Search library" value={query} title="Ctrl+F" onChange={event => { onQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={keyDown}
          placeholder={tokens.length ? 'Add a filter or search…' : 'Search, or filter with kind: status: in: tag: from:…'} role="combobox" aria-expanded={open && flat.length > 0} aria-controls="query-suggestions" aria-autocomplete="list" />
        {(tokens.length > 0 || query) && <button type="button" className="query-clear" onClick={() => { onTokens([]); onQuery(''); input.current?.focus(); }}>Clear</button>}
        <kbd>Ctrl F</kbd>
      </div>
      {open && <div className="query-drop" id="query-suggestions" role="listbox" aria-label="Filter suggestions">
        {!typed.facet && !typed.rest && <div className="query-facets">{facets.map(f => <button key={f.key} type="button" className="query-facet" title={f.hint} onMouseDown={event => { event.preventDefault(); onQuery(`${f.key}:`); input.current?.focus(); }}>{f.key}:</button>)}</div>}
        {typed.facet && <div className="query-label">{typed.facet}: <span className="faint">{facets.find(f => f.key === typed.facet)?.hint}</span></div>}
        {suggestions.map(group => <div key={group.facet} className="query-group">
          {!typed.facet && <div className="query-label">{facets.find(f => f.key === group.facet)?.label}</div>}
          {group.rows.map(row => { const index = flat.indexOf(row); return <button key={row.token.value} type="button" role="option" aria-selected={index === active} className={`query-option ${index === active ? 'active' : ''}`} onMouseEnter={() => setActive(index)} onMouseDown={event => { event.preventDefault(); add(row.token); onQuery(''); }}>
            <span className="query-option-icon">{icon(row.token)}</span><span className="query-option-text"><span className="q-facet">{row.token.facet}:</span> {tokenLabel(row.token, title)}</span><span className="query-count">{row.count}</span>{index === active && <CornerDownLeft size={12} className="faint" />}
          </button>; })}
        </div>)}
        {!flat.length && <div className="query-empty">{typed.facet ? `No ${typed.facet}: value matches here.` : query.trim() ? 'No filter matches. The list shows items whose title, description, content or tags match the text, best match first.' : 'Nothing to filter here yet.'}</div>}
        <div className="query-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> add filter</span><span><kbd>Backspace</kbd> remove last</span><span><kbd>Esc</kbd> close</span></div>
      </div>}
    </div>
    {close && <p className="query-note" role="status">No exact matches — showing close matches</p>}
    <div className="query-views">
      <div className="query-pills" role="group" aria-label="Saved views">
        <button type="button" className={`q-view ${current === 'all' ? 'on' : ''}`} aria-pressed={current === 'all'} onClick={() => { onTokens([]); onQuery(''); }}>All</button>
        <button type="button" className={`q-view ${current === 'favourites' ? 'on' : ''}`} aria-pressed={current === 'favourites'} onClick={() => { onTokens([favourite]); onQuery(''); }}><Star size={12} />Favourites</button>
        {saved.views.map(view => <span key={view.id} className={`q-view saved ${current === view.id ? 'on' : ''}`}>
          <button type="button" aria-pressed={current === view.id} onClick={() => { onTokens(view.tokens); onQuery(view.query); }} title={[...view.tokens.map(t => `${t.facet}:${tokenLabel(t, title)}`), view.query && `“${view.query}”`].filter(Boolean).join(' ')}>{view.name}</button>
          <button type="button" className="q-view-remove" aria-label={`Delete saved view ${view.name}`} title="Delete this saved view" onClick={() => saved.remove(view.id)}><X size={11} /></button>
        </span>)}
        {naming !== null
          ? <form className="q-name" onSubmit={event => { event.preventDefault(); saved.save(naming, tokens, query); setNaming(null); }}><Bookmark size={12} /><input autoFocus aria-label="Name this view" value={naming} maxLength={60} onChange={event => setNaming(event.target.value)} placeholder="Name this view" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setNaming(null); } }} onBlur={() => { if (!naming.trim()) setNaming(null); }} /><button type="submit" aria-label="Save view"><Check size={12} /></button></form>
          : !current && <button type="button" className="q-view save" onClick={() => setNaming('')}><Plus size={12} />Save this view</button>}
      </div>
      <span className="query-tools">
        <GroupMenu group={group} onGroup={onGroup} />
        <SortPill sort={sort} onSort={onSort} relevance={relevance} />
        {canReorder && <span className="inline"><button type="button" className="icon-button" aria-label="Move selected item up" disabled={reorderDisabled[0]} onClick={() => reorder(-1)}><ArrowUp size={13} /></button><button type="button" className="icon-button" aria-label="Move selected item down" disabled={reorderDisabled[1]} onClick={() => reorder(1)}><ArrowDown size={13} /></button></span>}
      </span>
    </div>
  </div>;
}
