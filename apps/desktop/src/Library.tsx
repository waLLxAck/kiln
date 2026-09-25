import { primarySkillLabel } from '../../../packages/providers/skill-locations';
import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, FlaskConical, Github, Plus, Search, SlidersHorizontal, Star, X } from 'lucide-react';
import type { Installation, Item, Provider, ProviderId, Target } from '../../../packages/protocol/schema';
import { Badge, ContextMenu, KindIcon, statusHelp, type MenuEntry } from './components';
import { date } from './api';
import { skillState } from './Skills';
import { emptyLibraryFilters, filterDimensions, type FilterDimension, type LibraryFilterKey, type LibraryFilters } from './library-filters';

/** One tab per kind of item, plus two cross-cutting views. Skills is a tab like any other; its rows carry install marks. */
export type LibraryTab = 'recent' | 'favourites' | Item['kind'];
export const KINDS: Item['kind'][] = ['prompt', 'skill', 'agent', 'insight', 'technique', 'tool', 'resource', 'link', 'instruction', 'image', 'file', 'reference'];
export const tabLabel: Record<LibraryTab, string> = { recent: 'All', favourites: 'Favourites', prompt: 'Prompts', skill: 'Skills', agent: 'Agents', insight: 'Insights', technique: 'Techniques', tool: 'Tools', resource: 'Resources', link: 'Links', instruction: 'Instructions', image: 'Images', file: 'Files', reference: 'References' };
export const inTab = (item: Item, tab: LibraryTab) => tab === 'recent' || (tab === 'favourites' ? item.favourite : item.kind === tab);

export function LibraryTabs({ tab, counts, onChange }: { tab: LibraryTab; counts: Record<string, number>; onChange: (tab: LibraryTab) => void }) {
  const tabs: LibraryTab[] = ['recent', ...(counts.favourites || tab === 'favourites' ? ['favourites' as const] : []), ...KINDS.filter(k => counts[k])];
  return <div className="lib-tabs" role="tablist" aria-label="Library views">{tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => onChange(t)}>{t === 'favourites' ? <Star size={13} /> : t !== 'recent' ? <KindIcon kind={t} size={13} /> : null}{tabLabel[t]}<small>{counts[t] ?? 0}</small></button>)}</div>;
}

/** Where a skill is installed, as a filter: anywhere, nowhere, or a specific agent. */
export type InstallFilter = 'any' | 'installed' | 'none' | ProviderId;
type Location = { provider: Provider; target: Target };
/** Providers whose skill folder holds this item, in any form Kiln recognises (managed, adopted-in-waiting, edited or linked). */
export const installedFor = (item: Item, locations: Location[], installations: Installation[]) => ['skill', 'agent'].includes(item.kind) ? locations.filter(({ target }) => skillState(item, target, installations).state !== 'off').map(l => l.provider.id) : [];
export const passesInstallFilter = (filter: InstallFilter, item: Item, locations: Location[], installations: Installation[]) => {
  if (filter === 'any') return true;
  const where = installedFor(item, locations, installations);
  const anyCopy = installations.some(i => i.itemId === item.id);
  return filter === 'installed' ? anyCopy : filter === 'none' ? !anyCopy : where.includes(filter);
};

/** One choice in a filter menu. `count` is how many items choosing it would show, given the other filters. */
export type FilterOption = { value: string; label: string; count: number; hint?: string };
/**
 * One filter, shown as a pill. Click it to pick a value from a menu; the × on an active pill clears just that filter.
 * Optional pills pass `onRemove`, so × also takes the pill out of the row. `autoOpen` opens the menu as soon as the pill appears.
 */
