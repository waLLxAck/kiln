import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import { ArrowRight, ChevronDown, ExternalLink, FilePlus2, FolderOpen, History, Library, RefreshCw, RotateCcw, Trash2, TriangleAlert, X } from 'lucide-react';
import type { HomeBackup, HomeFile, HomeFileContent, HomeFileKind, HomeList } from '../../../packages/home/service';
import { api, date, fileManager } from './api';
import { Modal } from './components';
import { LoadError, Waiting } from './Loading';
import { focusReloads } from './load-state';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { ConfigTree, bytes, purposeIcon } from './ConfigTree';
import { HooksEditor, PermissionsEditor, type Apply } from './Permissions';
import { agentLabel, countSettingsChanges, isClaudeSettings, parseSettings, purposeLabel, purposeOf, scopeName } from './configModel';
import './config.css';
import { CodeEditor as CodeMirrorEditor } from './CodeEditor';
import { languageFor, type CodeLanguage } from './code-language';
import { insertInstruction } from '../../../packages/agent/distill';
import type { InstructionAppend } from './AddToInstructions';

type Props = { perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; /** Set when an instruction item's “Add to …” opened this view: the file to open and the snippet to add to its draft. */ append?: InstructionAppend | null; /** Re-reads the library after a copy is saved into it. */ refresh: () => Promise<void>; onOpenLibrary: (id: string) => void };
type Tab = 'permissions' | 'hooks' | 'raw';
const templates: Record<HomeFileKind, string> = {
  claude: '# Instructions for Claude Code\n\nThese apply in every project.\n\n<!-- A line starting with @ imports another file, for example: -->\n<!-- @~/AGENTS.md -->\n',
  agents: '# Instructions for coding agents\n\nThese apply in every project.\n',
  codex: '# Instructions for Codex\n\nThese apply in every project.\n',
  powershell: '# PowerShell profile\n# Runs every time this shell starts. Keep it fast.\n',
  copilot: '# Instructions for Copilot\n',
  vscode: '{}\n',
  custom: '',
};
const templateFor = (file: HomeFile) => file.template ?? templates[file.kind];
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
/** Groups of changed lines between two texts: the plain editor's change count. */
function changeBlocks(before: string, after: string) {
  let blocks = 0, inChange = false;
  for (const part of diffLines(before, after)) { const changed = Boolean(part.added || part.removed); if (changed && !inChange) blocks++; inChange = changed; }
  return blocks;
}
const plainError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^[A-Z_]+: /, '');
const formatName = (file: string) => /\.md$/i.test(file) ? 'Markdown' : /\.jsonc?$/i.test(file) ? 'JSON · checked on save' : /\.toml$/i.test(file) ? 'TOML · checked on save' : /\.ps1$/i.test(file) ? 'PowerShell' : 'Text';

