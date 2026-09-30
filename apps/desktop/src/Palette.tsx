import { Markdown } from './Markdown';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Activity, Archive, ArrowLeft, Check, ChevronRight, Copy, CornerDownLeft, Download, ExternalLink, FileCog, FlaskConical, FolderPlus, Layers3, MessageSquare, Monitor, Moon, Plus, RefreshCw, Search, Settings, Trash2, X } from 'lucide-react';
import type { Item, ItemDetail, Snapshot } from '../../../packages/protocol/schema';
import { resolveVariables } from '../../../packages/domain/text';
import { api, variablesIn } from './api';
import { Badge, KindIcon } from './components';
import type { KilnCommand } from './command-names';
import type { SearchResults } from './library-search';
import { actionScore, matchRanges, mostUsed, parsePaletteQuery, preferredRow } from './palette-match';
import './palette.css';

type Action = { id: string; label: string; icon: ReactNode; detail: string; keywords?: string; /** Matched instead of the label, when the label holds an item's title. */ match?: string; command: KilnCommand; disabled?: boolean; affects?: string[] };
type Row = { type: 'item'; item: Item } | { type: 'action'; action: Action };
type ItemAction = { id: string; label: string; icon: ReactNode; run: () => void };

/** Items shown before the actions when nothing is typed: the most used ones, so the actions stay in view. */
const IDLE_ITEMS = 8;
/** Results asked for per search; the list says when there were more. */
const LIMIT = 30;
type How = 'default' | 'kiln' | 'test';
const sections = [
  { id: 'library', label: 'Library', icon: <Layers3 size={15} />, detail: 'Every item, with search, filters and collections.' },
  { id: 'machines', label: 'Machines', icon: <Monitor size={15} />, detail: 'Skill locations and project folders on this machine, and what is installed where.', keywords: 'installs locations' },
  { id: 'home', label: 'Config files', icon: <FileCog size={15} />, detail: 'CLAUDE.md, AGENTS.md, agent settings and hooks, backed up before each save.', keywords: 'claude.md agents.md settings hooks home' },
  { id: 'activity', label: 'Activity', icon: <Activity size={15} />, detail: 'What Kiln and your agents did, newest first.', keywords: 'history log' },
  { id: 'experiments', label: 'Experiments', icon: <FlaskConical size={15} />, detail: 'Every trial and its result.', keywords: 'tests trials' },
  { id: 'settings', label: 'Settings', icon: <Settings size={15} />, detail: 'Repository, skill locations, agent, theme, shortcut and updates.', keywords: 'preferences shortcut updates' },
  { id: 'archive', label: 'Archive', icon: <Archive size={15} />, detail: 'Archived and rejected items.' },
  { id: 'trash', label: 'Trash', icon: <Trash2 size={15} />, detail: 'Deleted items, until you empty the trash.', keywords: 'deleted' },
] as const;
/** What Enter does: sources are read in Kiln, links open in the browser, everything else is pasted. */
const defaultAction = (item: Item) => item.kind === 'source' ? 'kiln' : item.kind === 'link' ? 'link' : 'copy';
const defaultVerb = (item: Item) => ({ kiln: 'Open in Kiln', link: 'Open link', copy: 'Copy' })[defaultAction(item)];
const kindLabel = (kind: Item['kind']) => kind === 'mcp' ? 'MCP server' : kind[0].toUpperCase() + kind.slice(1);
const openLabel = (item: Item) => item.kind === 'source' ? 'Open original' : item.kind === 'link' ? 'Open link in browser' : ['file', 'image', 'reference'].includes(item.kind) ? 'Reveal stored file' : 'Open stored file';
/** The main window's rule: a saved choice, else the library setting, with "system" following the OS. */
const applyTheme = (setting?: string) => { const chosen = localStorage.getItem('kiln-theme') ?? setting; document.documentElement.dataset.theme = chosen === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : chosen ?? 'light'; };
/** Skills keep a YAML header; the preview shows it as a compact key list above the body instead of as a rule and a paragraph. */
const frontMatter = (content: string) => { const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/); return match ? { header: match[1].split(/\r?\n/).filter(line => line.trim()), body: content.slice(match[0].length) } : { header: [], body: content }; };

