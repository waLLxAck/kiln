import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { Activity, Archive, BarChart3, ChevronDown, ChevronRight, Download, FileCog, FlaskConical, Folder, Inbox, Layers3, Monitor, Moon, PencilLine, Plus, Settings, ShieldCheck, Sun, Trash2 } from 'lucide-react';
import { ancestorsOf, depthOf, leafOf } from '../../../packages/domain/collections';
import { CollectionNameInput, type useCollectionDrag } from './Collections';
import type { useItemDrag } from './ItemDrag';
import { KilnMark } from './components';
import { stages, type RailCounts, type Stage } from './library-filters';
import './shell.css';

/** Collection filter for items outside every collection. Not a valid collection name, so it cannot clash with one. */
export const UNFILED = '\u0000unfiled';
const stageIcon: Record<Stage, ReactNode> = { drafts: <PencilLine size={16} />, testing: <FlaskConical size={16} />, approved: <ShieldCheck size={16} />, installed: <Download size={16} /> };
export const tools = [{ id: 'experiments', label: 'Experiments', icon: FlaskConical }, { id: 'home', label: 'Config files', icon: FileCog }, { id: 'machines', label: 'Machines', icon: Monitor }, { id: 'activity', label: 'Activity', icon: Activity }, { id: 'usage', label: 'Usage', icon: BarChart3 }];

type Props = {
  style: CSSProperties; theme: string; onTheme: () => void;
  /** Where the library points now. */
  section: string; collection: string; stage: Stage | '';
  collections: string[]; counts: RailCounts;
  collapsed: string[]; onToggle: (name: string) => void; drag: ReturnType<typeof useCollectionDrag>;
  /** Library rows dragged onto a collection, or onto Unfiled, are filed there. */
  itemDrag: ReturnType<typeof useItemDrag>;
  renaming: string | null; onRename: (from: string, to: string) => Promise<unknown>; onRenaming: (name: string | null) => void; onError: (message: string) => void;
  onNavigate: (section: string) => void; onStage: (stage: Stage) => void; onCollection: (name: string) => void; onNewCollection: () => void; onCollectionMenu: (event: MouseEvent, name: string) => void;
};

/**
 * The left rail, grouped by what you are doing: the whole library, its lifecycle stages, your collections, the archive and
 * trash, then the tools. Collections keep their tree: nest and reorder by dragging, rename in place with F2, right-click for more.
 * Library rows dropped on a collection or on Unfiled move there; Unfiled shows up while rows are dragged even when it is empty.
 */
export function Rail({ style, theme, onTheme, section, collection, stage, collections, counts, collapsed, onToggle, drag, itemDrag, renaming, onRename, onRenaming, onError, onNavigate, onStage, onCollection, onNewCollection, onCollectionMenu }: Props) {
  const libraryView = ['library', 'archive', 'trash'].includes(section);
  const { library: inLibrary, unfiled } = counts;
  const nested = collections.some(c => c.includes('/'));
  return <aside className="sidebar" style={style}>
    <div className="brand-row"><button className="brand" onClick={() => onNavigate('library')}><span className="brand-symbol"><KilnMark /></span><span>Kiln</span></button><button className="icon-button" aria-label="Toggle theme" title="Switch between light and dark" onClick={onTheme}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button></div>
    <nav aria-label="Main navigation" className="rail-nav">
      <button onClick={() => onNavigate('library')} className={`nav-item ${section === 'library' && !collection && !stage ? 'active' : ''}`} title="Everything in the library. Archived, rejected and trashed items are not counted."><Layers3 size={17} /><span>Library</span>{inLibrary > 0 && <span className="nav-count" aria-hidden="true">{inLibrary}</span>}</button>
      <div className="sidebar-label">Stages</div>
      <div className="rail-stages">{stages.map((s, index) => <div key={s.id} className="rail-stage"><span className={`rail-rung ${index === 0 ? 'first' : ''} ${index === stages.length - 1 ? 'last' : ''}`} aria-hidden="true" />
        <button className={`nav-item ${section === 'library' && stage === s.id ? 'active' : ''}`} onClick={() => onStage(s.id)} title={s.hint}>{stageIcon[s.id]}<span>{s.label}</span><small aria-hidden="true">{counts.stages[s.id] || ''}</small></button>
      </div>)}</div>
      <div className="sidebar-label collection-label" {...drag.top}>Collections<button className="icon-button" aria-label="New collection" title="New collection; drop a collection here to move it to the top level" onClick={onNewCollection}><Plus size={13} /></button></div>
      {collections.filter(c => !ancestorsOf(c).some(a => collapsed.includes(a))).map(c => { const parent = collections.some(n => n.startsWith(c + '/')), open = !collapsed.includes(c); return <div className="collection-node" key={c} style={{ paddingLeft: depthOf(c) * 14 }} {...itemDrag.target(c, drag.row(c, renaming !== c))}>
        {nested && (parent ? <button className="collection-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} ${c}`} aria-expanded={open} onClick={() => onToggle(c)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button> : <span className="collection-toggle" aria-hidden="true" />)}
        {renaming === c ? <div className="nav-item collection-rename"><Folder size={16} /><CollectionNameInput name={c} onRename={to => onRename(c, to)} onDone={() => onRenaming(null)} onError={onError} /></div>
          : <button className={`nav-item ${collection === c && libraryView ? 'active' : ''}`} onClick={() => onCollection(c)} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); onRenaming(c); } }} onContextMenu={event => { event.preventDefault(); onCollectionMenu(event, c); }} title={parent ? `Show “${c}” and its subfolders in the library` : `Show only “${c}” in the library`}><Folder size={16} /><span>{leafOf(c)}</span><small>{counts.collections.get(c) ?? 0}</small></button>}
      </div>; })}
      {(unfiled > 0 || collection === UNFILED || itemDrag.active) && <button className={`nav-item ${collection === UNFILED && libraryView ? 'active' : ''}`} {...itemDrag.target('')} onClick={() => onCollection(UNFILED)} title="Items outside every collection. They also show in the whole library."><Inbox size={16} /><span>Unfiled</span><small>{unfiled || ''}</small></button>}
      <div className="rail-gap" />
      <button className={`nav-item ${section === 'archive' ? 'active' : ''}`} onClick={() => onNavigate('archive')}><Archive size={16} /><span>Archive</span><small aria-hidden="true">{counts.archive || ''}</small></button>
      <button className={`nav-item ${section === 'trash' ? 'active' : ''}`} onClick={() => onNavigate('trash')}><Trash2 size={16} /><span>Trash</span><small aria-hidden="true">{counts.trash || ''}</small></button>
      <div className="rail-tools">
        {tools.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => onNavigate(id)} className={`nav-item ${section === id ? 'active' : ''}`}><Icon size={17} /><span>{label}</span></button>)}
        <button className={`nav-item ${section === 'settings' ? 'active' : ''}`} onClick={() => onNavigate('settings')}><Settings size={17} /><span>Settings & repository</span></button>
      </div>
    </nav>
  </aside>;
}