/** The Config files tab: instructions, settings, hooks and shell profiles agents read, edited in place with private backups. */
export function HomeFilesView({ perform, refresh, onOpenLibrary, append }: Props) {
  const list = usePanelWidth('kiln-home-list-width', 340, 260, 520);
  const [files, setFiles] = useState<HomeList | null>(null);
  const [selected, setSelected] = useState(append?.key ?? localStorage.getItem('kiln-home-selected') ?? 'claude-global');
  const pendingAppend = useRef<InstructionAppend | null>(null);
  const [loaded, setLoaded] = useState<HomeFileContent | null>(null);
  const [editingEmpty, setEditingEmpty] = useState(false);
  const loadSequence = useRef(0);
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState<string | null>(null);
  const [backups, setBackups] = useState<HomeBackup[] | null>(null);
  const [compare, setCompare] = useState<{ name: string; content: string } | null>(null);
  const [removing, setRemoving] = useState<HomeFile | null>(null);
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>('permissions');
  // Reading the list and the chosen file: failures show in place with Retry, never as an endless "Reading…".
  const [listError, setListError] = useState(''), [reading, setReading] = useState<number | null>(null), [readError, setReadError] = useState('');
  const listRead = useRef(0);
  const reloadList = useCallback(async () => { listRead.current = Date.now(); try { setFiles(await api<HomeList>('home.list')); setListError(''); } catch (e) { setListError(plainError(e)); throw e; } }, []);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const loadBackups = useCallback(async (key: string) => { const found = await api<HomeBackup[]>('home.backups', { key }); if (selectedRef.current === key) setBackups(found); }, []);
  const load = useCallback(async (key: string, fresh = false) => {
    const sequence = ++loadSequence.current;
    setLoaded(null); setEditingEmpty(false); setSaveError(''); setReadError(''); setReading(Date.now());
    let content: HomeFileContent;
    try { content = await api<HomeFileContent>('home.read', { key }, { fresh }); }
    catch (e) { if (sequence === loadSequence.current) { setReadError(plainError(e)); setReading(null); } throw e; }
    if (sequence !== loadSequence.current) return;
    setReading(null); setLoaded(content); setBackups(null); setCompare(null);
    const saved = savedDraft(key);
    // A private draft survives restarts; it is dropped only when it matches what is on disk.
    const start = saved && saved.content !== content.content ? saved : { content: content.content, base: content.hash };
    if (start.content === content.content) localStorage.removeItem(draftKey(key));
    // An instruction item's snippet joins the draft, never the file: the user reviews it and saves (or discards) here.
    const add = pendingAppend.current?.key === key ? pendingAppend.current : null;
    if (add) pendingAppend.current = null;
    const added = add ? insertInstruction(start.content, add.text, add.section) : null;
    setDraft(added?.text ?? start.content); setBase(start.base);
    if (add && added) void perform(async () => undefined, `${added.heading ? `Added under “${added.heading}”` : 'Added at the end'} as an unsaved edit. Review it, then save.`);
    void loadBackups(key).catch(() => undefined);
  }, [loadBackups]);
  useEffect(() => { void reloadList().catch(() => undefined); }, []);
  // Declared before the load below, so the snippet is waiting when the chosen file is read.
  useEffect(() => { if (!append) return; pendingAppend.current = append; if (selectedRef.current === append.key) void load(append.key).catch(() => undefined); else setSelected(append.key); }, [append?.at]);
  useEffect(() => { localStorage.setItem('kiln-home-selected', selected); void load(selected).catch(() => undefined); }, [selected, load]);
  useEffect(() => { const onFocus = () => { if (focusReloads(Date.now(), listRead.current, document.visibilityState === 'hidden')) void reloadList().catch(() => undefined); }; window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus); }, [reloadList]);
  const current = files?.files.find(f => f.key === selected);
  const dirty = loaded !== null && draft !== loaded.content;
  useEffect(() => { if (!loaded) return; if (dirty) localStorage.setItem(draftKey(loaded.key), JSON.stringify({ content: draft, base })); else localStorage.removeItem(draftKey(loaded.key)); }, [draft, dirty, base, loaded]);
  useEffect(() => { setSaveError(''); }, [draft]);
  // The list refreshes on focus; when the file on disk moved on and nothing is being edited, follow it silently.
  const changedOnDisk = Boolean(loaded && current && current.hash !== loaded.hash);
  useEffect(() => { if (changedOnDisk && !dirty) void load(selected).catch(() => undefined); }, [changedOnDisk, dirty, selected, load]);

  // Claude Code settings files get Permissions and Hooks tabs. They edit the same JSON text the Raw tab shows.
  const structured = Boolean(current && isClaudeSettings(current));
  const counted = useDeferredValue(draft);
  const parsed = useMemo(() => structured ? parseSettings(counted) : null, [structured, counted]);
  const parsedSaved = useMemo(() => structured && loaded ? parseSettings(loaded.content) : null, [structured, loaded]);
  const changes = useMemo(() => {
    if (!loaded || counted === loaded.content) return 0;
    const settings = parsed?.ok && parsedSaved?.ok ? countSettingsChanges(parsedSaved.settings, parsed.settings) : 0;
    return settings || changeBlocks(loaded.content, counted);
  }, [loaded, counted, parsed, parsedSaved]);
  const liveParse = structured ? (counted === draft ? parsed : parseSettings(draft)) : null;
  const activeTab: Tab = liveParse && !liveParse.ok ? 'raw' : tab;
  const apply: Apply = edit => void perform(async () => { setDraft(edit(draft)); });

  const save = async (content = draft) => {
    if (!loaded) return;
    const creating = !loaded.exists;
    setSaving(true); setSaveError('');
    try {
      const result = await api<HomeFileContent>('home.save', { key: selected, expect: base, content });
      localStorage.removeItem(draftKey(selected)); setLoaded(result); setDraft(result.content); setBase(result.hash); setCompare(null); setEditingEmpty(false);
      await Promise.all([reloadList(), loadBackups(selected)]);
      void perform(async () => undefined, creating ? 'File created.' : 'Saved. Restart the relevant client or session to load changes.');
    } catch (error) { setSaveError(plainError(error)); } finally { setSaving(false); }
  };
  /** Creates a missing file from its starter template, from the tree or the empty file view. */
  const create = (file: HomeFile) => void perform(async () => {
    await api<HomeFileContent>('home.save', { key: file.key, expect: null, content: templateFor(file) });
    localStorage.removeItem(draftKey(file.key));
    await reloadList();
    if (file.key === selected) await load(file.key); else setSelected(file.key);
  }, `Created ${file.label} from the template.`);
  const discard = () => { if (!loaded) return; localStorage.removeItem(draftKey(selected)); setDraft(loaded.content); setBase(loaded.hash); setSaveError(''); };
  const pick = (name: string) => void perform(async () => { setCompare(await api<{ name: string; content: string }>('home.backup', { key: selected, name })); });
  const restore = (name: string) => void perform(async () => {
    const result = await api<HomeFileContent>('home.restore', { key: selected, name, expect: loaded?.hash ?? null });
    localStorage.removeItem(draftKey(selected)); setLoaded(result); setDraft(result.content); setBase(result.hash); setCompare(null);
    await Promise.all([reloadList(), loadBackups(selected)]);
  }, 'Previous version restored. The replaced text was kept too.');
  const addProject = () => void perform(async () => { const root = await api<string | null>('desktop.chooseDirectory'); if (!root) return; await api('home.addProject', { path: root }); await reloadList(); }, 'Project config files added');
  const addFile = () => void perform(async () => { const file = await api<string | null>('desktop.chooseFile'); if (!file) return; const { key } = await api<{ key: string }>('home.add', { path: file }); await reloadList(); setSelected(key); }, 'File added to the list');
  const copyToLibrary = () => void perform(async () => {
    const item = await api<{ id: string }>('items.create', { title: current?.label ?? 'Instruction file', kind: 'instruction', content: draft, description: `Copy of ${current?.label ?? 'instruction file'}`, tags: [], collection: 'Personal', source: `home:${loaded?.path ?? ''}`, licence: 'Personal', files: {} });
    await refresh(); onOpenLibrary(item.id);
  }, 'Saved a copy into the library as an instruction');
  const onKey = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (dirty && loaded && !saving) void save(); }
    if (event.key === 'Escape' && compare) { event.preventDefault(); setCompare(null); }
  };
  const linked = loaded && current && current.kind === 'claude' && /\.md$/i.test(current.path) ? imports(draft).map(spec => { const target = resolveImport(spec, loaded.path, files!.home); return { spec, file: files!.files.find(f => f.path.replaceAll('/', '\\').toLowerCase() === target) }; }) : [];
  const hasDraft = (key: string) => key === selected ? dirty : savedDraft(key) !== null;
  const editable = Boolean(loaded && (loaded.exists || dirty || editingEmpty));
  const PurposeIcon = current ? purposeIcon[purposeOf(current)] : null;

  return <div className="library-layout cfg-layout">
    <section className="cfg-tree" style={{ ...list.style, maxWidth: 'calc(100% - 420px)' }} aria-label="Config files">
      <ConfigTree files={files} failed={Boolean(listError)} selected={selected} onSelect={setSelected} onCreate={create} hasDraft={hasDraft} onRefresh={() => void perform(reloadList)} onAddProject={addProject} onAddFile={addFile} />
    </section><ResizeHandle panel={list} label="Resize file list" />
    {current && loaded && PurposeIcon ? <article className="cfg-main" aria-label="Selected file" onKeyDown={onKey}>
      <header className="cfg-head">
        <div className="cfg-headtext">
          <div className="eyebrow"><PurposeIcon size={13} aria-hidden="true" />{agentLabel[current.kind]}<span className="cfg-dot">·</span>{current.kind === 'custom' ? 'Added file' : scopeName(current.scope)}<span className="cfg-dot">·</span>{purposeLabel[purposeOf(current)]}</div>
          <div className="cfg-title"><h1>{current.label}</h1>{!loaded.exists && !dirty && <span className="badge missing">not created</span>}</div>
          <code className="path-text">{loaded.path}</code>
          <p className="cfg-lede">{current.description}</p>
        </div>
        <div className="cfg-headactions">
          {loaded.exists && <BackupsMenu backups={backups} comparing={compare?.name ?? null} dirty={dirty} onCompare={pick} onRestore={restore} />}
          {loaded.exists && <button className="button" onClick={() => void perform(() => api('desktop.revealHomeFile', { key: selected }))} title={`Show the file in ${fileManager}`}><FolderOpen size={15} />Show in folder</button>}
          {loaded.exists && current.kind !== 'powershell' && <button className="icon-button" aria-label="Open" onClick={() => void perform(() => api('desktop.revealHomeFile', { key: selected, open: true }))} title="Open in the default app for this file type"><ExternalLink size={16} /></button>}
          {(current.instruction ?? /\.md$/i.test(current.path)) && (loaded.exists || dirty) && <button className="button" onClick={copyToLibrary} title="Store a copy as an instruction item, so it can be versioned, approved and installed into project folders."><Library size={15} />Copy to library</button>}
          {current.removable && <button className="icon-button" aria-label="Remove from list" title="Remove from this list. The file itself stays." onClick={() => setRemoving(current)}><X size={17} /></button>}
        </div>
      </header>
      {current.error && <div className="notice warning cfg-notice"><TriangleAlert size={15} /> {current.error}</div>}
      {changedOnDisk && dirty && <div className="notice warning cfg-notice"><b>This file changed on disk while you were editing.</b><p>Saving now would fail. Reload to see the new text, or copy your edits first.</p><button className="text-button" onClick={() => void perform(() => load(selected))}><RefreshCw size={13} />Reload from disk</button></div>}
      {linked.length > 0 && <div className="home-imports cfg-imports"><span className="muted small">Imports:</span>{linked.map(({ spec, file }) => file ? <button key={spec} className="chip" onClick={() => setSelected(file.key)} title={file.path}>@{spec}{!file.exists && ' · missing'} <ArrowRight size={12} /></button> : <span key={spec} className="chip" title="Not in this list; add it with Add another file to edit it here.">@{spec}</span>)}</div>}
      {(dirty || saveError) && <div className={`cfg-unsaved ${saveError || (liveParse && !liveParse.ok) ? 'invalid' : ''}`} role={saveError ? 'alert' : 'status'}>
        <span className="cfg-unsaveddot" aria-hidden="true" /><b>{changes || 1} change{(changes || 1) === 1 ? '' : 's'}</b>
        <span className="cfg-unsavedtext">{saveError || (liveParse && !liveParse.ok ? `Not valid JSON: ${liveParse.error}` : 'Save checks the syntax and keeps the current version as a backup.')}</span>
        <button className="button" onClick={discard} disabled={!dirty}>Discard</button>
        <button className="button primary" onClick={() => void save()} disabled={!dirty || saving} title="Ctrl+S">Save</button>
      </div>}
      <div className="cfg-body">
        {!editable ? <MissingFile file={current} onCreate={() => void save(templateFor(current))} onEmpty={() => { setEditingEmpty(true); setDraft(''); setBase(null); }} />
          : compare ? <section className="cfg-compare" aria-label="Compare with a backup">
            <div className="cfg-comparehead"><History size={15} aria-hidden="true" /><b>{date(backups?.find(b => b.name === compare.name)?.at ?? '')}</b><ArrowRight size={13} aria-hidden="true" /><b>now</b><span className="muted small">{dirty ? 'your unsaved text' : 'the file on disk'}</span>
              <span className="cfg-grow" /><button className="button" disabled={dirty} title={dirty ? 'Save or discard your changes first' : 'The current version is kept as a backup too'} onClick={() => restore(compare.name)}><RotateCcw size={14} />Restore this version</button><button className="icon-button" aria-label="Close comparison" onClick={() => setCompare(null)}><X size={16} /></button></div>
            <div className="diff cfg-diff">{diffLines(compare.content, draft).map((part, i) => <pre key={i} className={part.added ? 'added' : part.removed ? 'removed' : ''}>{part.value}</pre>)}</div>
          </section>
          : structured ? <>
            <div className="cfg-tabs" role="tablist" aria-label="Settings view">
              {([['permissions', 'Permissions', parsed?.ok && parsed.settings.rules ? parsed.settings.rules.allow.length + parsed.settings.rules.ask.length + parsed.settings.rules.deny.length : null], ['hooks', 'Hooks', parsed?.ok && parsed.settings.hooks ? parsed.settings.hooks.length : null], ['raw', 'Raw', null]] as const).map(([id, label, count]) =>
                <button key={id} role="tab" aria-selected={activeTab === id} className={activeTab === id ? 'active' : ''} disabled={id !== 'raw' && liveParse !== null && !liveParse.ok} title={id !== 'raw' && liveParse && !liveParse.ok ? 'Fix the JSON in Raw first' : undefined} onClick={() => setTab(id)}>{label}{count !== null && <span>{count}</span>}</button>)}
            </div>
            {liveParse && !liveParse.ok && <div className="notice warning cfg-notice"><TriangleAlert size={15} /> Permissions and Hooks are off until the JSON is valid again.</div>}
            {activeTab === 'permissions' && liveParse?.ok && (liveParse.settings.rules ? <PermissionsEditor rules={liveParse.settings.rules} saved={parsedSaved?.ok ? parsedSaved.settings.rules : null} other={liveParse.settings.otherPermissions} apply={apply} /> : <div className="notice warning cfg-notice">{liveParse.settings.rulesProblem} Edit it in Raw.</div>)}
            {activeTab === 'hooks' && liveParse?.ok && (liveParse.settings.hooks ? <HooksEditor rows={liveParse.settings.hooks} apply={apply} /> : <div className="notice warning cfg-notice">{liveParse.settings.hooksProblem} Edit it in Raw.</div>)}
            {activeTab === 'raw' && <CodeEditor key={current.key} label={current.label} value={draft} onChange={setDraft} language={languageFor(current.path, { comments: current.kind === 'vscode' })} />}
            <Status content={loaded} file={current.path} />
          </>
          : <><CodeEditor key={current.key} label={current.label} value={draft} onChange={setDraft} language={languageFor(current.path, { comments: current.kind === 'vscode' })} /><Status content={loaded} file={current.path} /></>}
      </div>
    </article> : <div className="welcome-pane"><div className="welcome-content">
      {!files && listError ? <LoadError error={`Couldn’t read your home folder: ${listError}`} onRetry={() => void reloadList().catch(() => undefined)} />
        : current && readError ? <LoadError error={`Couldn’t read ${current.label}: ${readError}`} onRetry={() => void load(selected, true).catch(() => undefined)} />
        : current && reading !== null ? <Waiting since={reading} label={`Reading ${current.label}`}>{`Reading ${current.label}…`}</Waiting>
        : <><h1>{files ? 'Pick a file to edit.' : 'Reading your home folder…'}</h1><p>Settings and instructions for Claude Code, Codex, GitHub Copilot and your shell.</p></>}
    </div></div>}
    {removing && <Modal title="Remove from this list?" subtitle={removing.label} onClose={() => setRemoving(null)}><code className="path-text">{removing.path}</code><p>The file stays where it is. Only Kiln's list entry and the versions Kiln kept for it are removed.</p><div className="modal-actions"><button className="button" onClick={() => setRemoving(null)}>Cancel</button><button className="button primary" onClick={() => void perform(async () => { await api('home.remove', { key: removing.key }); localStorage.removeItem(draftKey(removing.key)); setRemoving(null); if (selected === removing.key) setSelected('claude-global'); await reloadList(); }, 'Removed from the list; the file was not touched')}><Trash2 size={14} />Remove from list</button></div></Modal>}
  </div>;
}

