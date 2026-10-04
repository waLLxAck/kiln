import { useDeferredValue, useState, type KeyboardEvent } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FilePlus2, FolderOpen, FolderPlus, Plug, Plus, RefreshCw, Search, ShieldCheck, Terminal, TriangleAlert, Webhook, X, type LucideIcon } from 'lucide-react';
import type { HomeFile, HomeFileKind, HomeList } from '../../../packages/home/service';
import { agentLabel, agentOrder, purposeLabel, purposeOf, scopeName, type Purpose } from './configModel';

export const purposeIcon: Record<Purpose, LucideIcon> = { instructions: BookOpen, settings: ShieldCheck, hooks: Webhook, mcp: Plug, profile: Terminal };
export const bytes = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const chips: Purpose[] = ['instructions', 'settings', 'hooks', 'mcp'];
const shortDate = (value: string) => { const when = new Date(value); return when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(when.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }); };
function stored(key: string): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); } }

type Props = { files: HomeList | null; /** Reading the list failed; the main pane says why and offers Retry. */ failed?: boolean; selected: string; onSelect: (key: string) => void; onCreate: (file: HomeFile) => void; hasDraft: (key: string) => boolean; onRefresh: () => void; onAddProject: () => void; onAddFile: () => void };

/** The Config files tree: agent → scope → file, one line each. Files that do not exist yet fold into "N not created" per agent. */
export function ConfigTree({ files, failed = false, selected, onSelect, onCreate, hasDraft, onRefresh, onAddProject, onAddFile }: Props) {
  const [query, setQuery] = useState('');
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [collapsed, setCollapsed] = useState(() => stored('kiln-config-collapsed'));
  const [showMissing, setShowMissing] = useState<Set<string>>(new Set());
  const filter = useDeferredValue(query.trim().toLowerCase());
  const all = files?.files ?? [];
  const home = files?.home ?? '';
  // Every word must match somewhere: agent, scope, name, path, purpose or description.
  const matched = all.filter(file => { const text = `${file.kind} ${agentLabel[file.kind]} ${scopeName(file.scope)} ${file.label} ${file.path} ${purposeLabel[purposeOf(file)]} ${file.description}`.toLowerCase(); return filter.split(/\s+/).every(word => text.includes(word)); });
  const visible = purpose ? matched.filter(file => purposeOf(file) === purpose) : matched;
  const present = all.filter(file => file.exists).length;
  const projects = new Set(all.flatMap(file => file.scope?.startsWith('Project') ? [file.scope] : [])).size;
  const toggle = (set: Set<string>, value: string) => { const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); return next; };
  const collapse = (kind: string) => { const next = toggle(collapsed, kind); setCollapsed(next); localStorage.setItem('kiln-config-collapsed', JSON.stringify([...next])); };
  const selectedFile = all.find(file => file.key === selected);
  // Arrow keys move between rows, like a file tree.
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-row]')];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { event.preventDefault(); next.focus(); }
  };
  const row = (file: HomeFile, missing = false) => {
    const Icon = file.error ? TriangleAlert : purposeIcon[purposeOf(file)];
    const draft = hasDraft(file.key);
    return <div key={file.key} className={`cfg-row ${selected === file.key ? 'active' : ''} ${missing ? 'ghost' : ''} ${file.error ? 'blocked' : ''}`}>
      <button data-row className="cfg-file" onClick={() => onSelect(file.key)} title={file.path.replace(home, '~')} aria-current={selected === file.key ? 'true' : undefined}>
        <Icon size={14} className="cfg-ficon" aria-hidden="true" />
        <span className="cfg-fname">{file.label}{missing && file.scope?.startsWith('Project') && <small>{scopeName(file.scope)}</small>}</span>
        {draft && <span className="cfg-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
        {!missing && <span className="cfg-fmeta">{file.error ? 'Blocked' : `${bytes(file.size)} · ${shortDate(file.modifiedAt!)}`}</span>}
      </button>
      {missing && <button className="cfg-create" title={`Create ${file.label} from a starter template`} aria-label={`Create ${file.label} from template`} onClick={() => onCreate(file)}><FilePlus2 size={12} />Create</button>}
    </div>;
  };
  return <>
    <div className="cfg-treehead">
      <h2>Config files</h2><span className="muted small">{files ? `${present} files${projects ? ` · ${projects} project${projects === 1 ? '' : 's'}` : ''}` : ''}</span>
      <button className="icon-button" aria-label="Refresh file list" title="Refresh" onClick={onRefresh}><RefreshCw size={15} /></button>
    </div>
    <label className="cfg-filter"><Search size={14} aria-hidden="true" /><input aria-label="Filter config files" placeholder="Filter by agent, path or purpose" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }} />{query && <button className="icon-button" aria-label="Clear filter" onClick={() => setQuery('')}><X size={13} /></button>}</label>
    <div className="cfg-chips" role="group" aria-label="Filter by purpose">
      {chips.map(p => { const Icon = purposeIcon[p]; return <button key={p} className={`chip ${purpose === p ? 'active' : ''}`} aria-pressed={purpose === p} onClick={() => setPurpose(purpose === p ? null : p)}><Icon size={12} aria-hidden="true" />{purposeLabel[p]}<span>{matched.filter(file => file.exists && purposeOf(file) === p).length}</span></button>; })}
    </div>
    <div className="cfg-list" onKeyDown={onKey}>
      {agentOrder.map(kind => {
        const group = visible.filter(file => file.kind === kind);
        if (!group.length) return null;
        const real = group.filter(file => file.exists || file.error), missing = group.filter(file => !file.exists && !file.error);
        const open = !collapsed.has(kind) || !!filter;
        const missingOpen = showMissing.has(kind) || !!filter || (selectedFile?.kind === kind && !selectedFile.exists && !selectedFile.error);
        const scopes = [...new Set(real.map(file => file.scope ?? 'Personal'))];
        const headings = kind !== 'custom' && kind !== 'powershell';
        return <div key={kind} className="cfg-group">
          <button data-row className="cfg-agent" aria-expanded={open} onClick={() => collapse(kind)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<b>{agentLabel[kind as HomeFileKind]}</b><span className="cfg-count" title={`${real.length} existing, ${missing.length} not created`}>{real.length}</span></button>
          {open && <div className="cfg-children">
            {scopes.map(scope => { const here = real.filter(file => (file.scope ?? 'Personal') === scope); return <div key={scope} className="cfg-scope">
              {headings && <div className="cfg-scopename" title={scope.replace(/^Project · /, '')}>{scope.startsWith('Project') && <FolderOpen size={12} aria-hidden="true" />}{scopeName(scope)}</div>}
              {here.map(file => row(file))}
            </div>; })}
            {missing.length > 0 && <div className="cfg-missing">
              <button data-row className="cfg-missingtoggle" aria-expanded={missingOpen} onClick={() => setShowMissing(toggle(showMissing, kind))}>{missingOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{missing.length} not created</button>
              {missingOpen && missing.map(file => row(file, true))}
            </div>}
          </div>}
        </div>;
      })}
      {files && !visible.length && <div className="cfg-none">{all.length ? 'No files match this filter.' : 'No files found.'}</div>}
      {!files && !failed && <div className="cfg-none">Reading your home folder…</div>}
    </div>
    <div className="cfg-treefoot">
      <button className="button" onClick={onAddProject} title="Lists a project's CLAUDE.md, AGENTS.md, settings, hooks and MCP files"><FolderPlus size={14} />Add project folder</button>
      <button className="button" onClick={onAddFile} title="Any text file: another profile, a hook script, an editor's settings"><Plus size={14} />Add another file</button>
    </div>
  </>;
}