function Highlight({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = []; let at = 0;
  ranges.forEach(([start, end], i) => { parts.push(text.slice(at, start), <mark key={i} className="pal-mark">{text.slice(start, end)}</mark>); at = end; });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A footer hint; also a button, for the mouse. */
function Key({ keys, label, onClick }: { keys: string[]; label: string; onClick: () => void }) {
  return <button type="button" className="pal-key" onClick={onClick}>{keys.map(key => <kbd key={key}>{key}</kbd>)}<span>{label}</span></button>;
}

export default function Palette() {
  const [query, setQuery] = useState(''), [results, setResults] = useState<SearchResults | null>(null), [selected, setSelected] = useState(0), [error, setError] = useState('');
  const [preview, setPreview] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  // Usage for ordering, marked installs and the theme: read once each time the palette is shown.
  const [snapshot, setSnapshot] = useState<Pick<Snapshot, 'usage' | 'installs' | 'items' | 'settings'> | null>(null);
  // Tab switches the list to the selected item's actions; Esc comes back.
  const [mode, setMode] = useState<'list' | 'actions'>('list'), [actionIndex, setActionIndex] = useState(0);
  // Variable values per item, so moving through the list and back keeps what was typed until the palette is shown again.
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  // The item "Ask the agent about…" refers to: the last item highlighted, since highlighting the action itself leaves the items.
  const [lastItem, setLastItem] = useState<Item | null>(null);
  // Enter pressed while a search was on its way: acts on the row Enter would pick once the results are in, so a fast Enter is never lost.
  const [pending, setPending] = useState<How | null>(null);
  /** The title just copied, shown for a moment before the window hides. */
  const [copied, setCopied] = useState<string | null>(null);
  /** Bumped each time the window is shown, so the remembered search runs afresh. */
  const [generation, setGeneration] = useState(0);
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), preview_ = useRef<HTMLElement>(null), hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadSnapshot = () => void api<Snapshot>('snapshot').then(next => { setSnapshot(next); applyTheme(next.settings.theme); }).catch(e => setError(String(e)));
  useEffect(() => {
    applyTheme();
    // The last search stays, selected, so typing replaces it and Enter does the same thing again.
    const shown = () => { clearTimeout(hideTimer.current); setCopied(null); setPending(null); input.current?.focus(); input.current?.select(); setMode('list'); setValues({}); setError(''); setGeneration(g => g + 1); loadSnapshot(); };
    window.addEventListener('focus', shown); input.current?.focus(); loadSnapshot();
    return () => { window.removeEventListener('focus', shown); clearTimeout(hideTimer.current); };
  }, []);
  const { actionsOnly, text: q } = parsePaletteQuery(query);
  useEffect(() => {
    // An Enter left over from an item search must not run whichever action '>' lists first.
    if (actionsOnly) { setPending(null); setLoading(false); return; }
    let active = true; setLoading(true); setError('');
    const timer = setTimeout(() => void api<SearchResults>('items.search', q ? { query: q, limit: LIMIT } : {}).then(result => { if (active) { setResults(result); setLoading(false); } }).catch(e => { if (active) { setError(String(e)); setPending(null); setLoading(false); } }), 100);
    return () => { active = false; clearTimeout(timer); };
  }, [q, actionsOnly, generation]);

  // Typed searches keep the backend's relevance order, the library's too; with nothing typed the most used lead.
  const ranked = useMemo(() => actionsOnly ? [] : q ? results?.items ?? [] : mostUsed(results?.items ?? [], snapshot?.usage ?? {}).slice(0, IDLE_ITEMS), [results, q, actionsOnly, snapshot?.usage]);
  const capped = !actionsOnly && q && results && results.total > results.items.length ? results.total : 0;
  const close = !actionsOnly && Boolean(q) && Boolean(results?.close);
  const actions = useMemo(() => {
    const marked = Object.keys(snapshot?.installs ?? {}), titles = new Map(snapshot?.items.map(i => [i.id, i.title]));
    const all: Action[] = [
      { id: 'capture', label: 'Capture…', icon: <Plus size={15} />, detail: 'Add a link, video, text or files as a new draft.', keywords: 'new add paste', command: { name: 'capture' } },
      { id: 'sync-installs', label: 'Install everything marked for this machine', icon: <Download size={15} />, keywords: 'sync skills', command: { name: 'sync-installs' }, disabled: !marked.length,
        detail: marked.length ? `Copies the ${marked.length === 1 ? 'skill' : `${marked.length} skills`} this library marks as installed into the skill locations turned on here. The result shows in Settings.` : 'No skill in this library is marked as installed yet.',
        affects: marked.slice(0, 6).map(id => titles.get(id) ?? id).concat(marked.length > 6 ? [`and ${marked.length - 6} more`] : []) },
      ...sections.map(section => ({ id: `go-${section.id}`, label: `Go to ${section.label}`, icon: section.icon, detail: section.detail, keywords: 'keywords' in section ? section.keywords : undefined, command: { name: 'navigate', id: section.id } as KilnCommand })),
      { id: 'new-collection', label: 'New collection', icon: <FolderPlus size={15} />, detail: 'Creates “New Folder” in the sidebar, ready to name.', keywords: 'folder', command: { name: 'new-collection' } },
      { id: 'check-updates', label: 'Check for updates', icon: <RefreshCw size={15} />, detail: 'Looks for a newer Kiln now. Settings shows the result and the download.', keywords: 'upgrade version new release', command: { name: 'check-updates' } },
      { id: 'toggle-theme', label: 'Toggle theme', icon: <Moon size={15} />, detail: 'Switch between the light and dark theme.', keywords: 'dark light mode', command: { name: 'toggle-theme' } },
      ...(lastItem ? [{ id: 'ask-item', label: `Ask the agent about “${lastItem.title}”`, icon: <MessageSquare size={15} />, detail: 'Opens the item in Kiln with the agent chat beside it.', keywords: 'chat', match: 'Ask the agent about', command: { name: 'ask-item', id: lastItem.id } as KilnCommand }] : []),
    ];
    if (!q) return all;
    return all.map(action => ({ action, score: actionScore(action, q) })).filter(entry => entry.score >= 0).sort((a, b) => a.score - b.score).map(entry => entry.action);
  }, [snapshot, lastItem, q]);
  const rows: Row[] = useMemo(() => [...ranked.map(item => ({ type: 'item' as const, item })), ...actions.map(action => ({ type: 'action' as const, action }))], [ranked, actions]);
  const preferred = preferredRow(ranked.map(i => i.title), actions[0], q);
  useEffect(() => setSelected(preferred), [results, q, actionsOnly]);
  const current = rows[Math.min(selected, rows.length - 1)];
  const item = current?.type === 'item' ? current.item : null;
  const detail = item && preview?.item.id === item.id ? preview : null;
  const variables = detail ? variablesIn(detail.revision.content) : [];
  const filled = item ? values[item.id] ?? {} : {};

  useEffect(() => { if (item) setLastItem(item); }, [item?.id]);
  useEffect(() => {
    let active = true;
    if (item && !loading) void api<ItemDetail>('items.read', { id: item.id }).then(next => { if (active) setPreview(next); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [item?.id, loading]);
  useEffect(() => { list.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' }); preview_.current?.scrollTo({ top: 0 }); }, [current, mode, actionIndex]);

  const attempt = async (action: () => Promise<unknown>) => { setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } };
  /** The main window does it (and shows itself); main.ts hides the palette. */
  const command = (next: KilnCommand) => void attempt(() => api('desktop.command', next));
  // The same call as VariablesDialog: blank fields keep their {{name}} placeholder in the copied text.
  // A short "Copied" confirms it before the window goes.
  const copy = (target: Item) => void attempt(async () => {
    await api('desktop.copy', { id: target.id, revision: target.revision, variables: values[target.id] ?? {} });
    setCopied(target.title); clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { setCopied(null); void api('desktop.hide'); }, 600);
  });
  const openStored = (target: Item) => void attempt(async () => { await api('desktop.openItem', { id: target.id }); await api('desktop.hide'); });
  const run = (row: Row | undefined, how: How = 'default') => {
    if (!row || copied !== null || (row.type === 'item' && loading)) return;
    if (row.type === 'action') { if (!row.action.disabled) command(row.action.command); return; }
    const target = row.item, verb = how === 'default' ? defaultAction(target) : how;
    // A source is material an analysis read; it has no experiments, so Shift+Enter opens it instead.
    if (verb === 'test') command({ name: target.kind === 'source' ? 'open-item' : 'test-item', id: target.id });
    else if (verb === 'kiln') command({ name: 'open-item', id: target.id });
    else if (verb === 'link') openStored(target);
    else copy(target);
  };
  const itemActions: ItemAction[] = item ? [
    ...(variables.length ? [{ id: 'fill', label: 'Fill in variables', icon: <CornerDownLeft size={15} />, run: () => { setMode('list'); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.pal-var input')?.focus()); } }] : []),
    ...(item.kind === 'source' ? [] : [{ id: 'copy', label: variables.length ? 'Copy with these values' : 'Copy', icon: <Copy size={15} />, run: () => copy(item) }]),
    { id: 'kiln', label: 'Open in Kiln', icon: <ChevronRight size={15} />, run: () => run(current, 'kiln') },
    ...(item.kind === 'source' ? [] : [{ id: 'test', label: 'Test…', icon: <FlaskConical size={15} />, run: () => run(current, 'test') }]),
    { id: 'ask', label: 'Ask the agent', icon: <MessageSquare size={15} />, run: () => command({ name: 'ask-item', id: item.id }) },
    { id: 'open', label: openLabel(item), icon: <ExternalLink size={15} />, run: () => openStored(item) },
  ] : [];
  const inActions = mode === 'actions' && item;
  useEffect(() => { if (loading || !pending) return; setPending(null); run(rows[preferred], pending); }, [loading, pending]);

  const keyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement, inSearch = target === input.current, inField = target.closest('.pal-var') !== null;
    if (inActions) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActionIndex(i => Math.max(0, Math.min(itemActions.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))); }
      else if (event.key === 'Enter') { event.preventDefault(); itemActions[actionIndex]?.run(); }
      else if (event.key === 'Escape' || event.key === 'Tab' || event.key === 'Backspace') { event.preventDefault(); setMode('list'); input.current?.focus(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); if (inField) input.current?.focus(); else void api('desktop.hide'); return; }
    if (!inSearch && !inField) return;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && inSearch) { event.preventDefault(); setSelected(i => Math.max(0, Math.min(rows.length - 1, Math.min(i, rows.length - 1) + (event.key === 'ArrowDown' ? 1 : -1)))); }
    else if (event.key === 'Tab' && inSearch && !event.shiftKey && item) { event.preventDefault(); setMode('actions'); setActionIndex(0); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      const how: How = event.ctrlKey || event.metaKey ? 'kiln' : event.shiftKey ? 'test' : 'default';
      if (loading && inSearch) setPending(how); else run(current, how);
    }
  };

  const itemCount = ranked.length, used = ranked.some(i => (snapshot?.usage[i.id]?.used ?? 0) > 0);
  return <div className="palette pal" onKeyDown={keyDown}>
    <div className="pal-search">
      {inActions ? <button type="button" className="pal-scope" onClick={() => { setMode('list'); input.current?.focus(); }} aria-label="Back to results"><ArrowLeft size={13} /><span>{item.title}</span></button> : <Search size={18} className="pal-search-icon" />}
      <input ref={input} aria-label="Quick search" placeholder={inActions ? 'Choose an action' : 'Search items, or type > for actions'} value={inActions ? '' : query} readOnly={Boolean(inActions)}
        onChange={e => setQuery(e.target.value)} role="combobox" aria-controls="palette-results" aria-expanded="true" aria-autocomplete="list"
        aria-activedescendant={inActions ? `pal-act-${itemActions[actionIndex]?.id}` : current ? (current.type === 'item' ? `pal-item-${current.item.id}` : `pal-action-${current.action.id}`) : undefined} />
      <button className="icon-button" aria-label="Close quick search" onClick={() => void api('desktop.hide')}><X size={17} /></button>
    </div>
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="pal-body">
      <div className="pal-results" role="listbox" id="palette-results" aria-label={inActions ? `Actions for ${item.title}` : 'Results'} aria-busy={loading} ref={list}>
        {inActions ? <div role="group" aria-labelledby="pal-actions-for">
          <div className="pal-section" id="pal-actions-for">Actions for this {item.kind}</div>
          {itemActions.map((action, i) => <button type="button" tabIndex={-1} id={`pal-act-${action.id}`} role="option" aria-selected={i === actionIndex} key={action.id} className={`pal-row action ${i === actionIndex ? 'on' : ''}`} onMouseMove={() => setActionIndex(i)} onClick={action.run}>
            <span className="pal-icon plain">{action.icon}</span><span className="pal-title">{action.label}</span></button>)}
        </div> : <>
          {itemCount > 0 && <div role="group" aria-label="Items" className={loading ? 'pal-stale' : ''}>
            <div className="pal-section" aria-hidden="true">{q ? 'Items' : used ? 'Items · most used' : 'Items'}<span className="pal-count">{loading ? 'searching…' : q && !capped ? itemCount : ''}</span></div>
            {close && <p className="pal-note" role="status">No exact matches — showing close matches</p>}
            {ranked.map((row, i) => <button type="button" tabIndex={-1} id={`pal-item-${row.id}`} role="option" aria-selected={selected === i} key={row.id} className={`pal-row ${selected === i ? 'on' : ''}`} onMouseMove={() => setSelected(i)} onClick={() => run({ type: 'item', item: row })}>
              <span className={`item-kind ${row.kind}`}><KindIcon kind={row.kind} size={15} /></span>
              <span className="pal-text"><span className="pal-title"><Highlight text={row.title} query={q} /></span><span className="pal-sub">{[kindLabel(row.kind), row.collection].filter(Boolean).join(' · ')}</span></span>
              <Badge status={row.status} />
            </button>)}
            {capped > 0 && <p className="pal-note">Showing the first {itemCount} of {capped}. Keep typing to narrow.</p>}
          </div>}
          {!itemCount && !loading && !actionsOnly && <p className="pal-none">{q ? <>No items match “{q}”.</> : 'Your library is empty. Capture something first.'}</p>}
          {actionsOnly && !actions.length && <p className="pal-none">No action matches “{q}”.</p>}
          {actions.length > 0 && <div role="group" aria-label="Actions">
            <div className="pal-section" aria-hidden="true">Actions</div>
            {actions.map((action, j) => { const i = itemCount + j; return <button type="button" tabIndex={-1} id={`pal-action-${action.id}`} role="option" aria-selected={selected === i} aria-disabled={action.disabled} key={action.id} className={`pal-row action ${selected === i ? 'on' : ''} ${action.disabled ? 'disabled' : ''}`} onMouseMove={() => setSelected(i)} onClick={() => run({ type: 'action', action })}>
              <span className="pal-icon plain">{action.icon}</span><span className="pal-title"><Highlight text={action.label} query={q} /></span></button>; })}
          </div>}
        </>}
      </div>
      <section className="pal-preview" aria-label="Preview" ref={preview_}>
        {item ? <>
          <header className="pal-pv-head">
            <span className={`item-kind big ${item.kind}`}><KindIcon kind={item.kind} size={18} /></span>
            <div className="pal-pv-title"><h2>{item.title}</h2><div className="pal-sub">{[kindLabel(item.kind), item.collection].filter(Boolean).join(' · ')}{snapshot?.usage[item.id]?.copied ? ` · copied ${snapshot.usage[item.id].copied}×` : ''}</div></div>
            <Badge status={item.status} />
          </header>
          {variables.length > 0 && <div className="pal-vars" aria-label="Variables">
            {variables.map(name => <label key={name} className="pal-var"><span>{`{{${name}}}`}</span>
              <input value={filled[name] ?? ''} placeholder={`Leave blank to keep {{${name}}}`} onChange={e => { const value = e.target.value; setValues(state => ({ ...state, [item.id]: { ...state[item.id], [name]: value } })); }} /></label>)}
          </div>}
          <div className="pal-content">{detail ? (() => {
            const { header, body } = frontMatter(resolveVariables(detail.revision.content, filled));
            return <>{header.length > 0 && <dl className="pal-front">{header.map((line, i) => { const [key, ...rest] = line.split(':'); return <Fragment key={i}><dt>{rest.length ? key : ''}</dt><dd>{rest.length ? rest.join(':').trim() : line}</dd></Fragment>; })}</dl>}
              {body.trim() ? <Markdown>{body}</Markdown> : !header.length && <p className="muted">{item.kind === 'image' ? 'An image. Enter copies it.' : 'No text content.'}</p>}</>;
          })() : <p className="muted">Loading preview…</p>}</div>
          <div className="pal-pv-foot"><CornerDownLeft size={13} />{defaultAction(item) === 'copy' ? (variables.length ? `Enter copies it with ${Object.values(filled).filter(v => v.trim()).length} of ${variables.length} variables filled` : 'Enter copies it') : defaultAction(item) === 'link' ? 'Enter opens the link in your browser' : 'Enter opens it in Kiln'}</div>
        </> : current?.type === 'action' ? <div className="pal-action-preview">
          <span className="pal-action-icon">{current.action.icon}</span>
          <h2>{current.action.label}</h2>
          <p className="muted">{current.action.detail}</p>
          {current.action.affects && current.action.affects.length > 0 && <div className="pal-affects"><div className="pal-section flat">Will install</div>{current.action.affects.map(line => <div key={line} className="pal-affect"><ChevronRight size={13} />{line}</div>)}</div>}
        </div> : <p className="muted pal-empty">Select a result to preview it.</p>}
      </section>
    </div>
    <div className="pal-footer">
      {inActions ? <><Key keys={['↑', '↓']} label="Move" onClick={() => setActionIndex(i => Math.min(itemActions.length - 1, i + 1))} /><Key keys={['↵']} label="Run" onClick={() => itemActions[actionIndex]?.run()} /><span className="pal-grow" /><Key keys={['Esc']} label="Back" onClick={() => { setMode('list'); input.current?.focus(); }} /></>
        : item ? <><Key keys={['↵']} label={defaultVerb(item)} onClick={() => run(current)} />{defaultAction(item) !== 'kiln' && <Key keys={['Ctrl', '↵']} label="Open in Kiln" onClick={() => run(current, 'kiln')} />}{item.kind !== 'source' && <Key keys={['Shift', '↵']} label="Test" onClick={() => run(current, 'test')} />}<Key keys={['Tab']} label="Actions" onClick={() => { setMode('actions'); setActionIndex(0); input.current?.focus(); }} /><span className="pal-grow" /><Key keys={['Esc']} label="Close" onClick={() => void api('desktop.hide')} /></>
        : <>{current?.type === 'action' && <Key keys={['↵']} label="Run" onClick={() => run(current)} />}<span className="pal-grow" /><Key keys={['Esc']} label="Close" onClick={() => void api('desktop.hide')} /></>}
    </div>
    {copied !== null && <div className="pal-copied" role="status"><Check size={16} />Copied <b>{copied}</b></div>}
  </div>;
}
