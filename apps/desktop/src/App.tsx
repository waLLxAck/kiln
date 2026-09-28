import { useViewMemory, useScrollMemory, useGroupBy, useSavedViews } from './view-memory';
import { BulkRemovalDialog } from './BulkLibrary';
import { inStage, matchesQuery, narrowest, parseTyped, sameToken, stages, statusLabel, tokenLabel, type QueryToken, type Stage } from './library-filters';
import { primarySkillLabel } from '../../../packages/providers/skill-locations';
import { SkillLocationSettings } from './Skills';
import { useCallback, useEffect, useMemo, useState, useRef, type MouseEvent } from 'react';
import { Activity, ArrowRight, ChevronRight, Copy, Download, ExternalLink, Folder, FolderGit2, FolderInput, FolderOpen, FolderPlus, FolderX, Github, Layers3, Loader2, MessageSquare, Pencil, Plus, RefreshCw, RotateCcw, Search, Settings, Star, Terminal, Trash2, Upload, X } from 'lucide-react';
import { Setup, type PreviousLibrary } from './Setup';
import { ChatPopover } from './Chat';
import { useKilnCommands } from './commands';
import { trialPlace, trialPlaces } from './trial-place';
import { CollectionsDialog, DeleteCollectionDialog, itemsWithin, MoveItemsDialog, useCollectionDrag } from './Collections';
import { isWithin, relocate, untitledName } from '../../../packages/domain/collections';
import { LocalSkillsDialog, RepositorySkillsDialog } from './Import';
import { sharedTitleIds, titleCollisions } from './item-source';
import { multiMachine } from './features';
import { MachinesView } from './Machines';
import { arrangeItems, defaultSort, groupItems, ItemBar, locationName, locationsFor, moveInOrder, nextSort, type Location } from './Library';
import { BulkBar, LibraryTable } from './LibraryTable';
import { QueryBar } from './QueryBar';
import { useLibrarySearch } from './library-search';
import { rankItems } from './library-sort';
import { CaptureDialog, type CaptureRequest, type CaptureSeed } from './CaptureComposer';
import { Rail, tools, UNFILED } from './Rail';
import { repoName, StatusBar } from './StatusBar';
import { OPEN_RESULT_TAB_EVENT, resultTarget, type RunRef } from './Runs';
import { requestSync, SyncSummary } from './Sync';
import { activeRun } from '../../../packages/agent/run-notice';
import type { Installation, Item, ItemDetail, Provider, ProviderId, Snapshot, Trial, UpdateStatus } from '../../../packages/protocol/schema';
import { api, date, platform, shortHash, variablesIn } from './api';
import { Badge, ContextMenu, Empty, Field, KilnMark, menuPoint, Modal, shortcutEntry, statusHelp, type MenuEntry } from './components';
import { useGlobalKeys } from './keyboard';
import { useUndoStack } from './UndoStack';
import { useItemDrag } from './ItemDrag';
import { ShortcutSheet } from './ShortcutSheet';
import { DeployDialog, ResultDialog, TrialDialog, VariablesDialog } from './dialogs';
import { ProjectInstallDialog } from './ProjectInstalls';
import { Detail } from './Detail';
import { RepositoryPanel } from './RepositoryPanel';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { AgentTrialDialog, CreateSkillDialog } from './AgentPanel';
import { personalTarget, ScanDialog, SkillInstallDialog, skillState } from './Skills';
import { CompareDialog } from './Compare';
import { updateInstalls } from './InstallUpdates';
import { canKeep, useKeepChanges } from './KeepChanges';
import { HomeFilesView } from './HomeFiles';
import { UpdatesPanel } from './Updates';
import { ASK_AGENT_EVENT, reviewOf, type AskAgentDetail } from './TrialLoop';
import { ExperimentsPage } from './ExperimentsPage';
import type { AgentJob } from '../../../packages/agent/service';
import type { CodexModel } from '../../../packages/agent/codex';

type Dialog = { name: string; workspace?: string; trial?: Trial; itemId?: string; itemIds?: string[]; provider?: ProviderId; targetId?: string; collection?: string } | null;
const hidden = ['archived', 'rejected'];
/** Whether an item shows under a collection filter: everything for none, the collection with its subfolders, or only unfiled items. */
const inCollection = (item: Item, collection: string) => !collection || (collection === UNFILED ? !item.collection : isWithin(item.collection, collection));
const sectionLabel: Record<string, string> = { library: 'Library', settings: 'Settings', archive: 'Archive', trash: 'Trash', ...Object.fromEntries(tools.map(t => [t.id, t.label])) };

