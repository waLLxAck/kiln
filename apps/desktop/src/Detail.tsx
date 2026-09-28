import { experimentsOf } from './trial-verdicts';
import { trialPlaces } from './trial-place';
import { Markdown } from './Markdown';
import { useScrollMemory } from './view-memory';
import { AgentPanel, AgentStatus, AnalysisRecord, agentStarted } from './AgentPanel';
import type { AgentJob, AgentKind } from '../../../packages/agent/service';
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CircleArrowUp, Copy, Download, ExternalLink, FileInput, FlaskConical, Folder, Hash, MessageSquare, MoreHorizontal, Paperclip, Pencil, Plus, RotateCcw, ScanSearch, ShieldCheck, Sparkles, Star, Trash2, TriangleAlert, X, ZoomIn } from 'lucide-react';
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
import { languageFor } from './code-language';
import { ItemEditor, useItemDraft, type ItemDraftState } from './item-editing';
import { EDITABLE_TEXT_LIMIT } from './bundled-text';
import { OPEN_RESULT_TAB_EVENT } from './Runs';
import './item.css';

type Props = {
  jobs: AgentJob[]; detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; /** Where this item came from, when another item has the same title. */ sameTitle?: { label: string; full: string }; installations: Installation[]; onAction: (name: string, trial?: Trial) => void; onToggleInstall: (provider: ProviderId, targetId?: string) => void; refresh: () => Promise<void>; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; onSelect: (id: string) => void; onSetup: () => void; onCollection: (name: string) => void; /** Shows the library filtered to what was made from a source. */ onMadeFrom: (sourceId: string) => void;
  /** Opens the agent chat about this item. */ onAsk?: () => void;
  /** Shows the Machines section, for copies on other machines. */ onMachines?: () => void;
  /** Stars, moves to another status, trashes or restores the item as one action on the library's undo stack (Ctrl+Z). */ onMeta: (patch: { favourite: boolean } | { status: Item['status'] } | { deleted: boolean }) => void;
  /** Set when something outside the page (the list's Test, quick search) asks for this item's tests. */ showTests?: { id: string; at: number };
};
type View = 'content' | 'tests' | 'history';
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
export function Detail({ jobs, detail, snapshot, providers, sameTitle, installations, onAction, onToggleInstall, refresh, perform, onSelect, onSetup, onCollection, onMadeFrom, onAsk, onMachines, onMeta, showTests }: Props) {
  const { item, revision } = detail;
  const [view, setView] = useState<View>('content');
  const [raw, setRaw] = useState(() => localStorage.getItem('kiln-detail-raw') === '1');
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const draft = useItemDraft(detail, perform, refresh), editing = draft.editing;
  const [filePreview, setFilePreview] = useState<{ name: string; text: string } | null>(null);
  const [zoom, setZoom] = useState<{ name: string; src: string } | null>(null);
  const [deployRevision, setDeployRevision] = useState<string | null>(null);
  const [addingFile, setAddingFile] = useState(false);
  useEffect(() => { setFilePreview(null); setAddingFile(false); setView('content'); }, [item.id]);
  // After the reset above, which runs when the page mounts; each request opens the tests once, not again when the item is reopened later.
  useEffect(() => { if (showTests?.id === item.id && showTests.at !== shownTests) { shownTests = showTests.at; setView('tests'); } }, [showTests, item.id]);
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
  // CodeMirror loads on first use, so focus it once it is on screen (tried for about a second).
  const focusEditor = (tries = 20) => { const content = document.querySelector<HTMLElement>('.item-code .cm-content'); if (content) content.focus(); else if (tries > 0) setTimeout(() => focusEditor(tries - 1), 50); };
  const startEdit = () => { setView('content'); draft.start(); requestAnimationFrame(() => focusEditor()); };
  // The grid has its own run bar (and Run options… for the full dialog), so Test only opens it.
  const test = () => setView('tests');
  const toggleRaw = (value: boolean) => { setRaw(value); localStorage.setItem('kiln-detail-raw', value ? '1' : '0'); };

  const run: Record<PrimaryAction, { label: string; icon: ReactNode; onClick: () => void; title?: string }> = {
    restore: { label: 'Restore', icon: <RotateCcw size={15} />, onClick: () => onMeta({ deleted: false }) },
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

  const statusEntries = (statuses: Item['status'][]): MenuEntry[] => statuses.filter(status => status !== item.status).map(status => ({ label: `Move to ${statusLabel[status]}`, hint: statusHelp[status], onSelect: () => onMeta({ status }) }));
  // The ⋯ menu holds only what the page doesn't already show: Edit, Approve, Install into…, tests and history live in the
  // document bar and the rail, and the source page has its own Analyze, Ask and Edit.
  const trash: MenuEntry = { label: 'Move to trash', icon: <Trash2 />, danger: true, hint: 'Restore it any time from Trash, or press Ctrl+Z. Installed copies stay in place.', onSelect: () => onMeta({ deleted: true }) };
  const copyId: MenuEntry = { label: 'Copy item ID', icon: <Hash />, hint: 'For support or scripts', onSelect: () => void perform(async () => copyText(item.id), 'Item ID copied') };
  const opens = ['open-original', 'open-link', 'open-file'].includes(primary);
  const openStored: MenuEntry[] = opens ? [] : [{ label: 'Open stored file or link', icon: <ExternalLink />, onSelect: openItem }];
  const addFile: MenuEntry = { label: 'Add a file…', icon: <Paperclip />, hint: item.kind === 'agent' ? 'Bundle a file from disk; it is saved as a new revision' : 'Start a text file in your draft, or bundle one from disk', onSelect: () => { setView('content'); setAddingFile(true); } };
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
        <button className={`icon-button ${item.favourite ? 'favourited' : ''}`} aria-label={item.favourite ? 'Remove favourite' : 'Add favourite'} title={item.favourite ? 'In favourites' : 'Add to favourites'} onClick={() => onMeta({ favourite: !item.favourite })}><Star size={18} fill={item.favourite ? 'currentColor' : 'none'} /></button>
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
            <BundledFiles detail={detail} draft={draft} perform={perform} refresh={refresh} preview={filePreview} onPreview={setFilePreview} adding={addingFile} onAdding={setAddingFile} noPreview={['transcript.md', 'session.jsonl']} />
          </div>
          : <div className="item-content">
            <AgentStatus itemId={item.id} jobs={jobs} onOpen={viewFor} />
            <AgentPanel itemId={item.id} jobs={jobs} kinds={['capture', 'derive', 'distill']} onOpen={onSelect} onOpenCollection={onCollection} collections={snapshot.collections} />
            {recorded.map(a => <AnalysisRecord key={a.id} analysis={a} />)}
            {/* While editing, the editor lists the draft's own problems live instead. */}
            {!isSource && !editing && detail.validation.length > 0 && <div className="notice warning"><b>Needs attention before approval</b>{detail.validation.map(v => <p key={v}>{v}</p>)}</div>}
            {detail.duplicates.length > 0 && <div className="notice warning"><b>Similar content already in your library</b>{detail.duplicates.map(d => <button key={d.id} className="text-button" onClick={() => onSelect(d.id)}>{d.title} <ArrowRight size={12} /></button>)}</div>}
            {editing ? <ItemEditor detail={detail} draft={draft} collections={snapshot.collections} name={mainFile(detail)} />
            : <Document detail={detail} raw={raw} onRaw={toggleRaw} onEdit={item.deletedAt ? undefined : startEdit} onZoom={setZoom} />}
            <BundledFiles detail={detail} draft={draft} perform={perform} refresh={refresh} preview={filePreview} onPreview={setFilePreview} adding={addingFile} onAdding={setAddingFile} />
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
 * Bundled files and attachments, listed once: preview, open, remove, and add one. Text files are edited here into the
 * item's draft, and new text files added by relative path, all saved with the draft's next revision; binary files, and
 * text over 512 KB or not UTF-8, are kept exactly as they are. Removing a file or choosing one from disk saves a new
 * revision at once, so it waits until the draft is saved or discarded. Images are enlarged from the gallery above, so
 * they aren't repeated here. Hidden when there are none, until "Add a file…" asks for the form or a skill is edited.
 */
function BundledFiles({ detail, draft, perform, refresh, preview, onPreview, adding, onAdding, noPreview = [] }: { detail: ItemDetail; draft: ItemDraftState; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>; preview: { name: string; text: string } | null; onPreview: (file: { name: string; text: string } | null) => void; adding: boolean; onAdding: (adding: boolean) => void; /** Files shown elsewhere (a transcript) or not worth reading here. */ noPreview?: string[] }) {
  const { item, revision } = detail;
  const [path, setPath] = useState(''), [problem, setProblem] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (adding) form.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [adding]);
  const { editing, names } = draft, live = !item.deletedAt, textFiles = live && item.kind !== 'agent';
  if (!names.length && !adding && !(editing && item.kind === 'skill')) return null;
  const wait = 'Save or discard your draft first: this saves a new revision right away.';
  const open = (name: string) => void perform(() => api('desktop.openAttachment', { id: item.id, relative: name }));
  const remove = (name: string) => void perform(async () => { await api('desktop.removeAttachment', { id: item.id, expect: item.revision, relative: name }); await refresh(); }, 'Attachment removed in a new draft revision');
  const close = () => { onAdding(false); setPath(''); setProblem(null); };
  const addText = () => { const why = draft.addFile(path.trim()); setProblem(why); if (!why) { close(); onPreview(null); } };
  const choose = () => { const relative = path.trim(); if (!relative) { setProblem('Enter a relative path, for example references/notes.md.'); return; } void perform(async () => { await api('desktop.addAttachment', { id: item.id, expect: item.revision, relative }); await refresh(); close(); }); };
  const row = (name: string) => {
    const added = !Object.hasOwn(revision.files, name), edited = !added && Object.hasOwn(draft.files, name);
    const editable = textFiles && (added || draft.texts[name] !== null), opened = editing && draft.open === name;
    const previewing = !editing && preview?.name === name;
    const size = Object.hasOwn(draft.files, name) ? new TextEncoder().encode(draft.files[name]).length : Math.round(revision.files[name].length * .75);
    return <div key={name} className={`bundled-entry ${opened ? 'open' : ''}`}>
      <div className="bundled-file">
        <span className="bundled-name"><span>{name}{added ? <small className="draft-mark">new</small> : edited ? <small className="draft-mark">edited</small> : null}</span><small>{size.toLocaleString()} bytes{!added && textFiles && draft.texts[name] === null ? <span title={`Binary, not UTF-8 text, or larger than ${EDITABLE_TEXT_LIMIT / 1024} KB`}> · kept as it is</span> : null}</small></span>
        <span className="wrap-actions">
          {editable && <button className="text-button" aria-pressed={opened} aria-label={`${opened ? 'Close' : 'Edit'} ${name}`} onClick={() => opened ? draft.setOpen(null) : draft.start(name)}>{opened ? <X size={13} /> : <Pencil size={13} />}{opened ? 'Close' : 'Edit'}</button>}
          {!editing && isTextFile(name) && !noPreview.includes(name) && <button className="text-button" aria-expanded={previewing} onClick={() => onPreview(previewing ? null : { name, text: decode(revision.files[name]) })}>{previewing ? 'Hide preview' : 'Preview'}</button>}
          {!added && <button className="text-button" onClick={() => open(name)}><ExternalLink size={13} />Open</button>}
          {added ? <button className="text-button danger-text" title="Only in your draft; nothing was saved yet" onClick={() => draft.dropFile(name)}>Remove</button>
            : live && <button className="text-button danger-text" disabled={editing} title={editing ? wait : undefined} onClick={() => remove(name)}>Remove</button>}
        </span>
      </div>
      {previewing && <pre className="prompt-preview" aria-label={`Preview of ${name}`}>{preview.text}</pre>}
      {opened && <div className="code-file-editor">
        {edited && <div className="code-file-head"><span className="muted small">Edited in your draft</span><button type="button" className="text-button" onClick={() => draft.dropFile(name)}><RotateCcw size={12} />Undo changes to this file</button></div>}
        <CodeEditor key={name} value={draft.files[name] ?? draft.texts[name] ?? ''} onChange={text => draft.editFile(name, text)} language={languageFor(name)} ariaLabel={`${name} content`} onSave={draft.save} autoFocus={added} />
      </div>}
    </div>;
  };
  return <section className="content-section item-files" aria-label="Files"><div className="section-heading"><h3>Files <small className="muted">{names.length || ''}</small></h3>{live && !adding && <button type="button" className="text-button" onClick={() => onAdding(true)}><Plus size={13} />Add a file</button>}</div>
    {names.length > 0 ? <div className="file-preview-list">{names.map(row)}</div> : <p className="muted small">No bundled files. Add references, scripts or templates the skill points to.</p>}
    {live && adding && <form ref={form} onSubmit={event => { event.preventDefault(); if (textFiles) addText(); else choose(); }}>
      <Field label="Add a file" hint={textFiles ? 'Its relative path. A new text file starts empty and is saved with your draft; Choose file… bundles one from disk in a new revision. Scripts stay inert until separately reviewed and run.' : 'Its relative path, then pick the file. It is saved in a new draft revision.'}>
        <div className="input-button"><input aria-label="Relative path" value={path} required autoFocus placeholder="references/notes.md or scripts/check.py" onChange={event => { setPath(event.target.value); setProblem(null); }} />
          {textFiles && <button className="button" type="submit">New text file</button>}
          <button className="button" type={textFiles ? 'button' : 'submit'} disabled={editing} title={editing ? wait : 'Pick a file on this computer'} onClick={textFiles ? choose : undefined}>Choose file…</button>
          <button className="button" type="button" onClick={close}>Cancel</button></div>
      </Field>
      {problem && <p className="error-box" role="alert">{problem}</p>}
    </form>}
  </section>;
}
