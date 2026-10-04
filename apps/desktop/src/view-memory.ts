import { useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from 'react';
import { z } from 'zod';
import type { QueryToken } from './library-filters';
import type { GroupKey, Sort } from './library-sort';
import { filterSchema, noFilter, type MachinesFilter } from './machines-filter';

const tokenSchema = z.object({ facet: z.enum(['kind', 'status', 'in', 'state', 'provider', 'scope', 'tag', 'from', 'collection', 'is']), value: z.string() });
const sortSchema = z.object({ key: z.enum(['title', 'kind', 'collection', 'status', 'updatedAt', 'createdAt', 'lastUsed', 'site', 'copied', 'used', 'order']), dir: z.enum(['asc', 'desc']) }).nullable();
const groupSchema = z.enum(['none', 'collection', 'kind', 'status', 'lastUsed']);
/** What one view remembers: the focused row, whether it is open as a page, the search text, the filter tokens and the order. */
const viewSchema = z.object({
  selected: z.string().default(''), open: z.boolean().default(false), query: z.string().default(''),
  tokens: z.array(tokenSchema).default([]),
  sort: sortSchema.default(null), group: groupSchema.default('none'),
});
/** Where the library is pointed: a section, a collection or a lifecycle stage. Older builds stored a kind tab here; it is dropped. */
const locationSchema = z.object({ section: z.string(), collection: z.string(), stage: z.enum(['', 'drafts', 'testing', 'approved', 'installed']).catch('') });
const memorySchema = z.object({ location: locationSchema, sections: z.record(z.string(), locationSchema), views: z.record(z.string(), viewSchema.catch(() => viewSchema.parse({}))) });
type View = z.infer<typeof viewSchema>;
type Location = z.infer<typeof locationSchema>;
export type Stage = Location['stage'];
const keyFor = (location: Location) => JSON.stringify([location.section, location.collection, location.stage]);
const emptyView = () => viewSchema.parse({});
const defaultView = emptyView();
const storageKey = 'kiln-view-memory';
function readMemory(): z.infer<typeof memorySchema> {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    // Views from the kind-tab layout were keyed by [section, collection, tab]; keep the All tab's view as the unfiltered one.
    if (raw?.views) for (const [key, view] of Object.entries(raw.views)) { const [section, collection, tab] = JSON.parse(key); if (tab === 'recent') raw.views[JSON.stringify([section, collection, ''])] ??= view; }
    // Adopt the former global grouping once for existing views; new views start ungrouped.
    let legacyGroup: GroupKey = 'none';
    try { legacyGroup = groupSchema.parse(JSON.parse(localStorage.getItem('kiln-library-group') ?? 'null')); } catch { /* Default grouping. */ }
    if (raw?.views) for (const view of Object.values(raw.views) as Record<string, unknown>[]) if (view && typeof view === 'object' && !Array.isArray(view) && view.group === undefined) view.group = legacyGroup;
    return memorySchema.parse(raw);
  } catch {
    const old = localStorage.getItem('kiln-section') ?? 'library';
    const location: Location = { section: ['skills', 'inbox', 'instructions', 'favourites'].includes(old) ? 'library' : old, collection: '', stage: '' };
    return { location, sections: {}, views: { [keyFor(location)]: { ...emptyView(), selected: localStorage.getItem('kiln-selected') ?? '' } } };
  }
}
export function useViewMemory() {
  const [memory, setMemory] = useState(readMemory);
  const { location } = memory;
  const key = keyFor(location), view = memory.views[key] ?? defaultView;
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(memory)); localStorage.setItem('kiln-section', location.section); }, [memory]);
  const set = <K extends keyof View>(field: K) => (value: SetStateAction<View[K]>) => setMemory(previous => {
    const key = keyFor(previous.location), view = previous.views[key] ?? emptyView();
    return { ...previous, views: { ...previous.views, [key]: { ...view, [field]: typeof value === 'function' ? (value as (v: View[K]) => View[K])(view[field]) : value } } };
  });
  const move = (update: (current: Location, sections: typeof memory.sections) => Location) => setMemory(previous => ({ ...previous, sections: { ...previous.sections, [previous.location.section]: previous.location }, location: update(previous.location, previous.sections) }));
  return { ...location, ...view, key,
    setSection: (section: string) => move((current, sections) => current.section === section ? current : sections[section] ?? { section, collection: '', stage: '' }),
    /** A collection and a stage are two ways of narrowing the library; choosing one clears the other. */
    setCollection: (collection: string) => move(current => ({ ...current, collection, stage: collection ? '' : current.stage })),
    setStage: (stage: Stage) => move(current => ({ ...current, section: 'library', collection: '', stage })),
    setSelected: set('selected'), setOpen: set('open'), setQuery: set('query'), setTokens: set('tokens'), setSort: set('sort'), setGroup: set('group'),
  };
}

export function useScrollMemory(key: string, ready: boolean, contentVersion?: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ready && ref.current) ref.current.scrollTop = Number(localStorage.getItem(`kiln-scroll:${key}`)) || 0;
  }, [key, ready, contentVersion]);
  return { ref, onScroll: () => { if (ready && ref.current) localStorage.setItem(`kiln-scroll:${key}`, String(ref.current.scrollTop)); } };
}

/** A small value kept in localStorage and checked on the way in, so a hand-edited or outdated entry falls back to the default. */
function useStored<T>(storage: string, schema: z.ZodType<T>, fallback: T) {
  const [value, setValue] = useState<T>(() => { try { return schema.parse(JSON.parse(localStorage.getItem(storage) ?? 'null')); } catch { return fallback; } });
  const update = (next: T) => { setValue(next); localStorage.setItem(storage, JSON.stringify(next)); };
  return [value, update] as const;
}
/** Machines' state chips, name filter, kind and columns (machines-filter.ts). */
export const useMachinesFilter = () => useStored<MachinesFilter>('kiln-machines-filter', filterSchema, noFilter);
export type SavedView = { id: string; name: string; tokens: QueryToken[]; query: string; sort?: Sort | 'relevance'; group?: GroupKey };
const savedSchema = z.array(z.object({ id: z.string(), name: z.string().trim().min(1).max(60), tokens: z.array(tokenSchema), query: z.string().max(500), sort: z.union([sortSchema, z.literal('relevance')]).optional(), group: groupSchema.optional() })).max(40);
/** Queries the user named with "Save this view", shown as pills under the query bar. */
export function useSavedViews() {
  const [views, setViews] = useStored<SavedView[]>('kiln-saved-views', savedSchema, []);
  return {
    views,
    save: (name: string, tokens: QueryToken[], query: string, sort: Sort | 'relevance', group: GroupKey) => { if (views.length < 40) setViews([...views, { id: crypto.randomUUID(), name: name.trim().slice(0, 60) || 'My view', tokens, query: query.trim(), sort, group }]); },
    remove: (id: string) => setViews(views.filter(v => v.id !== id)),
  };
}