export default function App() {
  const sidebar = usePanelWidth('kiln-sidebar-width', 250, 180, 360);
  // Paste, drop, the Capture button, Ctrl+N and the palette all open the capture dialog with their material.
  const [capture, setCapture] = useState<CaptureRequest>(); const captureCount = useRef(0);
  const [jobs,setJobs] = useState<AgentJob[]>([]);
  const [agentSyncError, setAgentSyncError] = useState('');
  const knownJobs = useRef<Map<string,string> | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const { section, collection, stage, selected, open: itemOpen, query, tokens, sort, key: viewKey,
    setSection, setCollection, setStage, setSelected, setOpen, setQuery, setTokens, setSort } = useViewMemory();
  const [group, setGroup] = useGroupBy();
  const savedViews = useSavedViews();
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  // "kind:" being typed is a filter on its way, not text to search for.
  const searchText = parseTyped(query).facet ? '' : query.trim();
  const { searchIds, close: closeMatches, searching, searchSort, setSearchSort } = useLibrarySearch(searchText, snapshot, message => setError(message));
  const searchSet = useMemo(() => searchIds && new Set(searchIds), [searchIds]);
  const libraryView = ['library', 'archive', 'trash'].includes(section);
  // An open item replaces the list; coming back puts the list where it was.
  const listShown = libraryView && !itemOpen;
  const listScroll = useScrollMemory(`list:${viewKey}`, Boolean(snapshot) && listShown && (!searchText || searchIds !== null), `${snapshot?.items.length}:${searchIds?.join(',') ?? ''}:${listShown}`);
  /** Rows picked with Ctrl-click, Shift-click or Ctrl+A. `selected` stays the focused row; two or more picked rows make right-click act on all of them. */
  const [bulkIds, setBulkIds] = useState<string[]>([]); const bulkRef = useRef<string[]>([]); bulkRef.current = bulkIds;
  const [bulkReview, setBulkReview] = useState<string[] | null>(null);
  useEffect(() => { setBulkIds([]); }, [query, tokens, collection, stage, section, snapshot?.root]);
  useEffect(() => { setBulkReview(null); }, [snapshot?.root]);
  const [dialog, setDialog] = useState<Dialog>(null); const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<CodexModel[] | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  // Reads the main process's last result: GitHub is only contacted by its own timer or by Check now, so this is cheap to repeat.
  const checkUpdate = useCallback((force = false) => api<UpdateStatus>('desktop.updateCheck', { force }).then(setUpdate).catch(() => undefined), []);
  useEffect(() => { void checkUpdate(); const onFocus = () => void checkUpdate(); window.addEventListener('focus', onFocus); const timer = setInterval(() => void checkUpdate(), 60_000); return () => { window.removeEventListener('focus', onFocus); clearInterval(timer); }; }, [checkUpdate]);
  useEffect(() => { if (update?.stage.state !== 'preparing') return; const timer = setInterval(() => void checkUpdate(), 500); return () => clearInterval(timer); }, [update?.stage.state, checkUpdate]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: Item[] } | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  // `kiln:ask-agent` (TrialLoop.tsx): open the chat about an item with a message typed in. The handler is refreshed each render so it sees the open item.
  const [chatSeed, setChatSeed] = useState<{ itemId: string; text: string; nonce: number } | null>(null); const askAgentRef = useRef<(detail: AskAgentDetail) => void>(() => {});
  useEffect(() => { const ask = (event: Event) => askAgentRef.current((event as CustomEvent<AskAgentDetail>).detail); window.addEventListener(ASK_AGENT_EVENT, ask); return () => window.removeEventListener(ASK_AGENT_EVENT, ask); }, []);
  useEffect(() => { if (!chatOpen) setChatSeed(null); }, [chatOpen]);
  /** The item whose experiments grid was asked for from outside its page (the list's Test, quick search). */
  const [testRequest, setTestRequest] = useState<{ id: string; at: number }>();
  // Right-click menu on a collection in the sidebar.
  const [collectionMenu, setCollectionMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  // Collapsed sidebar folders, remembered across restarts.
  const [collapsed, setCollapsed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('kiln-collapsed-collections') ?? '[]'); } catch { return []; } });
  const toggleCollapsed = (name: string) => setCollapsed(current => { const next = current.includes(name) ? current.filter(n => n !== name) : [...current, name]; localStorage.setItem('kiln-collapsed-collections', JSON.stringify(next)); return next; });
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [inventory, setInventory] = useState<{ root: string; resources: string[]; totalFiles: number; branch: string; changes: string[] } | null>(null);
  const [gitPreview, setGitPreview] = useState('');
  const [syncReport, setSyncReport] = useState<{ itemId: string; provider: ProviderId | 'codex-native'; result: string }[] | null>(null);
  const [conflicts, setConflicts] = useState<{ paths: string[]; items: { id: string; ours: Item | null; theirs: Item | null; baseText: string; oursText: string; theirsText: string }[]; otherPaths: string[] } | null>(null);
  const [theme, setTheme] = useState(localStorage.getItem('kiln-theme'));
  // Setup stays open after the repository is attached so the optional import step can run; "Connect a different repository" reopens it.
  const [setupOpen, setSetupOpen] = useState(false);
  const previousLibrary = useRef<PreviousLibrary>(null);
  const toggleTheme = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; setTheme(next); localStorage.setItem('kiln-theme', next); void api('desktop.theme', { theme: next }).catch(e => setError(String(e))); };
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => { const version = ++refreshVersion.current; const next = await api<Snapshot>('snapshot'); if (version === refreshVersion.current) setSnapshot(next); }, []);
  useEffect(() => {
    let active = true, pending = false, again = false, lastPoll = 0;
    const poll = async () => {
      if (pending) { again = true; return; }
      pending = true; lastPoll = Date.now();
      try {
        const current = await api<AgentJob[]>('agent.jobs'); if (!active) return;
        const changed = knownJobs.current && current.some(j => knownJobs.current!.get(j.id) !== j.status && j.status !== 'running');
        knownJobs.current = new Map(current.map(j => [j.id,j.status])); setJobs(current); setAgentSyncError('');
        if (changed) await refresh();
      } catch (e) { if (active) setAgentSyncError(`Agent updates disconnected. Retrying… ${String(e)}`); }
      finally { pending = false; if (active && again) { again = false; void poll(); } }
    };
    void poll(); const timer = setInterval(() => { if (!pending && ([...(knownJobs.current?.values() ?? [])].some(status => status === 'running' || status === 'queued') || Date.now() - lastPoll >= 5000)) void poll(); },1000);
    const start = () => void poll(); window.addEventListener('kiln:agent-started',start); window.addEventListener('kiln:agent-refresh',start);
    return () => { active = false; clearInterval(timer); window.removeEventListener('kiln:agent-started',start); window.removeEventListener('kiln:agent-refresh',start); };
  },[refresh,snapshot?.root]);
  /** Opens the capture dialog over whatever is on screen and hands it whatever was pasted or dropped. */
  const startCapture = (seed?: CaptureSeed) => setCapture({ id: ++captureCount.current, seed });
  const startCaptureRef = useRef(startCapture); startCaptureRef.current = startCapture;
  useEffect(() => {
    const paste = (event: ClipboardEvent) => { if ((event.target as Element)?.closest?.('input,textarea,[contenteditable],.modal')) return; const files = Array.from(event.clipboardData?.files ?? []); const text = event.clipboardData?.getData('text/plain') ?? ''; if (files.length || text) { event.preventDefault(); startCaptureRef.current({ files, text }); } };
    const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    const drop = (event: DragEvent) => { if ((event.target as Element)?.closest?.('.modal')) return; event.preventDefault(); startCaptureRef.current({ files: Array.from(event.dataTransfer?.files ?? []), text: event.dataTransfer?.getData('text/plain') }); };
    window.addEventListener('paste',paste); window.addEventListener('dragover',over); window.addEventListener('drop',drop); return () => { window.removeEventListener('paste',paste); window.removeEventListener('dragover',over); window.removeEventListener('drop',drop); };
  },[]);
  const perform = async (action: () => Promise<unknown>, success = '') => { setError(''); setBusy(true); const button = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null; button?.setAttribute('aria-busy','true'); try { await action(); if (success) setMessage(success); } catch (e) { const message = e instanceof Error ? e.message : String(e); setError(message); window.dispatchEvent(new CustomEvent('kiln:error', { detail: message })); } finally { setBusy(false); button?.removeAttribute('aria-busy'); } };
  // Keep these changes from the Installs rail, Machines and Compare; its dialog is rendered with the others below.
  const keeper = useKeepChanges({ items: snapshot?.items ?? [], installations, perform, refresh, onMessage: setMessage });
  useEffect(() => { void perform(refresh); void api<Provider[]>('providers.detect').then(setProviders).catch(e => setError(String(e))); }, []);
  useEffect(() => { if (section === 'settings' && models === null) void api<CodexModel[]>('agent.models').then(setModels).catch(() => setModels([])); }, [section, models]);
  useEffect(() => { const onFocus = () => void refresh().catch(e => setError(String(e))); window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus); }, [refresh]);
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 6000); return () => clearTimeout(timer); }, [message]);
  // A sidebar collection being named in place: a new "New Folder", or one chosen with Rename or F2.
  const [renamingCollection, setRenamingCollection] = useState<string | null>(null);
  const expandCollection = (name: string) => { if (collapsed.includes(name)) toggleCollapsed(name); };
  /** Keeps the library pointed at a collection that was renamed or moved, whether it was the one shown or a folder above it. */
  const followCollection = (from: string, to: string) => { if (collection && isWithin(collection, from)) setCollection(relocate(collection, from, to)); };
  /** Creates "New Folder" (or the next free number) at once and opens it for naming, like a file manager: nothing to type first. */
  const newCollection = (parent = '') => void perform(async () => { const created = await api<{ name: string }>('collections.create', { name: untitledName(snapshot?.collections ?? [], parent) }); if (parent) expandCollection(parent); await refresh(); setRenamingCollection(created.name); });
  const renameCollection = (from: string, to: string) => perform(async () => { const renamed = await api<{ to: string }>('collections.rename', { from, to }); await refresh(); followCollection(from, renamed.to); setRenamingCollection(null); });
  // Keyboard navigation and undo (keyboard.ts, UndoStack.tsx, ItemDrag.tsx, ShortcutSheet.tsx): the stack of the last 20 library
  // actions with Ctrl+Z, the ? sheet, and rows dragged onto sidebar collections. The table's own keys live in LibraryTable.
  const undoStack = useUndoStack({ root: snapshot?.root, perform, refresh, setMessage });
  const [sheet, setSheet] = useState(false); useGlobalKeys({ undo: () => undoStack.undo(), sheet: () => setSheet(true) });
  const itemDrag = useItemDrag({ onMove: (items, to) => void undoStack.move(items, to).then(() => setBulkIds([])) });
  const collectionDrag = useCollectionDrag(snapshot?.collections ?? [], (name, { parent, before }) => void perform(async () => { const moved = await api<{ to: string }>('collections.move', { name, parent, before }); if (parent) expandCollection(parent); await refresh(); followCollection(name, moved.to); }), name => !collapsed.includes(name));
  // Remember the library Kiln started with when it is not a ready repository, so setup can offer to carry its items over.
  useEffect(() => { if (snapshot && !snapshot.repository.ready && !previousLibrary.current) previousLibrary.current = { root: snapshot.root, items: snapshot.items.filter(i => !i.deletedAt).length, standard: snapshot.repository.standard, dedicated: snapshot.repository.dedicated }; }, [snapshot]);
  // While an approval is being committed or pushed, poll so the item shows when it reached GitHub.
  useEffect(() => { if (!snapshot?.publish.some(j => !['done', 'failed'].includes(j.status))) return; const timer = setTimeout(() => void refresh().catch(() => undefined), 1500); return () => clearTimeout(timer); }, [snapshot, refresh]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let active = true;
    // A selection remembered from another library (or a purged item) is simply dropped; every other failure is shown.
    void api<ItemDetail>('items.read', { id: selected }).then(data => { if (active) setDetail(data); }).catch(e => { if (!active) return; setDetail(null); if (/ITEM_NOT_FOUND/.test(String(e))) { setSelected(''); setOpen(false); localStorage.removeItem('kiln-selected'); } else setError(String(e)); });
    localStorage.setItem('kiln-selected', selected); return () => { active = false; };
  }, [selected, snapshot]);
  // Items sharing a title show where each came from; an import's full folder is kept on this machine only, so ask for it.
  const [origins, setOrigins] = useState<Record<string, string>>({});
  const sharedTitles = snapshot ? sharedTitleIds(snapshot.items).sort().join(',') : '';
  useEffect(() => { if (!sharedTitles) { setOrigins({}); return; } let active = true; void api<Record<string, string>>('items.origins', { ids: sharedTitles.split(',') }).then(result => { if (active) setOrigins(result); }).catch(() => {}); return () => { active = false; }; }, [sharedTitles]);
  // Machines: share this machine's installs with the rest of the fleet, now and after each change (see packages/fleet).
  // Never started while Machines manages this machine only, so no machine report is committed.
  useEffect(() => { if (multiMachine) void api('fleet.start').catch(() => {}); }, []);
  // Installation state for every skill: drives the Installed column, the Installed stage and the install menus.
  useEffect(() => { if (!snapshot) return; let active = true; void api<Installation[]>('deploy.installations').then(result => { if (active) setInstallations(result); }).catch(() => {}); return () => { active = false; }; }, [snapshot]);
  useEffect(() => {
    const chosenTheme = theme ?? snapshot?.settings.theme;
    document.documentElement.dataset.theme = chosenTheme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : chosenTheme ?? 'light';
  }, [snapshot?.settings.theme, theme]);
  // Read by the window-wide keys below, which are registered once.
  const keys = useRef({ itemOpen: false, step: (_direction: number) => {} });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]');
      if (event.key === 'Escape' && !document.querySelector('dialog[open], .context-menu, .chat-popover, .lightbox') && !typing) {
        // Back from an item, focus returns to its row so the list keys carry on from there.
        if (keys.current.itemOpen) { setOpen(false); requestAnimationFrame(() => document.querySelector<HTMLElement>('.item-card.selected')?.focus({ preventScroll: true })); } else if (bulkRef.current.length) setBulkIds([]); else setSelected('');
        return;
      }
      if (event.altKey && keys.current.itemOpen && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && !typing) { event.preventDefault(); keys.current.step(event.key === 'ArrowDown' ? 1 : -1); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); void api('desktop.palette'); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); startCaptureRef.current(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        const focus = () => { const search = document.querySelector<HTMLInputElement>('input[aria-label="Search library"]'); search?.focus(); search?.select(); };
        if (keys.current.itemOpen) { event.preventDefault(); setOpen(false); requestAnimationFrame(focus); } else if (document.querySelector('input[aria-label="Search library"]')) { event.preventDefault(); focus(); }
      }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, []);
  /** Rail choices. Choosing the place you are already in brings the list back from an open item; elsewhere its view is restored as it was. */
  const navigate = (name: string) => { if (name === 'library' && section === 'library') { setStage(''); setOpen(false); } else { setSection(name); if (name === section) setOpen(false); } };
  const chooseStage = (next: Stage) => { const same = section === 'library' && stage === next; setStage(next); if (same) setOpen(false); };
  /** A collection from the sidebar filters the library in place. */
  const openCollection = (name: string) => { const same = section === 'library' && collection === name; setSection('library'); setCollection(name); if (same) setOpen(false); };
  const select = (id: string) => { setSelected(id); setBulkIds([]); };
  /** Opens an item as a page over the list. */
  const openItem = (id: string) => { select(id); setOpen(true); };
  /** Everything made from a source, across collections: the whole library with only a `from:` token. */
  const showMadeFrom = (sourceId: string) => { setStage(''); setQuery(''); setTokens([{ facet: 'from', value: sourceId }]); setOpen(false); };
  /** Shows one item in an unfiltered view of `destination`, opened as a page unless `open` is false (a fresh capture stays in the list). */
  const revealItem = (id: string, destination = 'library', open = true) => { if (destination === 'library') setStage(''); else { setSection(destination); setCollection(''); } setQuery(''); setTokens([]); select(id); setOpen(open); };
  useEffect(() => { const open = () => { const id = new URLSearchParams(location.hash.slice(1)).get('item'); if (id) { revealItem(id); history.replaceState(null, '', location.pathname + location.search); } }; open(); window.addEventListener('hashchange', open); return () => window.removeEventListener('hashchange', open); }, []);
  // Quick search (Palette.tsx) asks for these through desktop.command; main.ts has already shown this window.
  /** Quick search reads the library itself, so it can name an item this window has not loaded yet (made by the CLI, MCP or a sync); the page needs it in the snapshot. */
  const revealFresh = (id: string, then?: () => void) => void perform(async () => { if (!snapshot?.items.some(i => i.id === id)) await refresh(); revealItem(id); then?.(); });
  useKilnCommands({
    capture: () => startCapture(),
    'open-item': id => { if (id) revealFresh(id); },
    'test-item': id => { if (id) revealFresh(id, () => setTestRequest({ id, at: Date.now() })); },
    navigate: id => { if (id) navigate(id); },
    'sync-installs': () => { navigate('settings'); void perform(async () => { setSyncReport(await api('skills.sync')); await refresh(); }); },
    'new-collection': () => { setSection('library'); newCollection(); },
    'toggle-theme': toggleTheme,
    'ask-item': id => { if (id) revealFresh(id, () => setChatOpen(true)); },
    'check-updates': () => { navigate('settings'); void perform(() => checkUpdate(true), 'Checked for updates'); },
  });
  const completed = async (id?: string) => { setDialog(null); await refresh(); if (id) revealItem(id); setMessage('Saved'); };
  const captured = async (id: string, analyzing: boolean) => { await refresh(); if (analyzing) setMessage('Analysis started. Its progress shows in the status bar.'); else { revealItem(id, 'library', false); setMessage('Saved'); } };
  const copyItem = async (item: Item) => {
    const data = await api<ItemDetail>('items.read', { id: item.id });
    if (variablesIn(data.revision.content).length) { select(item.id); setDetail(data); setDialog({ name: 'variables' }); return; }
    await api('desktop.copy', { id: item.id, revision: item.revision }); await refresh(); setMessage('Copied to clipboard');
  };
  /** Test from the list or quick search: the item opens on its experiments grid, whose run bar starts a run. */
  const testItem = (item: Item) => { openItem(item.id); setTestRequest({ id: item.id, at: Date.now() }); };
  const archiveItem = (item: Item) => void undoStack.apply([item], () => ({ status: 'archived' }));
  /** Records approval of the current revision; the router then commits and pushes it to the Kiln repo. */
  const approveCurrent = async (target: ItemDetail) => {
    const evidence = target.trials.filter(t => t.revision === target.item.revision && t.status === 'completed');
    const complete = ['typical', 'boundary'].every(testCase => evidence.some(t => t.case === testCase && t.judgement === 'pass'));
    await api('approvals.approve', { id: target.item.id, revision: target.item.revision, reviewer: 'Local user', scope: 'Current revision', note: 'Approved by clicking Approve in Kiln.', evidence: evidence.map(t => t.id), waivedChecks: complete ? '' : 'Manual approval without requiring passing typical and boundary trials.' });
  };
  const action = (name: string, trial?: Trial) => {
    if (name === 'delete-trial' && trial) {
      if (busy) return;
      void perform(async () => { await api('trials.delete', { id: trial.id }); setJobs(await api<AgentJob[]>('agent.jobs')); await refresh(); }, 'Experiment deleted');
      return;
    }
    if (name === 'purge' && detail) { setDialog({ name: 'purge', itemId: detail.item.id }); return; }
    if (name === 'unapprove' && detail) {
      if (busy) return;
      void perform(async () => { await api('approvals.unapprove', { id: detail.item.id, revision: detail.item.revision }); await refresh(); }, 'Approval removed');
      return;
    }
    if (name === 'approve' && detail) {
      if (busy) return;
      void perform(async () => { await approveCurrent(detail); await refresh(); }, 'Approved. Committing and pushing to GitHub in the background.');
      return;
    }
    if (name === 'approve-install' && detail) {
      // Approve, then install into every configured skill location. The push to GitHub runs in the background meanwhile.
      if (busy) return;
      void perform(async () => {
        const isApproved = detail.approvals.some(a => a.revision === detail.item.revision && a.trust === 'local');
        if (!isApproved) await approveCurrent(detail);
        const locations = providers.filter(p => detail.item.kind === 'agent' ? p.id === detail.item.agent?.provider : p.id !== 'copilot').map(p => ({ provider: p, target: snapshot && personalTarget(snapshot.targets, providers, p.id) })).filter(l => l.target) as { provider: Provider; target: NonNullable<ReturnType<typeof personalTarget>> }[];
        const done: string[] = [], failed: string[] = [];
        for (const { provider, target } of locations) {
          try { await api('skills.install', { itemId: detail.item.id, targetId: target.id, confirm: true }); done.push(detail.item.kind === 'agent' ? provider.label : primarySkillLabel(provider.id)); }
          catch (e) { failed.push(`${provider.label}: ${(e instanceof Error ? e.message : String(e)).replace(/^[A-Z_]+: /, '')}`); }
        }
        await refresh();
        if (failed.length) throw new Error(`${done.length ? `Installed for ${done.join(', ')}. ` : ''}Not installed for ${failed.join('; ')}`);
        setMessage(`${isApproved ? 'Installed' : 'Approved and installed'} for ${done.join(' and ')}. Start a new agent session to use it.`);
      });
      return;
    }
    if ((name === 'update-installs' || name === 'approve-update-installs') && detail) {
      // The item header's Update installs (N) / Approve & update installs.
      if (busy) return;
      void perform(async () => { const note = await updateInstalls(detail.item, name === 'approve-update-installs'); await refresh(); setMessage(note); });
      return;
    }
    if (name === 'copy' && detail && variablesIn(detail.revision.content).length === 0) { void perform(async () => { await api('desktop.copy', { id: detail.item.id, revision: detail.item.revision }); await refresh(); }, 'Copied to clipboard'); return; }
    if (name === 'purge' && detail) { setDialog({ name: 'purge', itemId: detail.item.id }); return; }
    if (name.startsWith('keep:')) { const [, itemId, targetId] = name.split(':'); keeper.keep(itemId, targetId); return; }
    setDialog({ name: name === 'copy' ? 'variables' : name, trial });
  };
  const updateAction = (restart: boolean) => void perform(async () => {
    if (updating) return; setUpdating(true);
    try { if (restart) await api('desktop.updateRestart'); else setUpdate(await api<UpdateStatus>('desktop.updatePrepare', { version: update?.available?.version })); }
    finally { setUpdating(false); await checkUpdate(); }
  });
  const toggleInstall = (itemId: string, provider: ProviderId, targetId?: string) => { const target = snapshot && (targetId ? snapshot.targets.find(t => t.id === targetId) : personalTarget(snapshot.targets, providers, provider)); if (!target) { navigate('settings'); return; } setDialog({ name: 'skill-install', itemId, provider, targetId: target.id }); };
  const updateLocation = async (provider: Provider, on: boolean, native = false) => {
    const existing = snapshot && personalTarget(snapshot.targets, providers, provider.id, native);
    if (on && !existing) await api('targets.enroll', { name: `${native ? 'Codex-specific' : primarySkillLabel(provider.id)} skills`, root: provider.personalRoot, provider: provider.id, scope: 'personal', profile: 'Personal', ...(native ? { skillFolder: '.codex/skills' } : {}) });
    if (!on && existing) await api('targets.remove', { id: existing.id, confirm: true });
    await refresh();
  };
  const setLocation = (provider: Provider, on: boolean, native = false) => void perform(() => updateLocation(provider, on, native), on ? `${native ? 'Codex-specific' : primarySkillLabel(provider.id)} skills folder is now managed by Kiln. Nothing was installed yet.` : `Kiln stopped managing the ${native ? 'Codex-specific' : primarySkillLabel(provider.id)} skills folder. Installed files were left in place.`);
  if (!snapshot) return <div className="startup"><span className="brand-symbol"><KilnMark /></span><h1>Kiln</h1><p>{error || 'Opening your workbench…'}</p>{error && <button className="button" onClick={() => void perform(refresh)}>Retry</button>}</div>;
  // Kiln only works on a Kiln repository connected to GitHub. Anything else lands here until one is connected.
  if (!snapshot.repository.ready || setupOpen) return <Setup snapshot={snapshot} previous={previousLibrary.current} providers={providers} onSetLocation={updateLocation} onRefresh={refresh} onAttach={async root => { await api('desktop.attach', { root }); setSelected(''); await refresh(); setSetupOpen(true); }} onDone={async (review = false) => { await refresh(); setStage(''); setQuery(''); setTokens([]); setSelected(''); setOpen(false); setSetupOpen(false); if (review) setMessage('Use Select all, then choose a bulk action. You can narrow the list with filters first.'); }} />;
  const live = snapshot.items.filter(i => !i.deletedAt);
  const isHidden = (i: Item) => hidden.includes(i.status);
  // How many live items each item was made from, for sources' Status column and `from:` suggestions.
  const madeCount = new Map<string, number>(); for (const i of live) if (i.origin) madeCount.set(i.origin.itemId, (madeCount.get(i.origin.itemId) ?? 0) + 1);
  // The newest experiment on each item, for the Last test column. Built once per render from the snapshot, never per row.
  const places = trialPlaces(jobs);
  const lastTrial = new Map<string, Trial>(); for (const t of snapshot.trials) if (!t.deletedAt && !reviewOf(t) && (!lastTrial.has(t.itemId) || lastTrial.get(t.itemId)!.createdAt < t.createdAt)) lastTrial.set(t.itemId, t);
  // Each filter is a predicate, so the query bar can count what a token would show under all the others.
  const inSection = (i: Item) => (section === 'trash' ? Boolean(i.deletedAt) : !i.deletedAt) && (section === 'archive' ? isHidden(i) : section === 'trash' || !isHidden(i));
  // Until the first results arrive the list stays as it was; after that the previous results stay until the next ones replace them.
  const bySearch = (i: Item) => !searchText || !searchSet || searchSet.has(i.id);
  const byStage = (i: Item) => section !== 'library' || inStage(i, stage, installations);
  /** The view before search and tokens: its section, collection or stage. Suggestions count from here. */
  const base = snapshot.items.filter(i => inSection(i) && inCollection(i, collection) && byStage(i));
  const countFor = (withTokens: QueryToken[], text: string) => base.filter(i => (!text || bySearch(i)) && matchesQuery(i, installations, withTokens)).length;
  // Every view starts newest added first until another order is picked; inside a collection (Unfiled too) its sources lead.
  // A search orders by relevance; another order picked during it lasts until the search is cleared, then the view's own order is back.
  const relevance = Boolean(searchText) && (searchSort ?? 'relevance') === 'relevance';
  const order = (searchText && searchSort && searchSort !== 'relevance' ? searchSort : sort) ?? defaultSort, pinSources = Boolean(collection);
  const found = base.filter(i => bySearch(i) && matchesQuery(i, installations, tokens));
  const matching = relevance && searchIds ? rankItems(found, searchIds, pinSources) : arrangeItems(found, order, snapshot.usage, pinSources);
  const groups = groupItems(matching, group);
  /** The rows in the order shown, groups included: what ranges, Select all and the item page's steps walk through. */
  const shown = groups.flatMap(g => g.items);
  const bulkItems = shown.filter(item => bulkIds.includes(item.id));
  /** Plain click opens the item. Ctrl-click toggles a row in the selection; Shift-click extends it from the focused row, like a file manager. */
  const clickRow = (event: MouseEvent, item: Item) => {
    const ids = shown.map(i => i.id);
    if (event.shiftKey && ids.includes(selected)) { const [a, b] = [ids.indexOf(selected), ids.indexOf(item.id)]; setBulkIds(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    if (event.ctrlKey || event.metaKey) {
      const base = bulkItems.length > 1 ? bulkIds : ids.includes(selected) ? [selected] : [];
      const next = base.includes(item.id) ? base.filter(id => id !== item.id) : [...base, item.id];
      if (next.length <= 1) { setSelected(next[0] ?? ''); setBulkIds([]); } else { setBulkIds(next); if (!ids.includes(selected)) setSelected(item.id); }
      return;
    }
    if (bulkItems.length > 1) { select(item.id); return; }
    openItem(item.id);
  };
  const selectAll = () => { if (shown.length > 1) { setBulkIds(shown.map(i => i.id)); if (!shown.some(i => i.id === selected)) setSelected(shown[0].id); } };
  const sourceTitle = (id: string) => snapshot.items.find(i => i.id === id)?.title;
  const stageName = stages.find(s => s.id === stage)?.label;
  const sectionName = (collection === UNFILED ? 'Unfiled' : collection.replaceAll('/', ' / ')) || (section === 'library' && stageName) || sectionLabel[section] || 'Library';
  const locations: Location[] = providers.map(p => ({ provider: p, target: personalTarget(snapshot.targets, providers, p.id) })).filter((l): l is Location => Boolean(l.target));
  const configured = locations;
  // Two items with one title (the same skill name imported from different folders) show where each came from.
  const sameTitle = titleCollisions(snapshot.items, providers[0]?.personalRoot, origins);
  const openTrialItem = (itemId: string) => {
    const item = snapshot.items.find(i => i.id === itemId);
    revealItem(itemId, item?.deletedAt ? 'trash' : item?.status === 'archived' || item?.status === 'rejected' ? 'archive' : 'library');
  };
  /** "Open result" on a finished run (runs list, toast, desktop notification): the item on the view that holds it, or the chat. */
  const openRun = (job: RunRef) => {
    const target = resultTarget(job);
    const show = () => { if (target.view === 'tests') setTestRequest({ id: target.itemId, at: Date.now() }); if (target.view === 'chat') setChatOpen(true); window.dispatchEvent(new CustomEvent(OPEN_RESULT_TAB_EVENT, { detail: { kind: job.kind } })); };
    if (snapshot.items.some(i => i.id === target.itemId)) { openTrialItem(target.itemId); show(); } else revealFresh(target.itemId, show);
  };
  const reorderSelected = (direction: number) => { const ids = moveInOrder(matching, selected, direction, pinSources); if (ids) void perform(async () => { await api('items.reorder', { ids }); await refresh(); }); };
  /** Right-click on a picked row acts on the whole selection; on any other row it focuses that row first, as a file manager would. */
  const openMenu = (event: MouseEvent, item: Item) => { event.preventDefault(); const many = bulkItems.length > 1 && bulkIds.includes(item.id); if (!many) select(item.id); setMenu({ ...menuPoint(event), items: many ? bulkItems : [item] }); };
  const statusKeys: Record<string, string> = { captured: '1', testing: '2', approved: '3', rejected: '4', archived: 'A' };
  const capital = (word: string) => word[0].toUpperCase() + word.slice(1);
  const hasCopies = (item: Item) => ['skill', 'agent'].includes(item.kind) && installations.some(i => i.itemId === item.id);
  const menuEntries = (items: Item[]): MenuEntry[] => items.length === 1 ? singleEntries(items[0]) : bulkEntries(items);
  /** The same menu as for one item, with the actions that make sense for many. Each action runs over every picked item, then the selection clears. */
  const bulkEntries = (items: Item[]): MenuEntry[] => {
    // One undoable action over them all, in small batches with progress (UndoStack.tsx).
    const each = (patch: (item: Item) => Record<string, unknown> | null) => () => void undoStack.apply(items, patch).then(() => setBulkIds([]));
    const label = `${items.length} items`, allFavourite = items.every(i => i.favourite), trashed = items.some(i => i.deletedAt);
    const entries: MenuEntry[] = [{ heading: `${label} selected` }, { label: allFavourite ? 'Remove from favourites' : 'Add to favourites', icon: <Star />, shortcut: 'F', onSelect: each(i => i.favourite === !allFavourite ? null : { favourite: !allFavourite }) }];
    if (!trashed) {
      entries.push('separator', { heading: 'Status' });
      for (const status of ['captured', 'testing', 'approved', 'rejected', 'archived'] as const) { const all = items.every(i => i.status === status); entries.push({ label: capital(statusLabel[status]), checked: all, disabled: status === 'approved' || all, shortcut: statusKeys[status], hint: status === 'approved' ? 'Approve items one at a time; approval always names an exact revision.' : statusHelp[status], onSelect: each(i => i.status === status ? null : { status }) }); }
      if (items.some(hasCopies)) entries.push('separator', { label: 'Remove local copies…', icon: <FolderX />, shortcut: 'L', hint: 'Preview and remove every installed copy of the picked skills and agents, in every configured folder. Library items stay.', onSelect: () => setBulkReview(items.map(i => i.id)) });
    }
    entries.push('separator', { label: 'Move to collection…', icon: <FolderInput />, shortcut: 'M', hint: 'File them in another collection or none. Approvals and installed copies stay.', onSelect: () => setDialog({ name: 'move-items', itemIds: items.map(i => i.id) }) }, 'separator');
    if (trashed) entries.push({ label: 'Restore from trash', icon: <RotateCcw />, shortcut: 'R', onSelect: each(() => ({ deleted: false })) }, { label: 'Delete permanently…', icon: <Trash2 />, danger: true, shortcut: 'D', onSelect: () => setDialog({ name: 'purge-many', itemIds: items.map(i => i.id) }) });
    else entries.push({ label: 'Move to trash', icon: <Trash2 />, danger: true, shortcut: 'D', hint: 'Recoverable from Trash. Installed copies are untouched.', onSelect: each(() => ({ deleted: true })) });
    return entries;
  };
  /** One entry per skill folder the item can go into, checked where a copy is. Used by the right-click menu and the row's Install ▾. */
  const installEntries = (item: Item): MenuEntry[] => locationsFor(item, configured).map(({ provider, target }) => { const { state } = skillState(item, target, installations); return { label: `${locationName(item, provider)}${state === 'off' || state === 'on' ? '' : ` · ${state}`}`, icon: <Download />, checked: state !== 'off', hint: state === 'off' ? 'Install the approved version here' : 'Manage or remove this copy', onSelect: () => toggleInstall(item.id, provider.id) }; });
  const installMenu = (item: Item): MenuEntry[] => { const entries = installEntries(item); return entries.length ? [{ heading: `Install ${item.title} into` }, ...entries] : [{ label: 'Set up skill folders…', icon: <Settings />, hint: 'Choose the Agents and Claude folders in Settings', onSelect: () => navigate('settings') }]; };
  const singleEntries = (item: Item): MenuEntry[] => {
    const meta = (patch: Record<string, unknown>) => () => void undoStack.apply([item], () => patch);
    const entries: MenuEntry[] = [
      { label: 'Open', icon: <ArrowRight />, shortcut: 'O', onSelect: () => openItem(item.id) },
      // A source is the material an analysis read, not something to paste.
      ...(item.kind === 'source' ? [] : [{ label: 'Copy', icon: <Copy />, shortcut: 'C', onSelect: () => void perform(() => copyItem(item)) }]),
      { label: item.favourite ? 'Remove from favourites' : 'Add to favourites', icon: <Star />, shortcut: 'F', onSelect: meta({ favourite: !item.favourite }) },
      { label: item.kind === 'source' ? 'Open original' : item.kind === 'link' ? 'Open link in browser' : ['file', 'image', 'reference'].includes(item.kind) ? 'Reveal stored file' : 'Open stored file', icon: <ExternalLink />, shortcut: 'E', onSelect: () => void perform(() => api('desktop.openItem', { id: item.id })) },
    ];
    if (item.kind === 'source') entries.push({ label: 'Show what was made from it', icon: <Layers3 />, shortcut: 'W', hint: 'The library filtered to items made from this source, wherever they are filed.', disabled: !madeCount.get(item.id), onSelect: () => showMadeFrom(item.id) });
    else if (item.origin && snapshot.items.some(i => i.id === item.origin!.itemId && i.kind === 'source')) entries.push({ label: 'Open its source', icon: <ArrowRight />, shortcut: 'S', onSelect: () => revealItem(item.origin!.itemId) });
    if (!item.deletedAt) {
      entries.push('separator', { heading: 'Status' });
      for (const status of ['captured', 'testing', 'approved', 'rejected', 'archived'] as const) entries.push({ label: capital(statusLabel[status]), checked: item.status === status, disabled: status === 'approved' || item.status === status, shortcut: statusKeys[status], hint: status === 'approved' ? 'Use Approve on the item; approval always names an exact revision.' : status === 'archived' ? `${statusHelp[status]} Swipe the item sideways to archive it too.` : statusHelp[status], onSelect: status === 'archived' ? () => archiveItem(item) : meta({ status }) });
      if (['skill', 'agent'].includes(item.kind) && configured.length) entries.push('separator', { heading: 'Installed for' }, ...installEntries(item));
      if (hasCopies(item)) entries.push('separator', { label: 'Remove local copies…', icon: <FolderX />, shortcut: 'L', hint: 'Preview and remove every installed copy in every configured folder, including other providers. The library item stays.', onSelect: () => setBulkReview([item.id]) });
    }
    entries.push('separator', { label: 'Move to collection…', icon: <FolderInput />, shortcut: 'M', hint: 'File it in another collection or none. Approval and installed copies stay.', onSelect: () => setDialog({ name: 'move-items', itemIds: [item.id] }) }, 'separator');
    if (item.deletedAt) entries.push({ label: 'Restore from trash', icon: <RotateCcw />, shortcut: 'R', onSelect: meta({ deleted: false }) }, { label: 'Delete permanently…', icon: <Trash2 />, danger: true, shortcut: 'D', onSelect: () => setDialog({ name: 'purge', itemId: item.id }) });
    else entries.push({ label: 'Move to trash', icon: <Trash2 />, danger: true, shortcut: 'D', hint: 'Recoverable from Trash. Installed copies are untouched.', onSelect: meta({ deleted: true }) });
    return entries;
  };
  /** Right-click menu for a sidebar collection. Deleting asks whether the items stay in the library or go to the trash. */
  const collectionEntries = (name: string): MenuEntry[] => {
    const inside = itemsWithin(snapshot.items, name).length;
    return [
      { label: 'Show in library', icon: <Folder />, shortcut: 'O', onSelect: () => openCollection(name) },
      { label: 'New subfolder', icon: <FolderPlus />, shortcut: 'N', hint: 'Adds “New Folder” inside it, ready to name.', onSelect: () => newCollection(name) },
      { label: 'Rename', icon: <Pencil />, shortcut: 'R', hint: 'Its subfolders and items keep up with the new name. Drag it onto another collection to nest it.', onSelect: () => setRenamingCollection(name) },
      { label: 'Manage collections…', icon: <Settings />, onSelect: () => setDialog({ name: 'collections' }) },
      'separator',
      { label: 'Delete collection…', icon: <Trash2 />, danger: true, shortcut: 'D', hint: inside ? `Asks whether its ${inside} item${inside === 1 ? '' : 's'} stay in the library or move to the trash.` : 'Removes this empty collection from the sidebar.', onSelect: () => setDialog({ name: 'delete-collection', collection: name }) },
    ];
  };
  /** Approved and pushed: the last publish job for this item finished, or there is none and nothing waits to be pushed. */
  const published = (item: Item) => { if (item.status !== 'approved') return false; const job = snapshot.publish.find(j => j.itemId === item.id && j.revision === item.revision); return job ? job.status === 'done' : snapshot.git.ahead === 0; };
  const purgeTarget = dialog?.name === 'purge' ? snapshot.items.find(i => i.id === dialog.itemId) : undefined;
  const installTarget = dialog?.name === 'skill-install' ? { item: snapshot.items.find(i => i.id === dialog.itemId), provider: providers.find(p => p.id === dialog.provider), target: snapshot.targets.find(t => t.id === dialog.targetId) } : null;
  // The chat is about the focused item. A video, or an entry distilled from one, brings the transcript along; the video is recognised by the tags prepareVideo adds.
  // Sources carry the material behind their entries; a video captured before sources existed counts as one too.
  const isSource = (i: Item | undefined) => Boolean(i && (i.kind === 'source' || (i.kind === 'link' && i.tags.includes('youtube'))));
  const chatItem = libraryView ? snapshot.items.find(i => i.id === selected && !i.deletedAt) ?? null : null;
  askAgentRef.current = ({ itemId, message }) => { if (chatItem?.id !== itemId) revealItem(itemId); setChatSeed({ itemId, text: message, nonce: Date.now() }); setChatOpen(true); };
  const sourceBehind = !chatItem ? null : isSource(chatItem) ? chatItem : (() => { const origin = chatItem.origin ? snapshot.items.find(i => i.id === chatItem.origin!.itemId) : undefined; return isSource(origin) ? origin! : null; })();
  // The open item's page. It stays open when a filter hides it; the bar then says so instead of a position.
  const itemView = libraryView && itemOpen && snapshot.items.some(i => i.id === selected);
  const position = shown.findIndex(i => i.id === selected) + 1;
  const step = (direction: number) => { const next = shown[position - 1 + direction]; if (position > 0 && next) setSelected(next.id); };
  keys.current = { itemOpen: itemView, step };
  const filtering = Boolean(searchText) || tokens.length > 0;
  const rescue = !matching.length && filtering ? narrowest(tokens, searchText, countFor) : null;
  const clearQuery = () => { setQuery(''); setTokens([]); };
  const emptyState = <div className="list-empty"><Search size={22} />
    {filtering ? <><p>{`Nothing matches ${tokens.length + (searchText ? 1 : 0) > 1 ? `all ${tokens.length + (searchText ? 1 : 0)} filters` : 'this filter'}${collection || stage ? ` in ${sectionName}` : ''}.`}</p>
      {rescue && rescue.count > 0 && <p className="muted small">The narrowest is <span className="q-inline">{rescue.token ? `${rescue.token.facet}: ${tokenLabel(rescue.token, sourceTitle)}` : `“${searchText}”`}</span>. Without it you would see {rescue.count} item{rescue.count === 1 ? '' : 's'}.</p>}
      <div className="wrap-actions center">{rescue && rescue.count > 0 && <button className="button" onClick={() => rescue.token ? setTokens(tokens.filter(t => !sameToken(t, rescue.token!))) : setQuery('')}>Remove it</button>}<button className="text-button" onClick={clearQuery}>Clear search and filters <X size={13} /></button></div></>
      : <><p>{section === 'trash' ? 'The trash is empty.' : section === 'archive' ? 'Nothing archived or rejected.' : stage ? `Nothing in ${stageName} right now.` : collection ? 'Nothing in this collection yet.' : 'Nothing here yet.'}</p>{section === 'library' && <button className="text-button" onClick={() => startCapture()}>Capture your first item <Plus size={13} /></button>}</>}
    {!live.length && section === 'library' && <div className="welcome-import"><h2>Already have skills?</h2><p>Bring them in as drafts, then approve the ones you want in your Kiln repository. Nothing is moved where it lives now.</p><div className="wrap-actions"><button className="button" onClick={() => setDialog({ name: 'import-local' })}><Download size={15} />Import my installed skills</button><button className="button" onClick={() => setDialog({ name: 'import-repo' })}><Upload size={15} />Import from a skills repository…</button></div></div>}
  </div>;
  /** What a single-key shortcut does on a focused row: the matching entry of its menu, or of the selection's. */
  const rowShortcut = (event: globalThis.KeyboardEvent, id: string) => { const target = bulkItems.length > 1 ? bulkItems : shown.filter(i => i.id === id); const hit = target.length > 0 && !menu ? shortcutEntry(menuEntries(target), event) : null; return hit ? () => { if (id !== selected && bulkItems.length < 2) select(id); hit.onSelect?.(); } : null; };
  /** Shift with the list keys: `ids` picked, `anchor` the open row they extend from. */
  const pickRange = (ids: string[], anchor: string) => { setSelected(anchor); setBulkIds(ids); };
  const libraryPage = <section className="library-page">
    <div className="list-heading"><h2>{sectionName} <span>{matching.length}</span></h2><span className="inline">{matching.length > 1 && <button className="button" onClick={selectAll}>Select all</button>}{section === 'trash' && matching.length > 0 && <button className="button danger-text" onClick={() => setDialog({ name: 'empty-trash' })}><Trash2 size={14} />Empty trash</button>}<button className="icon-button" aria-label="Refresh library" onClick={() => void perform(refresh)}><RefreshCw size={17} /></button></span></div>
    <QueryBar tokens={tokens} onTokens={setTokens} query={query} onQuery={setQuery} pool={base} installations={installations} sources={snapshot.items.filter(i => i.kind === 'source')} saved={savedViews}
      sort={order} onSort={searchText ? setSearchSort : setSort} relevance={searchText ? { active: relevance, onPick: () => setSearchSort('relevance') } : undefined} searching={searching} close={Boolean(searchText) && closeMatches}
      group={group} onGroup={setGroup} canReorder={!relevance && bulkItems.length < 2 && order.key === 'order' && group === 'none'} reorder={reorderSelected} reorderDisabled={[!moveInOrder(matching, selected, -1, pinSources), !moveInOrder(matching, selected, 1, pinSources)]}
      onLeave={() => { if (!shown.length) return; if (!shown.some(i => i.id === selected)) select(shown[0].id); requestAnimationFrame(() => document.querySelector<HTMLElement>('.item-card.selected')?.focus()); }} />
    {bulkItems.length > 1 && <BulkBar items={bulkItems} entries={bulkEntries(bulkItems)} busy={busy} onClear={() => setBulkIds([])} />}
    {tokens.some(t => t.facet === 'kind' && t.value === 'skill') && !configured.length && <div className="setup-banner"><Download size={18} /><span>Choose shared Agents and Claude folders for skill installation. Client-specific copies are available in Settings.</span><button className="button" onClick={() => navigate('settings')}>Set up</button></div>}
    <LibraryTable groups={groups} group={group} collectionShown={Boolean(collection) && collection !== UNFILED} row={item => ({ item, published: published(item), trial: lastTrial.get(item.id), place: lastTrial.has(item.id) ? trialPlace(lastTrial.get(item.id)!, places) : undefined, from: sameTitle.get(item.id), made: madeCount.get(item.id) })}
      locations={configured} installations={installations} approvals={snapshot.approvals} selected={selected} picked={bulkItems.length > 1 ? bulkIds : []} sort={relevance ? null : order} onSort={key => searchText ? setSearchSort(nextSort(relevance ? null : order, key)) : setSort(current => nextSort(current ?? defaultSort, key))}
      onClick={clickRow} onMenu={openMenu} onFocusRow={select} onPick={pickRange} onOpen={openItem} onSelectAll={selectAll} shortcut={rowShortcut}
      canSwipe={item => !item.deletedAt && item.status !== 'archived'} onArchive={archiveItem} drag={itemDrag} onCopy={item => void perform(() => copyItem(item))} onTest={testItem} installEntries={installMenu}
      scroll={listScroll} empty={emptyState}
      hint={section === 'trash' ? 'Right-click to restore or delete permanently. Ctrl-click picks several items at once.' : section === 'archive' ? 'Right-click to change status or move to trash. Ctrl-click picks several items at once.' : 'Click opens an item. Right-click for actions and their shortcuts. Ctrl-click or Shift-click picks several items at once. Swipe sideways to archive. Press ? for every shortcut.'} />
  </section>;
  const itemPage = itemView && <div className="item-view">
    <ItemBar label={sectionName} position={position} total={shown.length} onBack={() => setOpen(false)} onStep={step} onRefresh={() => void perform(refresh)} />
    {detail && detail.item.id === selected ? <Detail jobs={jobs} key={detail.item.id} detail={detail} snapshot={snapshot} providers={providers} sameTitle={sameTitle.get(detail.item.id)} installations={installations} refresh={refresh} perform={perform} onSelect={onSelectId => { revealItem(onSelectId); }} onAction={action} onToggleInstall={(provider, targetId) => toggleInstall(detail.item.id, provider, targetId)} onSetup={() => navigate('settings')} onCollection={openCollection} onMadeFrom={showMadeFrom} onAsk={() => setChatOpen(true)} onMachines={() => navigate('machines')} showTests={testRequest} />
      : <div className="item-loading" aria-label="Opening item"><Loader2 className="spin" size={18} /></div>}
  </div>;
  const running = jobs.some(j => j.kind === 'chat' && activeRun(j));
  return <div className="app-shell">
    <div className="app-body">
      <Rail style={sidebar.style} theme={(theme ?? snapshot.settings.theme) === 'dark' ? 'dark' : 'light'} onTheme={toggleTheme} section={section} collection={collection} stage={stage} collections={snapshot.collections} live={live} trashed={snapshot.items.filter(i => i.deletedAt).length} hidden={isHidden}
        stageCount={s => live.filter(i => !isHidden(i) && inStage(i, s, installations)).length} collapsed={collapsed} onToggle={toggleCollapsed} drag={collectionDrag} itemDrag={itemDrag} renaming={renamingCollection} onRename={renameCollection} onRenaming={setRenamingCollection} onError={setError}
        onNavigate={navigate} onStage={chooseStage} onCollection={openCollection} onNewCollection={() => newCollection()} onCollectionMenu={(event, name) => setCollectionMenu({ ...menuPoint(event), name })} />
      <ResizeHandle panel={sidebar} label="Resize sidebar" />
      <main className="main-workspace"><header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><b>{sectionName}</b></div>
        <button type="button" className="top-search" onClick={() => void api('desktop.palette')} title="Find items and run commands (Ctrl+K)"><Search size={15} /><span>Search or run a command…</span><kbd>Ctrl K</kbd></button>
        <div className="topbar-right"><button className="button primary" onClick={() => startCapture()}><Plus size={16} />Capture <kbd>Ctrl N</kbd></button><button type="button" className={`chat-toggle ${chatOpen && chatItem ? 'open' : ''}`} aria-label="Ask the agent" aria-pressed={chatOpen && Boolean(chatItem)} disabled={!chatItem} title={chatItem ? `Ask the agent about “${chatItem.title}”` : 'Open an item to ask the agent about it'} onClick={() => setChatOpen(open => !open)}><MessageSquare size={16} />{running && <span className="live-dot" aria-hidden="true" />}</button></div></header>
        {error && <div className="global-error" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}
        {snapshot.warnings.length > 0 && <details className="warning-bar"><summary>{snapshot.warnings.length} library warning(s) need attention</summary>{snapshot.warnings.map(w => <p key={w}>{w}</p>)}</details>}
        <div className="workspace-row"><div className="workspace-content">
        {section === 'home' ? <HomeFilesView perform={perform} refresh={refresh} onOpenLibrary={id => { revealItem(id); }} /> : libraryView ? (itemPage || libraryPage) : <div className="page-scroll">
        <div className="page-heading"><div><h1>{sectionName}</h1></div>{section === 'machines' && <button className="button primary" onClick={() => setDialog({ name: 'add-project' })}><Plus size={16} />Add project…</button>}</div>
        {section === 'experiments' && <ExperimentsPage snapshot={snapshot} jobs={jobs} busy={busy} onOpen={itemId => { openTrialItem(itemId); setTestRequest({ id: itemId, at: Date.now() }); }} onResult={trial => setDialog({ name: 'result', trial })} onDelete={trial => action('delete-trial', trial)} onLibrary={() => navigate('library')} />}
        {section === 'machines' && <MachinesView snapshot={snapshot} installations={installations} providers={providers} perform={perform} refresh={refresh} onMessage={setMessage} onSettings={() => navigate('settings')} onAddProject={() => setDialog({ name: 'add-project' })} onCompare={(itemId, targetId) => setDialog({ name: `compare:${itemId}:${targetId}` })} onKeep={keeper.keep} onUninstall={receiptId => setDialog({ name: 'uninstall:' + receiptId })} onInstall={toggleInstall} onOpenItem={id => revealItem(id)} />}
        {section === 'activity' && <><div className="coverage-banner"><Activity size={19} /><span>{snapshot.coverage}</span></div>{snapshot.activity.length ? <div className="timeline">{snapshot.activity.map(a => <div className="timeline-row" key={a.id}><span className={`timeline-dot ${a.kind}`} /><div><span className="eyebrow">{a.kind.replaceAll('_', ' ')}</span><p>{a.message}</p><small>{date(a.at)} {a.revision && `· ${shortHash(a.revision)}`}</small></div>{a.itemId && snapshot.items.some(i => i.id === a.itemId) && <button className="text-button" onClick={() => openTrialItem(a.itemId!)}>Open <ArrowRight size={12} /></button>}</div>)}</div> : <Empty icon={<Activity size={30} />} title="Your story starts with a capture.">Edits, experiments, approvals, and install receipts will appear here.</Empty>}</>}
        {section === 'settings' && <div className="settings-grid"><RepositoryPanel root={snapshot.root} perform={perform} refresh={refresh} onSetup={() => setSetupOpen(true)} onMessage={setMessage} />
          <section className="settings-card"><div className="section-heading"><h3><Download size={18} />Skill &amp; agent locations</h3><Badge status={configured.length ? 'ready' : 'not set up'} /></div><SkillLocationSettings providers={providers} targets={snapshot.targets} onSet={setLocation} onScan={(provider, target) => setDialog({ name: 'scan', provider, targetId: target.id })} />
            <div className="wrap-actions"><button className="button" disabled={!configured.length} onClick={() => void perform(async () => { setSyncReport(await api('skills.sync')); await refresh(); })}><RefreshCw size={15} />Install everything marked for this machine</button><span className="muted small">{Object.keys(snapshot.installs).length} skill{Object.keys(snapshot.installs).length === 1 ? '' : 's'} marked as installed in the library{multiMachine ? ', plus anything marked for this machine in Machines' : ''}</span></div>
            <p className="muted small">The library records which skills you installed (workbench/installs.json). After cloning it on another machine, turn on the locations above and press the button, or run <code>workbench skills sync</code>.</p>
            {syncReport && <details open><summary>Sync result</summary><div className="file-preview-list">{syncReport.map((r, i) => <div key={i}><span>{snapshot.items.find(it => it.id === r.itemId)?.title ?? r.itemId} · {r.provider === 'codex-native' ? 'Codex-specific' : primarySkillLabel(r.provider)}</span><span className="muted">{r.result}</span></div>)}{!syncReport.length && <div><span className="muted">Nothing marked for install.</span></div>}</div></details>}
          </section>
          <section className="settings-card"><div className="section-heading"><h3><FolderGit2 size={18} />Kiln repository</h3><Badge status={snapshot.git.ahead || snapshot.git.behind ? 'review' : 'connected'} /></div><p>Everything you approve is committed here and pushed to GitHub straight away. Drafts stay in this folder on this machine until you approve them. Search indexes, private trial inputs and install ownership live outside it.</p><code className="path-text">{snapshot.root}</code>
            <div className="connected-repo"><Github size={18} /><div><b>{repoName(snapshot.git.remote)}</b><small>{snapshot.git.branch} · {shortHash(snapshot.git.commit)} · <SyncSummary git={snapshot.git} /></small></div>{snapshot.git.ahead > 0 && <button className="button primary" onClick={() => void perform(async () => { await api('git.sync', { action: 'push' }); await refresh(); }, 'Pushed to GitHub')}><Upload size={14} />Push now</button>}</div>
            {snapshot.publish.some(j => j.status === 'failed') && <div className="notice warning"><b>Some approvals did not reach GitHub</b>{snapshot.publish.filter(j => j.status === 'failed').slice(0, 5).map(j => <p key={j.id}>{j.title}: {j.error} <button className="text-button" onClick={() => void perform(async () => { await api('publish.retry', { id: j.id }); await refresh(); })}>Retry</button></p>)}</div>}
            <p className="muted small">{snapshot.git.changes.length ? `${snapshot.git.changes.length} draft file${snapshot.git.changes.length === 1 ? '' : 's'} changed only on this machine. Approving an item sends its files to GitHub.` : 'No draft changes waiting on this machine.'}</p>
            <div className="wrap-actions"><button className="button" disabled={!snapshot.git.changes.length} onClick={() => void perform(async () => { setGitPreview(await api('git.diff')); setDialog({ name: 'git-diff' }); })}>View draft changes</button><button className="button" onClick={() => requestSync('fetch')}>Fetch from GitHub</button><button className="button" onClick={() => requestSync('pull')}>Pull from GitHub</button><button className="button" onClick={() => requestSync('merge')}>Merge from GitHub</button><button className="button" onClick={() => void perform(async () => { setConflicts(await api('git.conflicts')); setDialog({ name: 'conflicts' }); })}>Resolve conflicts</button><button className="button" onClick={() => void perform(async () => { const root = await api<string | null>('desktop.chooseDirectory'); if (root) setInventory(await api('git.inventory', { root })); })}><FolderOpen size={15} />Inspect a repository</button><button className="button" onClick={() => setSetupOpen(true)}>Connect a different repository…</button></div>
            <details><summary>Draft paths on this machine</summary><pre>{snapshot.git.changes.join('\n') || 'None'}</pre></details></section>
          <section className="settings-card"><h3>Desktop preferences</h3><form onSubmit={event => { event.preventDefault(); const v = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>; void perform(async () => { const settings = await api<Snapshot['settings']>('desktop.settings', { shortcut: v.shortcut, theme: v.theme, launchAtLogin: v.launchAtLogin === 'on', agentProvider: v.agentProvider }); setTheme(v.theme); localStorage.setItem('kiln-theme', v.theme); setSnapshot(current => current ? { ...current, settings } : current); }, 'Preferences saved'); }}><Field label="Default agent for capture, experiments and skill drafts" hint="Every run dialog still lets you pick the other one."><select name="agentProvider" defaultValue={snapshot.settings.agentProvider}>{providers.filter(p => p.id !== 'copilot').map(p => <option key={p.id} value={p.id}>{p.label}{p.available ? '' : ' · not detected'}</option>)}</select></Field><Field label="Global quick-search shortcut"><input name="shortcut" defaultValue={snapshot.settings.shortcut} required /></Field><Field label="Theme"><select name="theme" defaultValue={snapshot.settings.theme}><option value="light">Light</option><option value="dark">Dark</option><option value="system">Follow system</option></select></Field>{platform !== 'linux' && <label className="check-row"><input name="launchAtLogin" type="checkbox" defaultChecked={snapshot.settings.launchAtLogin} /><span>Launch Kiln when I sign in</span></label>}<p className="muted small">{platform === 'darwin' ? 'Closing the window keeps Kiln in the menu bar. Use its menu or Cmd+Q to quit.' : platform === 'linux' ? 'Closing the window keeps Kiln running in the tray. Quit from the tray menu, or from File → Quit (press Alt to show the menu bar). Opening Kiln again brings the window back.' : 'Closing the window keeps Kiln in the tray. Use the tray menu to quit.'}</p><button className="button" type="submit">Save preferences</button></form></section>
          <section className="settings-card"><h3>Official agents</h3>{providers.map(p => <div className="provider-row" key={p.id}><div className={`provider-mark ${p.id}`}><Terminal size={18} /></div><div><b>{p.label}</b><small>{p.version}</small><code className="path-text">{p.executable ?? 'Not detected on PATH'}</code></div><Badge status={p.available ? 'detected' : 'unavailable'} /></div>)}<p className="muted small">Runs use each client’s own sign-in. Kiln never asks for an API key.</p><button className="button" onClick={() => void perform(async () => setProviders(await api('providers.detect')))}>Detect again</button>
            {(() => { const chosen = models?.find(m => m.slug === snapshot.settings.codexModel) ?? models?.[0]; const commitChosen = models?.find(m => m.slug === snapshot.settings.commitModel); const save = (patch: Partial<Pick<typeof snapshot.settings, 'codexModel' | 'codexEffort' | 'commitModel' | 'commitEffort'>>) => void perform(async () => { await api('desktop.agentSettings', { codexModel: snapshot.settings.codexModel, codexEffort: snapshot.settings.codexEffort, commitModel: snapshot.settings.commitModel, commitEffort: snapshot.settings.commitEffort, ...patch }); await refresh(); }); return <form className="form-grid agent-model-form" onSubmit={e => e.preventDefault()}>
              <Field label="Codex model" hint={models === null ? 'Reading the catalog from the installed CLI…' : models.length ? chosen?.description : 'Catalog unavailable. Runs use the CLI default and record what was used.'}><select aria-label="Codex model" value={snapshot.settings.codexModel} disabled={!models?.length} onChange={e => save({ codexModel: e.target.value, codexEffort: '' })}><option value="">Catalog default{models?.[0] ? ` (${models[0].name})` : ''}</option>{models?.map(m => <option key={m.slug} value={m.slug}>{m.name}</option>)}</select></Field>
              <Field label="Reasoning effort" hint="Shown on every run alongside the model, thread id and token counts."><select aria-label="Reasoning effort" value={snapshot.settings.codexEffort} disabled={!chosen} onChange={e => save({ codexEffort: e.target.value })}><option value="">Model default{chosen?.defaultEffort ? ` (${chosen.defaultEffort})` : ''}</option>{chosen?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></Field>
              <Field label="CLI commit messages" hint="Used for generated notes when running Kiln’s CLI directly. Desktop saves, approvals and installs use plain notes without invoking a model."><select aria-label="Commit message model" value={snapshot.settings.commitModel} disabled={!models?.length} onChange={e => save({ commitModel: e.target.value, commitEffort: '' })}>{snapshot.settings.commitModel && !commitChosen && <option value={snapshot.settings.commitModel}>{snapshot.settings.commitModel}</option>}{models?.map(m => <option key={m.slug} value={m.slug}>{m.name}</option>)}</select></Field>
              <Field label="Commit message effort"><select aria-label="Commit message effort" value={snapshot.settings.commitEffort} disabled={!commitChosen} onChange={e => save({ commitEffort: e.target.value })}><option value="">Model default{commitChosen?.defaultEffort ? ` (${commitChosen.defaultEffort})` : ''}</option>{commitChosen?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></Field>
            </form>; })()}</section>
          <section className="settings-card"><h3>Performance logs</h3><p>Local logs record operation timings, slow requests, window freezes, crashes, CPU and memory. Logs rotate automatically at 5 MB; one previous file is kept. No skill content or request inputs are recorded.</p><button className="button" onClick={() => void perform(() => api('desktop.openLogs'))}>Open performance logs</button></section>
          <UpdatesPanel update={update} working={updating} onPrepare={() => updateAction(false)} onRestart={() => updateAction(true)} onCheck={() => void perform(async () => { await checkUpdate(true); }, 'Checked for updates')} onSource={value => void perform(async () => setUpdate(await api('desktop.updateSource', value)))} />
          <section className="settings-card"><h3>Export & recovery</h3><button className="button" onClick={() => void perform(() => api('desktop.resetAgentConsent'), 'Agent access warning will appear before the next interaction')}>Show agent access warnings again</button><p>Export content, bundled assets, revisions, and trial summaries to a readable JSON file. Private inputs, local paths, and credentials are excluded.</p><div className="wrap-actions"><button className="button" onClick={() => void perform(async () => { const result = await api<{ destination: string } | null>('desktop.export'); if (result) setMessage(`Exported to ${result.destination}`); })}><Download size={15} />Export library</button><button className="button" onClick={() => void perform(async () => { const result = await api<{ imported: number; conflicts: string[] } | null>('desktop.importBundle'); if (result) { await refresh(); setMessage(`Imported ${result.imported}; ${result.conflicts.length} diverging items retained in History.`); } })}><Upload size={15} />Restore export</button></div><p className="muted small">Imports are repeatable. Diverging revisions are retained. Imported approvals require a fresh human review.</p></section></div>}
      </div>}
        </div>
        {chatOpen && chatItem && <ChatPopover jobs={jobs} item={chatItem} source={sourceBehind} provider={snapshot.settings.agentProvider} items={snapshot.items} onRefresh={refresh} onClose={() => setChatOpen(false)} onOpenItem={id => { revealItem(id); }} initialMessage={chatSeed?.itemId === chatItem.id ? chatSeed : undefined} />}
        </div>
      </main>
    </div>
    <StatusBar snapshot={snapshot} jobs={jobs} agentError={agentSyncError} busy={busy} update={update} updating={updating} onUpdate={updateAction} onSettings={() => navigate('settings')} onOpenRun={openRun} refresh={refresh} perform={perform} onMessage={setMessage} onConflicts={result => { setConflicts(result as typeof conflicts); setDialog({ name: 'conflicts' }); }} onReveal={id => revealItem(id)} onOpenCollection={openCollection} />
    <CaptureDialog request={capture} provider={snapshot.settings.agentProvider} providers={providers} jobs={jobs} items={snapshot.items} onSaved={(id, analyzing) => void perform(() => captured(id, analyzing))} onOpenItem={id => openTrialItem(id)} onOpenCollection={openCollection} />
    {undoStack.toasts(message)}
    {sheet && <ShortcutSheet quickSearch={snapshot.settings.shortcut} onClose={() => setSheet(false)} />}
    {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.items)} onClose={() => setMenu(null)} />}
    {collectionMenu && <ContextMenu x={collectionMenu.x} y={collectionMenu.y} entries={collectionEntries(collectionMenu.name)} onClose={() => setCollectionMenu(null)} />}
    {dialog?.name === 'collections' && <CollectionsDialog names={snapshot.collections} items={snapshot.items} onClose={() => setDialog(null)} onDone={async moved => { await refresh(); if (moved) followCollection(moved.from, moved.to); }} onDelete={name => setDialog({ name: 'delete-collection', collection: name })} onOpen={openCollection} />}
    {dialog?.name === 'delete-collection' && dialog.collection && (() => { const name = dialog.collection; return <DeleteCollectionDialog name={name} names={snapshot.collections} items={snapshot.items} onClose={() => setDialog(null)} onDelete={(items, note) => void perform(async () => { await api('collections.delete', { name, confirm: true, items }); if (collection && isWithin(collection, name)) setCollection(''); if (items === 'trash' && itemsWithin(snapshot.items, name).some(i => i.id === selected)) setSelected(''); await completed(); }, note)} />; })()}
    {dialog?.name === 'move-items' && dialog.itemIds && <MoveItemsDialog names={snapshot.collections} items={snapshot.items.filter(i => dialog.itemIds!.includes(i.id))} onClose={() => setDialog(null)} onDone={async (to, _moved, ids = []) => { const before = snapshot.items.filter(i => dialog.itemIds!.includes(i.id)); setDialog(null); setBulkIds([]); await refresh(); undoStack.recordMove(before, { collection: to, moved: ids }); }} />}
    {detail && dialog?.name === 'variables' && <VariablesDialog detail={detail} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setMessage('Copied to clipboard'); void refresh(); }} />}
    {dialog?.name === 'trial' && (dialog.itemId ?? detail?.item.id) && <AgentTrialDialog itemId={dialog.itemId ?? detail!.item.id} providers={providers} targets={snapshot.targets} initialWorkspace={jobs.find(j => j.itemId === (dialog.itemId ?? detail?.item.id) && j.kind === 'trial')?.workspace} defaultProvider={snapshot.settings.agentProvider} onClose={() => setDialog(null)} onManual={workspace => setDialog({ name: 'manual-trial', workspace })} knownProjects revisions={detail?.item.id === (dialog.itemId ?? detail?.item.id) ? detail ?? undefined : undefined} />}
    {detail && dialog?.name === 'manual-trial' && <TrialDialog detail={detail} providers={providers} targets={snapshot.targets} initialWorkspace={dialog.workspace} knownProjects onClose={() => { setDialog(null); void refresh(); }} onDone={() => void completed()} />}
    {dialog?.name === 'result' && dialog.trial && <ResultDialog trial={dialog.trial} onClose={() => setDialog(null)} onDone={() => void completed()} />}
    {detail && dialog?.name === 'derive' && <CreateSkillDialog itemId={detail.item.id} title={detail.item.title} providers={providers} defaultProvider={snapshot.settings.agentProvider} onClose={() => setDialog(null)} />}
    {detail && dialog?.name === 'deploy' && <DeployDialog detail={detail} snapshot={snapshot} onClose={() => setDialog(null)} onDone={() => void completed()} />}
    {detail && dialog?.name === 'install-project' && <ProjectInstallDialog item={detail.item} onClose={() => setDialog(null)} onDone={note => { setDialog(null); setMessage(note); void refresh(); }} />}
    {dialog?.name === 'add-project' && <ProjectInstallDialog onClose={() => setDialog(null)} onDone={note => { setDialog(null); setMessage(note); void refresh(); }} />}
    {installTarget?.item && installTarget.provider && installTarget.target && <SkillInstallDialog item={installTarget.item} provider={installTarget.provider} target={installTarget.target} installations={installations} approved={snapshot.approvals.some(a => a.itemId === installTarget.item!.id && a.revision === installTarget.item!.revision && a.trust === 'local')} settings={snapshot.settings} onClose={() => setDialog(null)} onDone={note => { setDialog(null); setMessage(note); void refresh(); }} />}
    {dialog?.name === 'scan' && dialog.provider && (() => { const provider = providers.find(p => p.id === dialog.provider), target = snapshot.targets.find(t => t.id === dialog.targetId); return provider && target ? <ScanDialog provider={provider} target={target} onClose={() => setDialog(null)} onImported={refresh} /> : null; })()}
    {purgeTarget && <Modal title="Delete permanently?" subtitle={purgeTarget.title} onClose={() => setDialog(null)}><p>This removes the item, all its revisions, approvals and experiment records from the library folder. Copies already installed in agent folders are not touched. This cannot be undone from Kiln; Git history may still hold it.</p><div className="modal-actions"><button className="button" onClick={() => setDialog(null)}>Cancel</button><button className="button primary" onClick={() => void perform(async () => { await api('items.purge', { id: purgeTarget.id, confirm: true }); if (selected === purgeTarget.id) setSelected(''); await completed(); }, 'Deleted permanently')}><Trash2 size={14} />Delete permanently</button></div></Modal>}
    {dialog?.name === 'purge-many' && dialog.itemIds && <Modal title="Delete permanently?" subtitle={`${dialog.itemIds.length} items`} onClose={() => setDialog(null)}><p>This removes these items, all their revisions, approvals and experiment records from the library folder. Copies already installed in agent folders are not touched. This cannot be undone from Kiln; Git history may still hold them.</p><div className="modal-actions"><button className="button" onClick={() => setDialog(null)}>Cancel</button><button className="button primary" onClick={() => { const ids = dialog.itemIds!; void perform(async () => { try { await undoStack.each(ids, id => api('items.purge', { id, confirm: true }), (done, total) => `Deleting ${done} of ${total}…`, 'deleted'); } finally { await refresh(); } if (ids.includes(selected)) setSelected(''); setBulkIds([]); await completed(); }, `${ids.length} items deleted permanently`); }}><Trash2 size={14} />Delete {dialog.itemIds.length} items</button></div></Modal>}
    {bulkReview && <BulkRemovalDialog itemIds={bulkReview} onClose={() => { setBulkReview(null); setBulkIds([]); }} onDone={async () => { await refresh(); setInstallations(await api<Installation[]>('deploy.installations')); }} />}
    {dialog?.name === 'empty-trash' && <Modal title="Empty the trash?" subtitle={`${matching.length} item${matching.length === 1 ? '' : 's'} will be deleted permanently.`} onClose={() => setDialog(null)}><p>Revisions, approvals and experiment records of these items are removed from the library folder. Installed copies in agent folders stay as they are.</p><div className="modal-actions"><button className="button" onClick={() => setDialog(null)}>Cancel</button><button className="button primary" onClick={() => void perform(async () => { try { await undoStack.each(matching, item => api('items.purge', { id: item.id, confirm: true }), (done, total) => `Deleting ${done} of ${total}…`, 'deleted'); } finally { await refresh(); } setSelected(''); await completed(); }, 'Trash emptied')}><Trash2 size={14} />Delete {matching.length} item{matching.length === 1 ? '' : 's'}</button></div></Modal>}
    {dialog?.name.startsWith('rollback:') && (() => { const receipt = snapshot.receipts.find(r => r.id === dialog.name.split(':')[1]); return receipt ? <Modal title="Reverse this install?" subtitle="Installed files will be checked again before rollback." onClose={() => setDialog(null)}><code className="path-text">{receipt.destination}</code><p>{receipt.previousRevision ? `Restore approved revision ${shortHash(receipt.previousRevision)}.` : 'Remove the snapshot Kiln created. There was no previous file at this destination.'}</p><div className="modal-actions"><button className="button" onClick={() => setDialog(null)}>Cancel</button><button className="button primary" onClick={() => void perform(async () => { await api('deploy.rollback', { receiptId: receipt.id, expectState: receipt.hash, confirm: true }); await completed(); }, 'Install reversed')}>Confirm rollback</button></div></Modal> : null; })()}
    {dialog?.name.startsWith('compare:') && (() => { const [, itemId, targetId] = dialog.name.split(':'); const item = snapshot.items.find(i => i.id === itemId), installation = installations.find(i => i.itemId === itemId && i.targetId === targetId); return item ? <CompareDialog itemId={itemId} targetId={targetId} title={item.title} destination={installation?.destination ?? snapshot.receipts.find(r => r.itemId === itemId && r.targetId === targetId)?.destination ?? ''} onClose={() => setDialog(null)} onKeep={canKeep(installation) ? () => { setDialog(null); keeper.keep(itemId, targetId); } : undefined} /> : null; })()}
    {keeper.dialog}
    {dialog?.name.startsWith('uninstall:') && (() => { const receipt = snapshot.receipts.find(r => r.id === dialog.name.split(':')[1]); return receipt ? <Modal title="Remove this skill?" subtitle="Only the matching Kiln-owned folder will be removed." onClose={() => setDialog(null)}><code className="path-text">{receipt.destination}</code><p>The skill stays in your library, with its approvals and history. You can install it again later.</p><div className="modal-actions"><button className="button" onClick={() => setDialog(null)}>Cancel</button><button className="button primary" onClick={() => void perform(async () => { await api('deploy.uninstall', { receiptId: receipt.id, expectState: receipt.hash, confirm: true }); await completed(); }, 'Skill removed; library retained')}>Confirm removal</button></div></Modal> : null; })()}
    {inventory && <Modal title="Repository inventory" subtitle="Read-only inspection complete. No history or existing files changed." onClose={() => setInventory(null)} wide><code className="path-text">{inventory.root}</code><p>{inventory.totalFiles} tracked files · {inventory.resources.length} candidate resources · branch {inventory.branch}</p><div className="inventory-list">{inventory.resources.map(relative => <div key={relative}><code>{relative}</code><button className="text-button" onClick={() => void perform(async () => { const item = await api<Item>('desktop.importResource', { root: inventory.root, relative }); await refresh(); setSelected(item.id); }, 'Imported as an unapproved resource')}>Import copy</button></div>)}</div><p>Attaching creates a separate workbench folder. Existing dotfile installers and agent files keep their current ownership. Import selected resources deliberately.</p><div className="modal-actions"><button className="button" onClick={() => setInventory(null)}>Cancel</button><button className="button primary" onClick={() => void perform(async () => { await api('desktop.attach', { root: inventory.root }); setInventory(null); setSelected(''); await refresh(); }, 'Repository attached')}>Attach this repository</button></div></Modal>}
    {dialog?.name === 'import-local' && <LocalSkillsDialog onClose={() => setDialog(null)} onDone={summary => { setDialog(null); setMessage(summary); void refresh(); }} />}
    {dialog?.name === 'import-repo' && <RepositorySkillsDialog onClose={() => setDialog(null)} onDone={summary => { setDialog(null); setMessage(summary); void refresh(); }} />}
    {dialog?.name === 'git-diff' && <Modal title="Draft changes on this machine" subtitle="Not on GitHub yet. Approving an item commits and pushes its files." onClose={() => setDialog(null)} wide><pre className="prompt-preview">{gitPreview || 'No changes to tracked files. Brand-new drafts are listed under “Draft paths on this machine”.'}</pre></Modal>}
    {dialog?.name === 'conflicts' && conflicts && <Modal title="Resolve library differences" subtitle="Both sides stay in history. Select deliberately, then finish the merge." onClose={() => setDialog(null)} wide>
      {conflicts.items.map(c => <section className="content-section" key={c.id}><h3>{c.ours?.title ?? c.theirs?.title ?? c.id}</h3><details><summary>Common ancestor</summary><pre>{c.baseText}</pre></details><div className="form-grid"><div><b>This machine</b><pre className="prompt-preview">{c.oursText}</pre></div><div><b>GitHub</b><pre className="prompt-preview">{c.theirsText}</pre></div></div><div className="wrap-actions">{(['ours', 'theirs', 'both'] as const).map(choice => <button className="button" key={choice} disabled={!c.ours || !c.theirs} onClick={() => void perform(async () => { setConflicts(await api('git.resolve', { id: c.id, choice })); await refresh(); })}>{choice === 'ours' ? 'Keep this machine’s' : choice === 'theirs' ? 'Take GitHub’s' : 'Keep both revisions'}</button>)}</div></section>)}
      {conflicts.otherPaths.length > 0 && <div className="notice warning"><b>Resolve these paths in your normal Git editor</b><pre>{conflicts.otherPaths.join('\n')}</pre><p>Kiln does not choose how to resolve unrelated content or approval records.</p></div>}
      {!conflicts.paths.length && <p>No unresolved paths. Finish an in-progress merge to create its checkpoint.</p>}<div className="modal-actions"><button className="button" onClick={() => void perform(async () => setConflicts(await api('git.conflicts')))}>Refresh conflicts</button><button className="button primary" disabled={conflicts.paths.length > 0} onClick={() => void perform(async () => { await api('git.finishMerge'); await completed(); }, 'Merge completed')}>Finish merge</button></div>
    </Modal>}
  </div>;
}
