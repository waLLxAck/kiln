import { experimentsOf } from './trial-verdicts';
import { trialPlaces } from './trial-place';
import { Markdown } from './Markdown';
import { useScrollMemory } from './view-memory';
import { AgentPanel, AgentStatus, AnalysisRecord, agentStarted } from './AgentPanel';
import type { AgentJob, AgentKind } from '../../../packages/agent/service';
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CircleArrowUp, Copy, Download, ExternalLink, FileInput, FlaskConical, Folder, Hash, MessageSquare, MoreHorizontal, Paperclip, Pencil, Plus, RotateCcw, ScanSearch, ShieldCheck, Sparkles, Star, Trash2, TriangleAlert, ZoomIn } from 'lucide-react';
import type { Installation, Item, ItemDetail, Provider, ProviderId, Snapshot, Trial } from '../../../packages/protocol/schema';
import { statusLabel } from './library-filters';
import { api, date, variablesIn } from './api';
import { isTextFile } from '../../../packages/domain/text';
import { Badge, ContextMenu, Field, KindIcon, Lightbox, imageFile, imageSource, statusHelp, type MenuEntry } from './components';
import { personalTarget } from './Skills';
import { ExperimentsGrid } from './Experiments';
import { SourcePage } from './SourcePage';
import { History } from './History';
import { ItemRail } from './ItemRail';
import { DeployDialog } from './dialogs';
import { buildHistory } from './history-model';
import { changedCopiesLabel, outdatedCopies, primaryAction, splitFrontMatter, updateInstallsLabel, type PrimaryAction } from './item-page';
import { CodeEditor } from './CodeEditor';
import { itemLanguage } from './code-language';
import { OPEN_RESULT_TAB_EVENT } from './Runs';
import './item.css';

type Props = {
  jobs: AgentJob[]; detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; /** Where this item came from, when another item has the same title. */ sameTitle?: { label: string; full: string }; installations: Installation[]; onAction: (name: string, trial?: Trial) => void; onToggleInstall: (provider: ProviderId, targetId?: string) => void; refresh: () => Promise<void>; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; onSelect: (id: string) => void; onSetup: () => void; onCollection: (name: string) => void; /** Shows the library filtered to what was made from a source. */ onMadeFrom: (sourceId: string) => void;
  /** Opens the agent chat about this item. */ onAsk?: () => void;
  /** Shows the Machines section, for copies on other machines. */ onMachines?: () => void;
  /** Set when something outside the page (the list's Test, quick search) asks for this item's tests. */ showTests?: { id: string; at: number };
};
type View = 'content' | 'tests' | 'history';
function savedDraft(id: string): { content: string; base: string } | null {
  try { const value = JSON.parse(localStorage.getItem(`kiln-draft:${id}`) ?? 'null'); return value && typeof value.content === 'string' && typeof value.base === 'string' ? value : null; } catch { return null; }
}
const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
const mainFile = (detail: ItemDetail) => detail.item.kind === 'agent' ? detail.item.agent?.filename ?? 'Agent file' : detail.item.kind === 'skill' ? 'SKILL.md' : detail.item.kind === 'source' ? 'Original material' : 'Content';

/** Copies plain text during a click. The window denies the async clipboard permission, so this uses a selected textarea. */
function copyText(text: string) {
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('Could not copy to the clipboard.');
}

/** The last `showTests` request a page acted on. */
let shownTests = 0;

/**
 * The item page (design 5): a small header with one primary action, the content itself as the main column (edited in
 * place), and a rail with status, installs, tests, history, provenance and organisation. Tests and History swap into the
 * main column; sources show their SourcePage there instead of the content.
 */