/** The file's text in CodeMirror: line numbers, find and replace, highlighting for the file's language. */
function CodeEditor({ label, value, onChange, language }: { label: string; value: string; onChange: (value: string) => void; language?: CodeLanguage }) {
  return <CodeMirrorEditor className="home-code" value={value} onChange={onChange} language={language} ariaLabel={`${label} content`} />;
}

function Status({ content, file }: { content: HomeFileContent; file: string }) {
  return <div className="cfg-status"><span>{formatName(file)}</span>{content.exists && <><span>{bytes(content.size)}</span><span>Updated {date(content.modifiedAt!)}</span></>}<span title="Line endings are kept as they were on disk">{content.eol === 'crlf' ? 'CRLF' : 'LF'}{content.bom ? ' · BOM' : ''}</span></div>;
}

/** The "N backups" button: the private versions Kiln kept, each with Compare and Restore. */
function BackupsMenu({ backups, comparing, dirty, onCompare, onRestore }: { backups: HomeBackup[] | null; comparing: string | null; dirty: boolean; onCompare: (name: string) => void; onRestore: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const count = backups?.length ?? 0;
  return <div className="cfg-backups" ref={ref}>
    <button className="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}><History size={15} />{backups === null ? 'Backups' : `${count} backup${count === 1 ? '' : 's'}`}<ChevronDown size={13} /></button>
    {open && <div className="cfg-menu" role="dialog" aria-label="Private backups">
      <div className="cfg-menulabel">Private backups · last 30 kept</div>
      {!count ? <p className="muted small cfg-menuempty">Nothing yet. A version is kept every time you save over this file.</p>
        : <div className="cfg-backuplist">{backups!.map(backup => <div key={backup.name} className={`cfg-backup ${comparing === backup.name ? 'active' : ''}`}>
          <span title={backup.name}>{date(backup.at)}<small>{bytes(backup.size)}</small></span>
          <button className="text-button" onClick={() => { onCompare(backup.name); setOpen(false); }}>Compare</button>
          <button className="text-button" disabled={dirty} title={dirty ? 'Save or discard your changes first' : 'The current version is kept as a backup too'} onClick={() => { onRestore(backup.name); setOpen(false); }}>Restore</button>
        </div>)}</div>}
    </div>}
  </div>;
}

function MissingFile({ file, onCreate, onEmpty }: { file: HomeFile; onCreate: () => void; onEmpty: () => void }) {
  const template = templateFor(file);
  return <div className="cfg-template">
    <div className="cfg-templatehead"><b>Starter template</b><span className="muted small">{file.kind === 'powershell' ? 'Aliases, functions and a prompt that load whenever this shell starts.' : 'Creating the file does not run hooks or change a running session.'}</span><span className="cfg-grow" /><button className="text-button" onClick={onEmpty}>Start empty</button><button className="button primary" onClick={onCreate}><FilePlus2 size={14} />Create from template</button></div>
    <pre>{template || <span className="muted">(empty file)</span>}</pre>
  </div>;
}

