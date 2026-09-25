import { useCallback, useEffect, useRef, useState } from 'react';
import { diffLines } from 'diff';
import { ArrowRight, BookOpen, ChevronRight, ExternalLink, FileCog, FolderOpen, History, Library, Plus, RefreshCw, RotateCcw, Save, Terminal, Trash2, TriangleAlert, X } from 'lucide-react';
import type { HomeBackup, HomeFile, HomeFileContent, HomeFileKind, HomeList } from '../../../packages/home/service';
import { api, date } from './api';
import { Badge, Modal } from './components';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';

type Props = { perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; /** Re-reads the library after a copy is saved into it. */ refresh: () => Promise<void>; onOpenLibrary: (id: string) => void };
const kindIcon: Record<HomeFileKind, typeof Terminal> = { claude: BookOpen, agents: BookOpen, codex: BookOpen, copilot: BookOpen, vscode: FileCog, powershell: Terminal, custom: FileCog };
const kindLabel: Record<HomeFileKind, string> = { claude: 'Claude Code', agents: 'Shared', codex: 'Codex', copilot: 'GitHub Copilot', vscode: 'VS Code', powershell: 'PowerShell', custom: 'Added by you' };
const templates: Record<HomeFileKind, string> = {
  claude: '# Instructions for Claude Code\n\nThese apply in every project.\n\n<!-- A line starting with @ imports another file, for example: -->\n<!-- @~/AGENTS.md -->\n',
  agents: '# Instructions for coding agents\n\nThese apply in every project.\n',
  codex: '# Instructions for Codex\n\nThese apply in every project.\n',
  powershell: '# PowerShell profile\n# Runs every time this shell starts. Keep it fast.\n',
  copilot: '# Instructions for Copilot\n',
  vscode: '{}\n',
  custom: '',
};
const bytes = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const draftKey = (key: string) => `kiln-home-draft:${key}`;
function savedDraft(key: string): { content: string; base: string | null } | null {
  try { const value = JSON.parse(localStorage.getItem(draftKey(key)) ?? 'null'); return value && typeof value.content === 'string' ? value : null; } catch { return null; }
}
/** `@path` lines in a Markdown instruction file. Claude Code loads these when the file is read. */
function imports(content: string) { return [...content.matchAll(/^@(\S+)\s*$/gm)].map(m => m[1]); }
function resolveImport(spec: string, from: string, home: string) {
  const expanded = spec.startsWith('~/') || spec === '~' ? home.replace(/[\\/]+$/, '') + spec.slice(1) : spec;
  const absolute = /^([a-z]:)?[\\/]/i.test(expanded) ? expanded : `${from.replace(/[\\/][^\\/]*$/, '')}/${expanded}`;
  return absolute.replaceAll('/', '\\').toLowerCase();
}