export function Detail({ jobs, detail, snapshot, providers, sameTitle, installations, onAction, onToggleInstall, refresh, perform, onSelect, onSetup, onCollection, onMadeFrom, onAsk, onMachines, showTests }: Props) {
  const { item, revision } = detail;
  const [view, setView] = useState<View>('content');
  const [raw, setRaw] = useState(() => localStorage.getItem('kiln-detail-raw') === '1');
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(Boolean(savedDraft(item.id)));
  const [draft, setDraft] = useState(savedDraft(item.id)?.content ?? revision.content);
  const [base, setBase] = useState(savedDraft(item.id)?.base ?? revision.hash);
  const [fieldsChanged, setFieldsChanged] = useState(false);
  const [filePreview, setFilePreview] = useState<{ name: string; text: string } | null>(null);
  const [zoom, setZoom] = useState<{ name: string; src: string } | null>(null);
  const [deployRevision, setDeployRevision] = useState<string | null>(null);
  const [addingFile, setAddingFile] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const saved = savedDraft(item.id); setEditing(Boolean(saved)); setDraft(saved?.content ?? revision.content); setBase(saved?.base ?? revision.hash); setFieldsChanged(false); setFilePreview(null); setAddingFile(false); setView('content'); }, [item.id]);
  // After the reset above, which runs when the page mounts; each request opens the tests once, not again when the item is reopened later.
  useEffect(() => { if (showTests?.id === item.id && showTests.at !== shownTests) { shownTests = showTests.at; setView('tests'); } }, [showTests, item.id]);
  useEffect(() => { if (editing) localStorage.setItem(`kiln-draft:${item.id}`, JSON.stringify({ content: draft, base })); }, [draft, base, editing, item.id]);
  useEffect(() => { if (!editing) { setDraft(revision.content); setBase(revision.hash); } }, [revision.hash, editing]);
  const isSource = item.kind === 'source';
  // Legacy video captures from before sources existed are links tagged youtube; they get the source page too.
  const sourcePage = isSource || (item.kind === 'link' && item.tags.includes('youtube'));
  const installable = ['skill', 'agent', 'instruction'].includes(item.kind);
  // Save-only captures (a pasted note, a link, files) can still be analysed; doing so makes them a source.
  const analysable = isSource || (['prompt', 'link', 'file', 'image'].includes(item.kind) && !item.origin);
  const analyse = () => void perform(async () => { await api('agent.start', { id: item.id, kind: 'distill' }); agentStarted('distill'); await refresh(); });
  const recorded = detail.analyses.filter(a => !jobs.some(j => j.id === a.id));
  const scroll = useScrollMemory(`detail:${item.id}:${view}`, true);
  // Experiments belong to the tests view, notes and skill drafts to the content, so jump there when a run starts.
  const viewFor = (kind: AgentKind) => setView(kind === 'trial' ? 'tests' : 'content');
  // "Open result" on a finished run (toast or desktop notification) shows the same view.
  useEffect(() => { const jump = (event: Event) => { const kind = (event as CustomEvent<{ kind?: AgentKind }>).detail?.kind; if (kind) viewFor(kind); }; window.addEventListener('kiln:agent-started', jump); window.addEventListener(OPEN_RESULT_TAB_EVENT, jump); return () => { window.removeEventListener('kiln:agent-started', jump); window.removeEventListener(OPEN_RESULT_TAB_EVENT, jump); }; }, []);
  const currentApproved = detail.approvals.some(a => a.revision === item.revision && a.trust === 'local');
  const locations = providers.filter(p => (item.kind === 'agent' ? p.id === item.agent?.provider : p.id !== 'copilot') && personalTarget(snapshot.targets, providers, p.id));
  const copies = installations.filter(copy => copy.itemId === item.id);
  const drifted = copies.filter(copy => copy.state === 'drifted');
  const origin = item.origin ? snapshot.items.find(i => i.id === item.origin!.itemId) : undefined;
  const places = useMemo(() => trialPlaces(jobs), [jobs]);
  const events = useMemo(() => buildHistory(detail, snapshot, installations, places), [detail, snapshot, installations, places]);
  const primary = primaryAction({ detail, installations, locations: locations.length });
  const shelved = ['archived', 'rejected'].includes(item.status);

  const openItem = () => void perform(() => api('desktop.openItem', { id: item.id }));
  const setMeta = (change: Record<string, unknown>, message?: string) => void perform(async () => { await api('items.meta', { id: item.id, expect: item.revision, ...change }); await refresh(); }, message);
  // CodeMirror loads on first use, so focus it once it is on screen (tried for about a second).
  const focusEditor = (tries = 20) => { const content = document.querySelector<HTMLElement>('.item-code .cm-content'); if (content) content.focus(); else if (tries > 0) setTimeout(() => focusEditor(tries - 1), 50); };
  const startEdit = () => { setView('content'); if (!editing) { setDraft(revision.content); setBase(revision.hash); setFieldsChanged(false); setEditing(true); } requestAnimationFrame(() => focusEditor()); };
  const discard = () => { localStorage.removeItem(`kiln-draft:${item.id}`); setEditing(false); setFieldsChanged(false); setDraft(revision.content); setBase(revision.hash); };
  // The grid has its own run bar (and Run options… for the full dialog), so Test only opens it.
  const test = () => setView('tests');
  const toggleRaw = (value: boolean) => { setRaw(value); localStorage.setItem('kiln-detail-raw', value ? '1' : '0'); };
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    void perform(async () => {
      // Collection and tags are organised in the rail: the collection may have moved without a new revision, so it comes from the item.
      await api('items.update', { id: item.id, expect: base, summary: fields.summary, value: { ...revision, title: fields.title, source: fields.source, licence: fields.licence, collection: item.collection, tags: item.tags, content: draft, ...(item.kind === 'agent' ? { agent: { provider: item.agent?.provider, filename: fields.agentFilename } } : {}) } });
      localStorage.removeItem('kiln-draft:' + item.id); setEditing(false); setFieldsChanged(false); await refresh();
    }, 'New draft revision saved');
  };

  const run: Record<PrimaryAction, { label: string; icon: ReactNode; onClick: () => void; title?: string }> = {
    restore: { label: 'Restore', icon: <RotateCcw size={15} />, onClick: () => setMeta({ deleted: false }, 'Item restored') },
    'open-original': { label: 'Open original', icon: <ExternalLink size={15} />, onClick: openItem },
    analyze: { label: 'Analyze again', icon: <ScanSearch size={15} />, onClick: analyse, title: 'Run the analysis again; new entries are added beside the earlier ones' },
    resolve: { label: changedCopiesLabel(drifted.length), icon: <TriangleAlert size={15} />, onClick: () => drifted[0] && onToggleInstall(drifted[0].provider, drifted[0].targetId), title: 'A copy was edited outside Kiln. Compare it, then reinstall the approved version or remove it.' },
    test: { label: 'Test', icon: <FlaskConical size={15} />, onClick: test, title: 'Run this revision on a real task' },
    approve: { label: 'Approve', icon: <ShieldCheck size={15} />, onClick: () => onAction('approve'), title: 'Approve this revision and publish it to GitHub.' },
    'approve-update-installs': { label: 'Approve & update installs', icon: <CircleArrowUp size={15} />, onClick: () => onAction('approve-update-installs'), title: 'Approve this revision, then update every copy Kiln installed. Copies edited outside Kiln are left alone.' },
    'update-installs': { label: updateInstallsLabel(outdatedCopies(item.id, installations).length), icon: <CircleArrowUp size={15} />, onClick: () => onAction('update-installs'), title: 'Install the approved revision over copies Kiln installed earlier. Copies edited outside Kiln are left alone.' },
    'approve-install': { label: 'Approve & install', icon: <Download size={15} />, onClick: () => onAction('approve-install'), title: 'Approve this revision, then install it in every configured location.' },
    install: { label: 'Install', icon: <Download size={15} />, onClick: () => onAction('approve-install'), title: 'Install the approved revision in every configured location.' },
    'open-link': { label: 'Open link', icon: <ExternalLink size={15} />, onClick: openItem },
    'open-file': { label: 'Open file', icon: <ExternalLink size={15} />, onClick: openItem },
    copy: { label: 'Copy', icon: <Copy size={15} />, onClick: () => onAction('copy'), title: variablesIn(revision.content).length ? 'Fill in its variables, then copy' : undefined },
  };
  const main = run[primary];

  const statusEntries = (statuses: Item['status'][]): MenuEntry[] => statuses.filter(status => status !== item.status).map(status => ({ label: `Move to ${statusLabel[status]}`, hint: statusHelp[status], onSelect: () => setMeta({ status }) }));
  // The ⋯ menu holds only what the page doesn't already show: Edit, Approve, Install into…, tests and history live in the
  // document bar and the rail, and the source page has its own Analyze, Ask and Edit.
  const trash: MenuEntry = { label: 'Move to trash', icon: <Trash2 />, danger: true, hint: 'Restore it any time from Trash. Installed copies stay in place.', onSelect: () => setMeta({ deleted: true }, 'Moved to Trash. Restore it any time.') };
  const copyId: MenuEntry = { label: 'Copy item ID', icon: <Hash />, hint: 'For support or scripts', onSelect: () => void perform(async () => copyText(item.id), 'Item ID copied') };
  const opens = ['open-original', 'open-link', 'open-file'].includes(primary);
  const openStored: MenuEntry[] = opens ? [] : [{ label: 'Open stored file or link', icon: <ExternalLink />, onSelect: openItem }];
  const addFile: MenuEntry = { label: 'Add a file…', icon: <Paperclip />, hint: 'Bundle a file with it, in a new draft revision', onSelect: () => { setView('content'); setAddingFile(true); } };
  const entries: MenuEntry[] = item.deletedAt ? [
    copyId, 'separator',
    { label: 'Delete permanently…', icon: <Trash2 />, danger: true, onSelect: () => onAction('purge') },
  ] : sourcePage ? [
    ...openStored, addFile, copyId, 'separator',
    ...statusEntries(['captured', 'archived']), trash,
  ] : [
    ...(primary !== 'copy' ? [{ label: 'Copy', icon: <Copy />, onSelect: () => onAction('copy') }] : []),
    ...(['skill', 'agent'].includes(item.kind) && locations.length > 0 && !['approve-install', 'install'].includes(primary) ? [{ label: currentApproved ? 'Install in every location' : 'Approve & install', icon: <Download />, hint: 'Install the approved revision in every configured location.', onSelect: () => onAction('approve-install') }] : []),
    ...(installable ? [] : [{ label: 'Create skill', icon: <Sparkles />, onSelect: () => onAction('derive') }]),
    ...(analysable ? [{ label: 'Analyze as a source', icon: <ScanSearch />, hint: 'Ask your agent to distill it into prompts, techniques, tools and insights. It becomes a source that links to them.', onSelect: analyse }] : []),
    ...(onAsk ? [{ label: 'Ask the agent about it', icon: <MessageSquare />, onSelect: onAsk }] : []),
    ...openStored, addFile, copyId, 'separator',
    ...statusEntries(['captured', 'testing', 'rejected', 'archived']), trash,
  ];
  const sourceAction = (name: string, trial?: Trial) => {
    if (name === 'analyze') analyse(); else if (name === 'edit') startEdit(); else if (name === 'ask') onAsk?.(); else if (name === 'open') openItem(); else if (name === 'history') setView('history'); else onAction(name, trial);
  };

  const status = item.deletedAt ? 'deleted' : shelved ? item.status : currentApproved ? 'approved' : item.status === 'testing' ? 'testing' : 'draft';
  // The source page has its own Analyze button beside Ask and the transcript, so the header doesn't repeat it.
  const showPrimary = !(sourcePage && primary === 'analyze');
  const collection = item.collection.replaceAll('/', ' / ');

  return <article className="detail-pane item-page" aria-label="Selected item">
    <header className="item-head detail-heading">
      <div className="item-head-text">
        <div className="eyebrow"><KindIcon kind={item.kind} size={14} />{item.kind}<span className="dot">·</span>{item.collection ? <button type="button" className="item-crumb" title="Open this collection" onClick={() => onCollection(item.collection)}><Folder size={13} />{collection}</button> : <span title="Not in any collection"><Folder size={13} />Unfiled</span>}</div>
        {/* A captured source has no lifecycle to show; only archived or deleted ones get a badge. */}
        <div className="item-title-row"><h1>{item.title}</h1>{!(isSource && status === 'draft') && <span className="item-state"><Badge status={status} /></span>}</div>
        {item.description && <p className="item-lede">{item.description}</p>}
        <div className="detail-meta">{origin && <button type="button" className="source-chip" onClick={() => onSelect(origin.id)} title={origin.kind === 'source' ? 'Open the source this was made from' : 'Open the item this was derived from'}><FileInput size={12} />From “{origin.title}”</button>}<span>Updated {date(item.updatedAt)}</span></div>
      </div>
      <div className="detail-actions">
        <button className={`icon-button ${item.favourite ? 'favourited' : ''}`} aria-label={item.favourite ? 'Remove favourite' : 'Add favourite'} title={item.favourite ? 'In favourites' : 'Add to favourites'} onClick={() => setMeta({ favourite: !item.favourite })}><Star size={18} fill={item.favourite ? 'currentColor' : 'none'} /></button>
        {showPrimary && <button className="button primary" onClick={main.onClick} title={main.title}>{main.icon}{main.label}</button>}
        <button className="button item-more" aria-label="More" title="More actions" aria-haspopup="menu" aria-expanded={Boolean(more)} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMore({ x: rect.right - 250, y: rect.bottom + 4 }); }}><MoreHorizontal size={16} /></button>
        {more && <ContextMenu x={more.x} y={more.y} onClose={() => setMore(null)} entries={entries} />}
      </div>
    </header>
    <div className="item-body">
      <div className="item-cols">
        <div className="item-main" {...scroll}>
          {view === 'tests' ? <div className="item-subview">
            <div className="item-subbar"><button className="text-button" onClick={() => setView('content')}><ArrowLeft size={14} />Content</button><h2>Tests</h2><span className="muted small">{experimentsOf(detail.trials).length} experiment{experimentsOf(detail.trials).length === 1 ? '' : 's'} · results stay with the exact revision</span></div>
            <ExperimentsGrid detail={detail} snapshot={snapshot} providers={providers} jobs={jobs} perform={perform} refresh={refresh} onAction={onAction} />
          </div>
          : view === 'history' ? <><AgentStatus itemId={item.id} jobs={jobs} onOpen={viewFor} /><History places={places} detail={detail} snapshot={snapshot} installations={installations} perform={perform} refresh={refresh} onAction={onAction} onToggleInstall={onToggleInstall} onInstallRevision={installable ? setDeployRevision : undefined} onBack={() => setView('content')} /></>
          : sourcePage && !editing ? <div className="item-content">
            <AgentStatus itemId={item.id} jobs={jobs} onOpen={viewFor} />
            <SourcePage detail={detail} snapshot={snapshot} providers={providers} jobs={jobs} perform={perform} refresh={refresh} onSelect={onSelect} onMadeFrom={onMadeFrom} onCollection={onCollection} onAction={sourceAction} />
            {/* The transcript has its own toggle at the top, so its file is listed without a second preview. */}
            <BundledFiles detail={detail} perform={perform} refresh={refresh} preview={filePreview} onPreview={setFilePreview} adding={addingFile} onAdding={setAddingFile} noPreview={['transcript.md', 'session.jsonl']} />
          </div>
          : <div className="item-content">
            <AgentStatus itemId={item.id} jobs={jobs} onOpen={viewFor} />
            <AgentPanel itemId={item.id} jobs={jobs} kinds={['capture', 'derive', 'distill']} onOpen={onSelect} onOpenCollection={onCollection} collections={snapshot.collections} />
            {recorded.map(a => <AnalysisRecord key={a.id} analysis={a} />)}
            {!isSource && detail.validation.length > 0 && <div className="notice warning"><b>Needs attention before approval</b>{detail.validation.map(v => <p key={v}>{v}</p>)}</div>}
            {detail.duplicates.length > 0 && <div className="notice warning"><b>Similar content already in your library</b>{detail.duplicates.map(d => <button key={d.id} className="text-button" onClick={() => onSelect(d.id)}>{d.title} <ArrowRight size={12} /></button>)}</div>}
            {editing ? <form className="item-editor" aria-label={`Edit ${mainFile(detail)}`} onSubmit={save} onChange={event => { const field = event.target as EventTarget as HTMLInputElement | HTMLTextAreaElement; if (field.tagName !== 'TEXTAREA' && field.name !== 'summary') setFieldsChanged(true); }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
              <div className={`item-savebar ${draft !== revision.content || fieldsChanged || base !== item.revision ? 'dirty' : ''}`}>
                <span className="item-savebar-state">{draft !== revision.content || fieldsChanged || base !== item.revision ? <><span className="item-dot" />Unsaved changes</> : <><Pencil size={13} />Editing</>}</span>
                <input name="summary" aria-label="What changed? (optional)" placeholder="What changed? (optional)" title="Leave it empty to use a plain revision note." />
                <button className="button primary" type="submit" title="Creates an unapproved revision. Ctrl+S">Save revision</button>
                <button className="button" type="button" title="Throw away the text autosaved on this machine" onClick={discard}>{draft !== revision.content || fieldsChanged ? 'Discard' : 'Done'}</button>
              </div>
              {base !== item.revision && <div className="notice warning">This item changed elsewhere. Your unsaved text is preserved. Copy it before discarding, then compare in History.</div>}
              <div className="item-editor-fields">
                <Field label="Title"><input name="title" defaultValue={item.title} required /></Field>
                {item.kind === 'agent' && <Field label="Agent filename"><input name="agentFilename" defaultValue={item.agent?.filename} required /></Field>}
                <Field label="Source"><input name="source" defaultValue={item.source} /></Field>
                <Field label="Licence"><input name="licence" defaultValue={item.licence} /></Field>
              </div>
              <div className="item-doc editing"><div className="item-doc-bar"><span className="item-doc-name">{mainFile(detail)}</span><span className="muted small">Text autosaves privately on this machine.</span></div><CodeEditor className="item-code" value={draft} onChange={setDraft} language={itemLanguage(item)} ariaLabel="Content" /></div>
            </form>
            : <Document detail={detail} raw={raw} onRaw={toggleRaw} onEdit={item.deletedAt ? undefined : startEdit} onZoom={setZoom} />}
            <BundledFiles detail={detail} perform={perform} refresh={refresh} preview={filePreview} onPreview={setFilePreview} adding={addingFile} onAdding={setAddingFile} />
          </div>}
        </div>
        <ItemRail places={places} detail={detail} snapshot={snapshot} providers={providers} installations={installations} events={events} sameTitle={sameTitle} editing={editing} perform={perform} refresh={refresh} onAction={onAction} onToggleInstall={onToggleInstall} onSetup={onSetup} onMachines={onMachines} onOpenTests={() => setView('tests')} onOpenHistory={() => setView('history')} approveInHeader={showPrimary && primary === 'approve'} sourceInHeader={['open-original', 'open-link'].includes(primary)} />
      </div>
    </div>
    {zoom && <Lightbox src={zoom.src} name={zoom.name} onClose={() => setZoom(null)} />}
    {deployRevision && <DeployDialog detail={detail} snapshot={snapshot} revision={deployRevision} onClose={() => setDeployRevision(null)} onDone={() => { setDeployRevision(null); void perform(refresh, 'Installed. Start a new agent session to use it.'); }} />}
  </article>;
}

