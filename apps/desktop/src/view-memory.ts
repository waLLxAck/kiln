import { useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from 'react';
import { z } from 'zod';
import { emptyLibraryFilters } from './library-filters';
import { KINDS } from './Library';

const viewSchema = z.object({
  selected: z.string().default(''), query: z.string().default(''), filter: z.string().default('all'),
  sort: z.object({ key: z.enum(['title', 'kind', 'collection', 'status', 'updatedAt', 'createdAt', 'site']), dir: z.enum(['asc', 'desc']) }).nullable().default(null),
  installFilter: z.enum(['any', 'installed', 'none', 'codex', 'claude', 'copilot']).default('any'),
  advancedFilters: z.object({ provider: z.enum(['any', 'codex', 'claude', 'copilot']), location: z.enum(['any', 'agents', 'codex', 'claude', 'copilot']), state: z.enum(['any', 'managed', 'external', 'linked', 'changed']), scope: z.enum(['any', 'personal', 'project']), tag: z.string(), source: z.string().default('') }).default(emptyLibraryFilters),
});
const locationSchema = z.object({ section: z.string(), collection: z.string(), tab: z.enum(['recent', 'favourites', ...KINDS]) });
const memorySchema = z.object({ location: locationSchema, sections: z.record(z.string(), locationSchema), views: z.record(z.string(), viewSchema) });
type View = z.infer<typeof viewSchema>;
type Location = z.infer<typeof locationSchema>;
const keyFor = (location: Location) => JSON.stringify([location.section, location.collection, location.tab]);
const emptyView = () => viewSchema.parse({});
const defaultView = emptyView();
const storageKey = 'kiln-view-memory';
function readMemory(): z.infer<typeof memorySchema> {
  try { return memorySchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? 'null')); } catch {
    const old = localStorage.getItem('kiln-section') ?? 'library';
    const location: Location = { section: ['skills', 'inbox', 'instructions', 'favourites'].includes(old) ? 'library' : old, collection: '', tab: old === 'skills' ? 'skill' : old === 'favourites' ? 'favourites' : 'recent' };
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
    setSection: (section: string) => move((current, sections) => current.section === section ? current : sections[section] ?? { section, collection: '', tab: 'recent' }),
    setCollection: (collection: string) => move(current => ({ ...current, collection })),
    setTab: (tab: Location['tab']) => move(current => ({ ...current, tab })),
    setSelected: set('selected'), setQuery: set('query'), setFilter: set('filter'), setSort: set('sort'), setInstallFilter: set('installFilter'), setAdvancedFilters: set('advancedFilters'),
  };
}

export function useScrollMemory(key: string, ready: boolean, contentVersion?: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ready && ref.current) ref.current.scrollTop = Number(localStorage.getItem(`kiln-scroll:${key}`)) || 0;
  }, [key, ready, contentVersion]);
  return { ref, onScroll: () => { if (ready && ref.current) localStorage.setItem(`kiln-scroll:${key}`, String(ref.current.scrollTop)); } };
}