export function FilterPill({ name, value, all, options, onChange, onRemove, hint, autoOpen }: { name: string; value: string; all: string; options: FilterOption[]; onChange: (value: string) => void; onRemove?: () => void; hint?: string; autoOpen?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const show = () => { const box = ref.current!.getBoundingClientRect(); setOpen({ x: box.left, y: box.bottom + 4 }); };
  useLayoutEffect(() => { if (autoOpen) show(); }, [autoOpen]);
  const active = value !== all, current = options.find(o => o.value === value);
  const entries: MenuEntry[] = [{ label: `Any ${name.toLowerCase()}`, checked: !active, onSelect: () => onChange(all) }, ...(options.length ? ['separator' as const, ...options.map(o => ({ label: o.label, checked: o.value === value, hint: o.hint, note: String(o.count), onSelect: () => onChange(o.value) }))] : [])];
  const clear = () => { onChange(all); onRemove?.(); };
  return <span className={`filter-pill ${active ? 'active' : ''}`}>
    <button ref={ref} type="button" aria-haspopup="menu" aria-expanded={Boolean(open)} title={hint} onClick={show}>{name}{active && <>: <b>{current?.label ?? value}</b></>}<ChevronDown /></button>
    {(active || onRemove) && <button type="button" className="filter-clear" aria-label={onRemove ? `Remove ${name.toLowerCase()} filter` : `Clear ${name.toLowerCase()} filter`} title={onRemove ? 'Remove this filter' : `Show any ${name.toLowerCase()}`} onClick={clear}><X /></button>}
    {open && <ContextMenu x={open.x} y={open.y} entries={entries} onClose={() => setOpen(null)} />}
  </span>;
}
/** The "+ Filter" pill: a menu of the filter dimensions not yet in the row. */
function AddFilter({ dimensions, onAdd }: { dimensions: FilterDimension[]; onAdd: (key: LibraryFilterKey) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  if (!dimensions.length) return null;
  return <span className="filter-pill add">
    <button ref={ref} type="button" aria-haspopup="menu" aria-expanded={Boolean(open)} title="Add a filter" onClick={() => { const box = ref.current!.getBoundingClientRect(); setOpen({ x: box.left, y: box.bottom + 4 }); }}><Plus />Filter</button>
    {open && <ContextMenu x={open.x} y={open.y} entries={dimensions.map(d => ({ label: d.name, hint: d.hint, onSelect: () => onAdd(d.key) }))} onClose={() => setOpen(null)} />}
  </span>;
}

type ToolsProps = { query: string; onQuery: (q: string) => void; onSearchDown: (e: React.KeyboardEvent<HTMLInputElement>) => void; status: string; statuses: FilterOption[]; onStatus: (s: string) => void; install: InstallFilter; installOptions: FilterOption[] | null; onInstall: (f: InstallFilter) => void; advanced: LibraryFilters; onAdvanced: (next: LibraryFilters) => void; advancedOptions: (key: LibraryFilterKey) => FilterOption[]; onClear: () => void; shown: number; chosen: number; onClearChosen: () => void; canReorder: boolean; reorder: (direction: number) => void; reorderDisabled: [boolean, boolean] };
/**
 * Search with the count and reorder arrows, then one row of filter pills. Status and installed are always there; the other
 * dimensions join the row through "+ Filter" and leave it through their ×. Collections are chosen in the sidebar, not here.
 */
export function LibraryTools({ query, onQuery, onSearchDown, status, statuses, onStatus, install, installOptions, onInstall, advanced, onAdvanced, advancedOptions, onClear, shown, chosen, onClearChosen, canReorder, reorder, reorderDisabled }: ToolsProps) {
  const [added, setAdded] = useState<LibraryFilterKey[]>([]), [fresh, setFresh] = useState<LibraryFilterKey | null>(null);
  const inRow = filterDimensions.filter(d => added.includes(d.key) || advanced[d.key] !== emptyLibraryFilters[d.key]);
  const filtering = status !== 'all' || install !== 'any' || inRow.length > 0;
  return <>
    <div className="lib-tools">
      <label className="search-field"><Search size={16} /><input aria-label="Search library" value={query} onChange={e => onQuery(e.target.value)} onKeyDown={onSearchDown} placeholder="Search titles, content, tags…" title="Ctrl+F" />{query && <button aria-label="Clear search" onClick={() => onQuery('')}><X size={13} /></button>}</label>
      {chosen > 1 ? <span className="lib-count selection" aria-live="polite"><b>{chosen} selected</b><button type="button" className="icon-button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClearChosen}><X size={13} /></button></span> : <span className="muted small lib-count" aria-live="polite">{shown} shown</span>}
      {canReorder && <span className="inline"><button className="icon-button" aria-label="Move selected item up" disabled={reorderDisabled[0]} onClick={() => reorder(-1)}><ArrowUp size={13} /></button><button className="icon-button" aria-label="Move selected item down" disabled={reorderDisabled[1]} onClick={() => reorder(1)}><ArrowDown size={13} /></button></span>}
    </div>
    <div className="filter-bar" role="group" aria-label="Filters">
      <SlidersHorizontal aria-hidden="true" />
      <FilterPill name="Status" value={status} all="all" options={statuses} onChange={onStatus} hint={status !== 'all' ? statusHelp[status] : 'Only items in one lifecycle status'} />
      {installOptions && <FilterPill name="Installed" value={install} all="any" options={installOptions} onChange={v => onInstall(v as InstallFilter)} hint="Where the skill is installed on this machine" />}
      {inRow.map(d => <FilterPill key={d.key} name={d.name} value={advanced[d.key]} all={emptyLibraryFilters[d.key]} options={advancedOptions(d.key)} hint={d.hint} autoOpen={fresh === d.key} onChange={v => { setFresh(null); onAdvanced({ ...advanced, [d.key]: v }); }} onRemove={() => { setFresh(null); setAdded(keys => keys.filter(k => k !== d.key)); }} />)}
      <AddFilter dimensions={filterDimensions.filter(d => !inRow.includes(d))} onAdd={key => { setAdded(keys => [...keys, key]); setFresh(key); }} />
      {filtering && <button type="button" className="text-button" onClick={() => { setAdded([]); setFresh(null); onClear(); }}>Clear filters</button>}
    </div>
  </>;
}

export type SortKey = 'title' | 'kind' | 'collection' | 'status' | 'updatedAt' | 'createdAt' | 'site';
export type Sort = { key: SortKey; dir: 'asc' | 'desc' } | null;
/** `opt` columns give way when the list is narrow; the title and the State column always stay. */
type Column = { label: string; key: SortKey; opt?: boolean };
export const columns = (tab: LibraryTab): Column[] => tab === 'skill' ? [{ label: 'Skill', key: 'title' }, { label: 'Collection', key: 'collection', opt: true }, { label: 'State', key: 'status' }, { label: 'Updated', key: 'updatedAt', opt: true }]
  : tab === 'link' ? [{ label: 'Title', key: 'title' }, { label: 'Site', key: 'site', opt: true }, { label: 'Collection', key: 'collection', opt: true }, { label: 'State', key: 'status' }, { label: 'Saved', key: 'createdAt', opt: true }]
  : tab === 'recent' || tab === 'favourites' ? [{ label: 'Title', key: 'title' }, { label: 'Type', key: 'kind', opt: true }, { label: 'Collection', key: 'collection', opt: true }, { label: 'State', key: 'status' }, { label: 'Updated', key: 'updatedAt', opt: true }]
  : [{ label: 'Title', key: 'title' }, { label: 'Collection', key: 'collection', opt: true }, { label: 'State', key: 'status' }, { label: 'Updated', key: 'updatedAt', opt: true }];
/** Clicking a heading sorts by it; clicking again flips the direction. Dates start newest first, text starts A to Z. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'updatedAt' || key === 'createdAt' ? 'desc' : 'asc' };
}
const site = (item: Item) => { try { return new URL(item.source).hostname.replace(/^www\./, ''); } catch { return item.source || '—'; } };
const statusRank: Record<string, number> = { approved: 0, testing: 1, captured: 2, rejected: 3, archived: 4 };
export function sortItems(items: Item[], sort: Sort): Item[] {
  if (!sort) return items;
  const value = (i: Item): string | number => sort.key === 'site' ? site(i).toLowerCase() : sort.key === 'status' ? statusRank[i.status] ?? 9 : String(i[sort.key]).toLowerCase();
  const direction = sort.dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : a.title.localeCompare(b.title)) * direction; });
}
export function RowHead({ tab, sort, onSort }: { tab: LibraryTab; sort: Sort; onSort: (key: SortKey) => void }) {
  const cols = columns(tab);
  return <div className={`lib-row head cols-${cols.length}`}><span />{cols.map(c => <button key={c.key} type="button" className={`lib-cell ${c.opt ? 'opt' : ''} ${c.key === 'status' ? 'status' : ''} ${sort?.key === c.key ? 'sorted' : ''}`} onClick={() => onSort(c.key)} title={`Sort by ${c.label.toLowerCase()}`} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>{c.label}{sort?.key === c.key && (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}</button>)}</div>;
}
/**
 * The same cell on every tab, so state is never hidden: for an approved item the GitHub mark alone tells the story
 * (green once pushed, muted while the push is pending); drafts keep their status badge. Skills add install marks per agent.
 */
export function StateCell({ item, locations, installations, published }: { item: Item; locations: Location[]; installations: Installation[]; published: boolean }) {
  const mark = item.status === 'approved' ? <span className={`lib-mark ${published ? 'on' : 'pending'}`} title={published ? 'Approved and on GitHub' : 'Approved; the push to GitHub has not finished'} role="img" aria-label={published ? 'On GitHub' : 'Approved, push pending'}><Github size={14} /></span>
    : item.status === 'testing' ? <span className="lib-mark testing" title={statusHelp.testing} role="img" aria-label="Testing"><FlaskConical size={14} /></span>
    : ['archived', 'rejected'].includes(item.status) ? <Badge status={item.status} />
    : <span className="lib-mark draft" title={statusHelp.captured} role="img" aria-label="Draft" />;
  return <span className="lib-cell status">{mark}{['skill', 'agent'].includes(item.kind) && locations.length > 0 && <span className="install-marks">{locations.filter(l => item.kind === 'agent' ? l.provider.id === item.agent?.provider : l.provider.id !== 'copilot').map(({ provider, target }) => { const { state } = skillState(item, target, installations); return <span key={provider.id} className={`install-mark ${state}`} title={`${item.kind === 'agent' ? provider.label : primarySkillLabel(provider.id)}: ${state === 'off' ? 'not installed' : state === 'on' ? 'installed' : state}`}>{provider.id === 'codex' ? (item.kind === 'agent' ? 'Cx' : 'A') : provider.id === 'copilot' ? 'Cp' : 'Cl'}</span>; })}</span>}</span>;
}
/** The inside of one list row. `opt` cells give way when the list is narrow; the title and the State cell always stay. */
/** `from` names the item's source when another item has the same title, so the two can be told apart. */
export function ItemRow({ item, tab, collectionShown, locations, installations, published, from }: { item: Item; tab: LibraryTab; collectionShown: boolean; locations: Location[]; installations: Installation[]; published: boolean; from?: { label: string; full: string } }) {
  const cols = columns(tab);
  const cell = (key: SortKey) => key === 'status' ? <StateCell key="state" item={item} locations={locations} installations={installations} published={published} />
    : <span key={key} className="lib-cell opt muted">{key === 'kind' ? <span className="item-kind-label">{item.kind}</span> : key === 'collection' ? item.collection : key === 'site' ? site(item) : key === 'createdAt' ? date(item.createdAt) : date(item.updatedAt)}</span>;
  const subtitle = [from ? `from ${from.label}` : '', item.description || (tab === 'recent' || tab === 'favourites' || collectionShown ? '' : item.tags.slice(0, 3).map(t => `#${t}`).join('  '))].filter(Boolean).join(' · ');
  return <><span className={`item-kind ${item.kind}`}><KindIcon kind={item.kind} size={14} /></span><span className="lib-title"><span className="item-title">{item.title}{item.favourite && <Star size={12} fill="currentColor" />}</span><small className="lib-sub" title={from ? `From ${from.full}` : undefined}><span className="lib-narrow-only"><span className="item-kind-label">{item.kind}</span>{collectionShown ? '' : ` · ${item.collection}`}{subtitle ? ' · ' : ''}</span>{subtitle}</small></span>{cols.slice(1).map(c => cell(c.key))}</>;
}