/** The content as a document: front-matter as a property table, the body formatted (or raw), images inline. Clicking the text edits it. */
function Document({ detail, raw, onRaw, onEdit, onZoom }: { detail: ItemDetail; raw: boolean; onRaw: (raw: boolean) => void; onEdit?: () => void; onZoom: (image: { name: string; src: string }) => void }) {
  const { item, revision } = detail;
  const { properties, body } = splitFrontMatter(revision.content);
  const variables = variablesIn(revision.content);
  const images = Object.entries(revision.files).filter(([name]) => imageFile(name));
  // Codex agents are TOML; only Markdown is rendered.
  const markdown = !(item.kind === 'agent' && !/\.md$/i.test(item.agent?.filename ?? ''));
  const formatted = markdown && !raw;
  const click = (event: MouseEvent) => {
    if (!onEdit || (event.target as HTMLElement).closest('a, button, input, select, summary, img') || window.getSelection()?.toString()) return;
    onEdit();
  };
  return <section className={`item-doc ${onEdit ? 'editable' : ''}`} aria-label={mainFile(detail)} onClick={click}>
    <div className="item-doc-bar">
      <span className="item-doc-name">{mainFile(detail)}</span>
      {markdown && <span className="item-seg" role="group" aria-label="Show as"><button type="button" aria-pressed={formatted} className={formatted ? 'on' : ''} onClick={() => onRaw(false)}>Formatted</button><button type="button" aria-pressed={!formatted} className={formatted ? '' : 'on'} onClick={() => onRaw(true)}>Raw</button></span>}
      {onEdit && <button type="button" className="text-button" aria-label="Edit text" onClick={onEdit}><Pencil size={13} />Edit</button>}
    </div>
    {formatted && (properties.length > 0 || variables.length > 0) && <table className="item-props"><tbody>
      {properties.map(([key, value]) => <tr key={key}><th>{key}</th><td>{key === 'allowed-tools' || key === 'tools' ? value.split(',').filter(Boolean).map(tool => <code key={tool}>{tool.trim()}</code>) : value}</td></tr>)}
      {variables.length > 0 && <tr><th>variables</th><td>{variables.map(v => <span key={v} className="variable-token" title="Filled in when you copy or test it">{v}</span>)}</td></tr>}
    </tbody></table>}
    {images.length > 0 && <div className="asset-gallery">{images.map(([name, content]) => <button key={name} type="button" className="asset-button" title={`Enlarge ${name}`} onClick={() => onZoom({ name, src: imageSource(name, content) })}><img className="asset-preview" alt={name} src={imageSource(name, content)} /><span><ZoomIn size={13} />{name}</span></button>)}</div>}
    {formatted ? <div className="item-doc-body"><Markdown variables>{body}</Markdown></div> : <pre className="item-raw">{revision.content}</pre>}
    {onEdit && <span className="item-edit-hint" aria-hidden="true"><Pencil size={12} />Click to edit</span>}
  </section>;
}