/** The Config files tab: the instruction files agents read from your home folder and your shell profiles, edited in place with kept versions. */
export function HomeFilesView({ perform, refresh, onOpenLibrary }: Props) {
  const list = usePanelWidth('kiln-home-list-width', 360, 260, 560);
  const [files, setFiles] = useState<HomeList | null>(null);
  const [selected, setSelected] = useState(localStorage.getItem('kiln-home-selected') ?? 'claude-global');
  const [loaded, setLoaded] = useState<HomeFileContent | null>(null);
  const [filter, setFilter] = useState('');
  const [editingEmpty, setEditingEmpty] = useState(false);
  const loadSequence = useRef(0);
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState<string | null>(null);
  const [backups, setBackups] = useState<HomeBackup[] | null>(null);
  const [compare, setCompare] = useState<{ name: string; content: string } | null>(null);
  const [removing, setRemoving] = useState<HomeFile | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const reloadList = useCallback(async () => { setFiles(await api<HomeList>('home.list')); }, []);
  const load = useCallback(async (key: string) => {
    const sequence = ++loadSequence.current;
    setLoaded(null); setEditingEmpty(false);
    const content = await api<HomeFileContent>('home.read', { key });
    if (sequence !== loadSequence.current) return;
    setLoaded(content); setBackups(null); setCompare(null);
    const saved = savedDraft(key);
    // A private draft survives restarts; it is dropped only when it matches what is on disk.
    if (saved && saved.content !== content.content) { setDraft(saved.content); setBase(saved.base); } else { localStorage.removeItem(draftKey(key)); setDraft(content.content); setBase(content.hash); }
  }, []);
  useEffect(() => { void perform(reloadList); }, []);
  useEffect(() => { localStorage.setItem('kiln-home-selected', selected); void load(selected).catch(() => setLoaded(null)); }, [selected, load]);
  useEffect(() => { const onFocus = () => void reloadList().catch(() => undefined); window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus); }, [reloadList]);
  const current = files?.files.find(f => f.key === selected);
  const dirty = loaded !== null && draft !== loaded.content;
  useEffect(() => { if (!loaded) return; if (dirty) localStorage.setItem(draftKey(loaded.key), JSON.stringify({ content: draft, base })); else localStorage.removeItem(draftKey(loaded.key)); }, [draft, dirty, base, loaded]);
  // The list refreshes on focus; when the file on disk moved on and nothing is being edited, follow it silently.
  const changedOnDisk = Boolean(loaded && current && current.hash !== loaded.hash);
  useEffect(() => { if (changedOnDisk && !dirty) void load(selected).catch(() => undefined); }, [changedOnDisk, dirty, selected, load]);
  const save = (content = draft) => perform(async () => {
    const result = await api<HomeFileContent>('home.save', { key: selected, expect: base, content });
    localStorage.removeItem(draftKey(selected)); setLoaded(result); setDraft(result.content); setBase(result.hash); setBackups(null); setCompare(null); await reloadList();
  }, loaded?.exists ? 'Saved. Restart the relevant client or session to load changes.' : 'File created.');
  const discard = () => { if (!loaded) return; localStorage.removeItem(draftKey(selected)); setDraft(loaded.content); setBase(loaded.hash); };
  const showHistory = () => void perform(async () => { setBackups(await api<HomeBackup[]>('home.backups', { key: selected })); });
  const pick = (name: string) => void perform(async () => { setCompare(await api<{ name: string; content: string }>('home.backup', { key: selected, name })); });
  const restore = (name: string) => void perform(async () => {
    const result = await api<HomeFileContent>('home.restore', { key: selected, name, expect: loaded?.hash ?? null });
    localStorage.removeItem(draftKey(selected)); setLoaded(result); setDraft(result.content); setBase(result.hash); setBackups(await api<HomeBackup[]>('home.backups', { key: selected })); setCompare(null); await reloadList();
  }, 'Previous version restored. The replaced text was kept too.');
  const addProject = () => void perform(async () => { const root = await api<string | null>('desktop.chooseDirectory'); if (!root) return; await api('home.addProject', { path: root }); await reloadList(); }, 'Project config files added');
  const addFile = () => void perform(async () => { const file = await api<string | null>('desktop.chooseFile'); if (!file) return; const { key } = await api<{ key: string }>('home.add', { path: file }); await reloadList(); setSelected(key); }, 'File added to the list');
  const copyToLibrary = () => void perform(async () => {
    const item = await api<{ id: string }>('items.create', { title: current?.label ?? 'Instruction file', kind: 'instruction', content: draft, description: `Copy of ${current?.label ?? 'instruction file'}`, tags: [], collection: 'Personal', source: `home:${loaded?.path ?? ''}`, licence: 'Personal', files: {} });
    await refresh(); onOpenLibrary(item.id);
  }, 'Saved a copy into the library as an instruction');
  const onKey = (event: React.KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (dirty && loaded) void save(); } };
  const linked = loaded && current && current.kind === 'claude' && /\.md$/i.test(current.path) ? imports(draft).map(spec => { const target = resolveImport(spec, loaded.path, files!.home); return { spec, file: files!.files.find(f => f.path.replaceAll('/', '\\').toLowerCase() === target) }; }) : [];
  return <div className="library-layout">
    <section className="library-list" style={{ ...list.style, maxWidth: 'calc(100% - 300px)' }}>
      <div className="list-heading"><div><h2>Config files <span>{files?.files.length ?? ''}</span></h2></div><span className="inline"><button className="icon-button" aria-label="Refresh file list" onClick={() => void perform(reloadList)}><RefreshCw size={17} /></button></span></div>
      <p className="muted small home-intro">Instructions, permissions, hooks and tools for Claude, Codex and Copilot. Personal files and added projects are edited in place, with 30 private backups. Settings differ between CLI and IDE clients.</p>
      <input className="home-config-search" aria-label="Filter config files" placeholder="Filter by agent, path or purpose…" value={filter} onChange={e => setFilter(e.target.value)} /><div className="item-list">{files?.files.filter(file => `${file.kind} ${file.label} ${file.path} ${file.description} ${file.scope ?? ''}`.toLowerCase().includes(filter.toLowerCase())).map(file => { const Icon = kindIcon[file.kind]; return <button key={file.key} className={`item-card ${selected === file.key ? 'selected' : ''}`} onClick={() => setSelected(file.key)}><span className={`item-kind home-${file.kind}`}><Icon size={16} aria-hidden="true" /></span><span className="item-card-main"><span className="item-title">{file.label}{savedDraft(file.key) && file.key !== selected && <small className="draft-mark" title="Unsaved draft">draft</small>}</span><span className="item-subtitle"><span>{kindLabel[file.kind]} · {file.scope?.startsWith('Project') ? 'Project' : file.scope ?? 'Personal'}</span><span>·</span><span className="home-path">{file.path.replace(files.home, '~')}</span></span><span className="item-card-bottom">{file.error ? <Badge status="blocked" /> : file.exists ? <><Badge status="present" /><span>{bytes(file.size)} · {date(file.modifiedAt!)}</span></> : <Badge status="missing" />}</span></span><ChevronRight className="item-chevron" size={15} /></button>; })}{files && !files.files.length && <div className="list-empty"><p>No files found.</p></div>}</div>
      <div className="list-bottom"><button className="button" onClick={addProject}><FolderOpen size={16} />Add project folder</button><button className="import-zone" onClick={addFile}><Plus size={20} /><span>Add another file<small>A project's CLAUDE.md or AGENTS.md, a settings file, another profile</small></span></button></div>
    </section><ResizeHandle panel={list} label="Resize file list" />
    {current && loaded ? <article className="detail-pane home-pane" aria-label="Selected file" onKeyDown={onKey}>
      <header className="detail-heading"><div className="eyebrow">{(() => { const Icon = kindIcon[current.kind]; return <Icon size={14} />; })()}{kindLabel[current.kind]}</div><div className="title-row"><div><h1>{current.label}</h1><p className="item-lede">{current.description}</p></div>{current.removable && <button className="icon-button" aria-label="Remove from list" title="Remove from this list. The file itself stays." onClick={() => setRemoving(current)}><X size={18} /></button>}</div>
        <code className="path-text">{loaded.path}</code>
        <div className="detail-meta">{loaded.exists ? <><Badge status="present" /><span>{bytes(loaded.size)}</span><span>Updated {date(loaded.modifiedAt!)}</span><span title="Line endings are kept as they were on disk">{loaded.eol === 'crlf' ? 'CRLF' : 'LF'}{loaded.bom ? ' · BOM' : ''}</span></> : <><Badge status="missing" /><span className="muted">This file does not exist yet.</span></>}{dirty && <span className="draft-mark">unsaved changes</span>}</div>
        {current.error && <div className="notice warning"><TriangleAlert size={15} /> {current.error}</div>}
        {changedOnDisk && dirty && <div className="notice warning"><b>This file changed on disk while you were editing.</b><p>Saving now would fail. Reload to see the new text, or copy your edits first.</p><button className="text-button" onClick={() => void perform(() => load(selected))}><RefreshCw size={13} />Reload from disk</button></div>}
        <div className="detail-actions">
          {loaded.exists || dirty ? <button className="button primary" disabled={!dirty} onClick={() => void save()} title="Ctrl+S"><Save size={15} />Save</button> : <button className="button primary" onClick={() => void save((current.template ?? templates[current.kind]))}><Plus size={15} />Create file</button>}
          {dirty && <button className="button" onClick={discard}>Discard changes</button>}
          {loaded.exists && <><button className="button" onClick={() => void perform(() => api('desktop.revealHomeFile', { key: selected }))} title="Show the file in Explorer"><FolderOpen size={15} />Show in folder</button>{current.kind !== 'powershell' && <button className="button" onClick={() => void perform(() => api('desktop.revealHomeFile', { key: selected, open: true }))} title="Open in the default app for this file type"><ExternalLink size={15} />Open</button>}<button className="button" onClick={showHistory}><History size={15} />Previous versions</button></>}
          {(current.instruction ?? /\.md$/i.test(current.path)) && (loaded.exists || dirty) && <button className="button" onClick={copyToLibrary} title="Store a copy as an instruction item, so it can be versioned, approved and installed into project folders."><Library size={15} />Copy to library</button>}
        </div>
        {linked.length > 0 && <div className="home-imports"><span className="muted small">Imports:</span>{linked.map(({ spec, file }) => file ? <button key={spec} className="chip" onClick={() => setSelected(file.key)} title={file.path}>@{spec}{!file.exists && ' · missing'} <ArrowRight size={12} /></button> : <span key={spec} className="chip" title="Not in this list; add it with the button below the list to edit it here.">@{spec}</span>)}</div>}
      </header>
      <div className="home-editor-wrap">
        {loaded.exists || dirty || editingEmpty ? <textarea ref={editor} className="code-input editor home-editor" aria-label={`${current.label} content`} spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} /> : <div className="home-missing"><p>{current.kind === 'powershell' ? 'Create it to add aliases, functions and a prompt that load whenever this shell starts.' : 'Create this file to customize the scope shown above. Saving does not run hooks or change an active session.'}</p><button className="button" onClick={() => void save((current.template ?? templates[current.kind]))}><Plus size={15} />Create with a starter template</button><button className="text-button" onClick={() => { setEditingEmpty(true); setDraft(''); setBase(null); }}>Start empty</button></div>}
        {backups && <section className="content-section home-history"><div className="section-heading"><h3><History size={15} />Previous versions kept by Kiln</h3><button className="text-button" onClick={() => { setBackups(null); setCompare(null); }}>Close</button></div>
          {!backups.length ? <p className="muted small">Nothing yet. A version is kept every time you save over an existing file.</p> : <div className="revision-list">{backups.map(b => <button key={b.name} className={`revision-row ${compare?.name === b.name ? 'selected' : ''}`} onClick={() => pick(b.name)}><div><b>{date(b.at)}</b><span>{bytes(b.size)}</span></div><code>{b.name}</code></button>)}</div>}
          {compare && <><div className="section-heading"><h3>{date(backups.find(b => b.name === compare.name)?.at ?? '')} → now</h3><button className="button" onClick={() => restore(compare.name)}><RotateCcw size={14} />Restore this version</button></div><div className="diff">{diffLines(compare.content, draft).map((part, i) => <pre key={i} className={part.added ? 'added' : part.removed ? 'removed' : ''}>{part.value}</pre>)}</div></>}
        </section>}
      </div>
    </article> : <div className="welcome-pane"><div className="welcome-content"><h1>{files ? 'Pick a file to edit.' : 'Reading your home folder…'}</h1><p>Settings and instructions for Claude Code, Codex, GitHub Copilot and your shell.</p></div></div>}
    {removing && <Modal title="Remove from this list?" subtitle={removing.label} onClose={() => setRemoving(null)}><code className="path-text">{removing.path}</code><p>The file stays where it is. Only Kiln's list entry and the versions Kiln kept for it are removed.</p><div className="modal-actions"><button className="button" onClick={() => setRemoving(null)}>Cancel</button><button className="button primary" onClick={() => void perform(async () => { await api('home.remove', { key: removing.key }); localStorage.removeItem(draftKey(removing.key)); setRemoving(null); if (selected === removing.key) setSelected('claude-global'); await reloadList(); }, 'Removed from the list; the file was not touched')}><Trash2 size={14} />Remove from list</button></div></Modal>}
  </div>;
}