/**
 * Bundled files and attachments, listed once: preview, open, remove, and add or replace one (each change is a new draft).
 * Images are enlarged from the gallery above, so they aren't repeated here. Hidden when there are none until the ⋯ menu's
 * "Add a file…" asks for the form.
 */
function BundledFiles({ detail, perform, refresh, preview, onPreview, adding, onAdding, noPreview = [] }: { detail: ItemDetail; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>; preview: { name: string; text: string } | null; onPreview: (file: { name: string; text: string } | null) => void; adding: boolean; onAdding: (adding: boolean) => void; /** Files shown elsewhere (a transcript) or not worth reading here. */ noPreview?: string[] }) {
  const { item, revision } = detail;
  const open = (name: string) => void perform(() => api('desktop.openAttachment', { id: item.id, relative: name }));
  const entries = Object.entries(revision.files);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (adding) form.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [adding]);
  if (!entries.length && !adding) return null;
  return <section className="content-section item-files" aria-label="Files"><div className="section-heading"><h3>Files <small className="muted">{entries.length || ''}</small></h3>{!item.deletedAt && !adding && <button type="button" className="text-button" onClick={() => onAdding(true)}><Plus size={13} />Add or replace a file</button>}</div>
    {entries.length > 0 && <div className="file-preview-list">{entries.map(([name, content]) => <div key={name} className="bundled-file">
      <span className="bundled-name">{name}<small>{Math.round(content.length * .75).toLocaleString()} bytes</small></span>
      <span className="wrap-actions">{isTextFile(name) && !noPreview.includes(name) && <button className="text-button" aria-expanded={preview?.name === name} onClick={() => onPreview(preview?.name === name ? null : { name, text: decode(content) })}>{preview?.name === name ? 'Hide preview' : 'Preview'}</button>}<button className="text-button" onClick={() => open(name)}><ExternalLink size={13} />Open</button>{!item.deletedAt && <button className="text-button danger-text" onClick={() => void perform(async () => { await api('desktop.removeAttachment', { id: item.id, expect: item.revision, relative: name }); await refresh(); }, 'Attachment removed in a new draft revision')}>Remove</button>}</span></div>)}</div>}
    {preview && <pre className="prompt-preview" aria-label={`Preview of ${preview.name}`}>{preview.text}</pre>}
    {!item.deletedAt && adding && <form ref={form} onSubmit={event => { event.preventDefault(); const v = new FormData(event.currentTarget); void perform(async () => { await api('desktop.addAttachment', { id: item.id, expect: item.revision, relative: v.get('relative') }); await refresh(); onAdding(false); }); }}><Field label="Add or replace a file" hint="Its relative path, then pick the file. Scripts stay inert until separately reviewed and run."><div className="input-button"><input name="relative" required autoFocus placeholder="scripts/check.py or references/guide.md" /><button className="button" type="submit">Choose file</button><button className="button" type="button" onClick={() => onAdding(false)}>Cancel</button></div></Field></form>}
  </section>;
}
