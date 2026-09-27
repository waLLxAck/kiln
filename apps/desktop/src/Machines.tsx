import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, Check, Download, FileDiff, FolderOpen, Laptop, Layers3, Monitor, Pencil, RefreshCw, Settings, Share2, Trash2, X } from 'lucide-react';
import type { FleetView, Installation, Item, MachineReport, Provider, ProviderId, Receipt, Snapshot } from '../../../packages/protocol/schema';
import { agentFolder } from '../../../packages/domain/agent-format';
import { targetSkillsFolder } from '../../../packages/providers/skill-locations';
import { applyWanted, buildReport, cellFor, installable, isProject, latestApproval, localCopies, locationClient, summarise, type Cell, type CellState, type FleetLocation, type LocalLocation } from '../../../packages/fleet/model';
import { api, date, shortHash } from './api';
import { Badge, Empty, KindIcon, providerName } from './components';
import './machines.css';

type Props = {
  snapshot: Snapshot; installations: Installation[]; providers: Provider[];
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>; onMessage: (message: string) => void;
  onSettings: () => void; onEnroll: () => void; onCompare: (itemId: string, targetId: string) => void; onUninstall: (receiptId: string) => void;
  /** Opens the install dialog for one item and location on this machine (install, adopt, replace or remove). */
  onInstall?: (itemId: string, provider: ProviderId, targetId: string) => void;
  onOpenItem?: (itemId: string) => void;
};
type Machine = { id: string; name: string; platform: string; self: boolean; reportedAt: string | null; report: MachineReport; locations: (FleetLocation & Partial<LocalLocation>)[]; pending: Set<string> };
type Selection = 'self' | 'all' | string;

const platformName = (platform: string) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[platform] ?? platform;
/** "just now", "5 min ago", "2 h ago", "3 days ago", then the date. */
export function ago(value: string | null) {
  if (!value) return 'never';
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 14 * 24 * 60) return `${Math.round(minutes / 1440)} days ago`;
  return date(value);
}
// installs.json lists personal installs for every machine; its tokens map onto personal location keys.
const tokenKey: Record<string, string> = { codex: 'agents', claude: 'claude', copilot: 'copilot', 'codex-native': 'codex' };
const glyphLabel: Record<CellState, string> = { installed: 'Installed', changed: 'Changed outside Kiln', outdated: 'Outdated', external: 'Found, not managed by Kiln', marked: 'Marked, not installed yet', off: 'Not installed', unavailable: 'Can’t be installed' };

function Glyph({ state }: { state: CellState }) {
  return <span className={`fleet-glyph ${state}`} aria-hidden="true">{state === 'installed' ? <Check size={13} strokeWidth={3} /> : state === 'changed' ? <AlertTriangle size={12} strokeWidth={2.4} /> : state === 'outdated' ? <ArrowUp size={13} strokeWidth={2.8} /> : state === 'marked' ? <Download size={11} strokeWidth={2.6} /> : null}</span>;
}

/**
 * Machines: every machine that shares this library, as an items × locations matrix per machine and an items × machines
 * overview. This machine is computed live from the snapshot; other machines are their last report on GitHub. Nothing here
 * reaches another machine directly: marks for another machine are committed to its report and take effect when it next syncs.
 */
export function MachinesView({ snapshot, installations, providers, perform, refresh, onMessage, onSettings, onEnroll, onCompare, onUninstall, onInstall, onOpenItem }: Props) {
  const [view, setView] = useState<FleetView | null>(null);
  const [selected, setSelected] = useState<Selection>('self');
  const [open, setOpen] = useState<{ itemId: string; key: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drift, setDrift] = useState<(Receipt & { drifted: boolean; checkedAt: string; error?: string })[]>([]);
  const fetched = useRef(false);
  const load = useCallback(async (fetch = false) => { try { setView(await api<FleetView>('fleet.view', { fetch })); } catch (error) { onMessage(error instanceof Error ? error.message : String(error)); } }, [onMessage]);
  // Fetch from GitHub when the view opens (the backend throttles it); re-read locally whenever the snapshot changes.
  useEffect(() => { void load(!fetched.current); fetched.current = true; }, [snapshot, load]);
  // While this machine's report is on its way, check again shortly.
  useEffect(() => { if (view?.publish.state !== 'queued') return; const timer = setTimeout(() => void load(), 1500); return () => clearTimeout(timer); }, [view, load]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.fleet-pop, .fleet-cell')) setOpen(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, []);

  const home = providers.find(p => p.id === 'codex')?.personalRoot ?? providers[0]?.personalRoot ?? '';
  const rows = useMemo(() => snapshot.items.filter(installable).sort((a, b) => a.title.localeCompare(b.title)), [snapshot.items]);
  const approved = useMemo(() => new Map(rows.map(item => [item.id, latestApproval(snapshot.approvals, item.id)?.revision])), [rows, snapshot.approvals]);
  const machines = useMemo<Machine[]>(() => {
    const identity = view?.self ?? { id: '', name: 'This machine', platform: window.kiln?.platform ?? '' };
    const inputs = { items: snapshot.items, approvals: snapshot.approvals, targets: snapshot.targets, receipts: snapshot.receipts, installations, home };
    const withLibrary = (report: MachineReport): MachineReport => {
      // Personal installs recorded in installs.json count as marked on every machine that has that location.
      let wanted = report.wanted;
      for (const [itemId, tokens] of Object.entries(snapshot.installs)) for (const token of tokens) if (report.locations.some(l => l.key === tokenKey[token])) wanted = applyWanted(wanted, itemId, tokenKey[token], true);
      return { ...report, wanted };
    };
    const own = buildReport(identity, view?.appVersion ?? '', inputs, view?.wanted ?? {}, new Date().toISOString());
    const local = localCopies(inputs).locations;
    const self: Machine = { id: identity.id, name: identity.name, platform: identity.platform, self: true, reportedAt: null, report: withLibrary(own), locations: own.locations.map(l => ({ ...l, ...local.find(x => x.key === l.key) })), pending: new Set() };
    const others = (view?.machines ?? []).map(report => {
      const edits = view!.pending.filter(e => e.machineId === report.id);
      const wanted = edits.reduce((acc, e) => applyWanted(acc, e.itemId, e.location, e.wanted), report.wanted);
      return { id: report.id, name: report.name, platform: report.platform, self: false, reportedAt: report.reportedAt, report: withLibrary({ ...report, wanted }), locations: report.locations, pending: new Set(edits.map(e => `${e.itemId} ${e.location}`)) };
    });
    return [self, ...others];
  }, [view, snapshot, installations, home]);
  const machine = selected === 'all' ? null : machines.find(m => (selected === 'self' ? m.self : m.id === selected)) ?? machines[0];
  const explicit = (m: Machine, itemId: string, key: string) => Boolean((m.self ? view?.wanted : view?.machines.find(x => x.id === m.id)?.wanted)?.[itemId]?.includes(key)) || view?.pending.some(e => e.machineId === m.id && e.itemId === itemId && e.location === key && e.wanted);
  const cells = (m: Machine, item: Item) => m.locations.map(location => ({ location, cell: cellFor(item, approved.get(item.id), m.report, location) }));
  const needsAttention = (item: Item) => (Boolean(approved.get(item.id)) && approved.get(item.id) !== item.revision) || machines.some(m => cells(m, item).some(({ cell }) => ['changed', 'outdated', 'marked'].includes(cell.state)));
  const visible = filter === 'all' ? rows : rows.filter(needsAttention);
  const self = machines[0];
  const totals = machine ? summarise(snapshot.items, snapshot.approvals, machine.report) : machines.map(m => summarise(snapshot.items, snapshot.approvals, m.report)).reduce((a, b) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v + b[k as keyof typeof b]])) as typeof a);
  const selfTotals = summarise(snapshot.items, snapshot.approvals, self.report);

  const mark = (m: Machine, itemId: string, key: string, wanted: boolean) => void perform(async () => { await api('fleet.mark', { machineId: m.id, itemId, location: key, wanted }); setOpen(null); await load(); }, wanted ? `Marked for ${m.self ? 'this machine' : m.name}${m.self ? '' : `; it installs when ${m.name} next syncs`}` : `Unmarked for ${m.self ? 'this machine' : m.name}`);
  const syncMarked = () => void perform(async () => {
    const report = await api<{ result: string }[]>('skills.sync');
    await refresh();
    const installed = report.filter(r => r.result === 'installed approved revision').length, problems = report.filter(r => !/^(installed|already)/.test(r.result));
    onMessage(`${installed} installed${problems.length ? ` · ${problems.length} not installed: ${[...new Set(problems.map(p => p.result))].join('; ')}` : ''}`);
  });
  const updateOutdated = (copies?: { itemId: string; targetId: string }[]) => void perform(async () => { const result = await api<{ result: string }[]>('fleet.update', copies ? { copies } : {}); setOpen(null); await refresh(); const failed = result.filter(r => !/^(installed|already)/.test(r.result)); onMessage(failed.length ? failed.map(f => f.result).join('\n') : `Updated ${result.length} cop${result.length === 1 ? 'y' : 'ies'} to the approved revision`); });
  const rename = (name: string) => void perform(async () => { await api('fleet.rename', { name }); setRenaming(null); await load(); }, 'Machine renamed');

  const publish = view?.publish;
  const publishLine = !view ? 'Reading machines…' : !view.ready ? 'Not shared: this library has no GitHub remote. Finish the GitHub setup in Settings.'
    : publish?.state === 'queued' ? 'Sharing with GitHub…'
    : publish?.state === 'behind' ? 'Pull from GitHub to share this machine’s state.'
    : publish?.state === 'failed' ? `Not shared: ${publish.error ?? 'the push failed'}`
    : publish?.sharedAt ? `Shared ${ago(publish.sharedAt)}` : 'Not shared yet';

  return <div className="fleet">
    <div className="fleet-switcher" role="tablist" aria-label="Machines">
      {machines.map(m => {
        const active = machine?.id === m.id && machine.self === m.self;
        return <div key={m.self ? 'self' : m.id} className={`fleet-machine ${active ? 'active' : ''}`}>
          {renaming !== null && m.self ? <form className="fleet-rename" onSubmit={event => { event.preventDefault(); if (renaming.trim()) rename(renaming.trim()); }}><input aria-label="Machine name" autoFocus value={renaming} maxLength={80} onChange={e => setRenaming(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setRenaming(null); }} /><button className="icon-button" type="submit" aria-label="Save name"><Check size={15} /></button><button className="icon-button" type="button" aria-label="Cancel renaming" onClick={() => setRenaming(null)}><X size={15} /></button></form>
            : <button role="tab" aria-selected={active} className="fleet-machine-button" onClick={() => { setSelected(m.self ? 'self' : m.id); setOpen(null); }}>
              <span className="fleet-machine-icon">{m.self ? <Monitor size={16} /> : <Laptop size={16} />}</span>
              <span className="fleet-machine-text"><b>{m.self ? 'This machine' : m.name}</b><small>{m.self ? `${m.name} · ${platformName(m.platform)} · ` : `${platformName(m.platform)} · reported ${ago(m.reportedAt)}`}{m.self && <span className="fleet-live">live</span>}</small></span>
            </button>}
          {m.self && renaming === null && view && <button className="icon-button fleet-edit" aria-label="Rename this machine" title="Rename this machine" onClick={() => setRenaming(m.name)}><Pencil size={13} /></button>}
        </div>;
      })}
      <div className={`fleet-machine ${selected === 'all' ? 'active' : ''}`}><button role="tab" aria-selected={selected === 'all'} className="fleet-machine-button" onClick={() => { setSelected('all'); setOpen(null); }}><span className="fleet-machine-icon"><Layers3 size={16} /></span><span className="fleet-machine-text"><b>All machines</b><small>{machines.length} machine{machines.length === 1 ? '' : 's'}</small></span></button></div>
      <span className="fleet-grow" />
      <div className="fleet-share">
        <span className={`fleet-share-state ${publish?.state === 'behind' || publish?.state === 'failed' ? 'warn' : ''}`} role="status"><Share2 size={13} />{publishLine}</span>
        {(publish?.state === 'behind' || (view && !view.ready)) && <button className="text-button" onClick={onSettings}>Open Settings</button>}
        <button className="button" disabled={!view?.ready || publish?.state === 'queued'} title="Share this machine’s installs with your other machines now" onClick={() => void perform(async () => { await api('fleet.report'); await load(); })}><RefreshCw size={14} />Report now</button>
      </div>
    </div>
    {view?.fetchError && <p className="fleet-note warn">Couldn’t reach GitHub ({view.fetchError}). Other machines are shown as last fetched.</p>}

    <div className="fleet-strip">
      <div className="fleet-stats">
        {!machine && <><span><b>{machines.length}</b> machine{machines.length === 1 ? '' : 's'}</span><span className="fleet-sep" /></>}
        <span><b>{totals.copies}</b> {totals.copies === 1 ? 'copy' : 'copies'}</span><span className="fleet-sep" />
        <span className={totals.changed ? 'warn' : 'quiet'}><AlertTriangle size={13} /><b>{totals.changed}</b> changed outside Kiln</span><span className="fleet-sep" />
        <span className={totals.outdated ? 'accent' : 'quiet'}><ArrowUp size={13} /><b>{totals.outdated}</b> outdated</span><span className="fleet-sep" />
        <span className={totals.marked ? 'accent' : 'quiet'}><Download size={13} /><b>{totals.marked}</b> marked, not installed yet</span>
      </div>
      <span className="fleet-grow" />
      {machine?.self ? <>
        <button className="button" disabled={!selfTotals.outdated} onClick={() => updateOutdated()}><ArrowUp size={15} />Update all outdated</button>
        <button className="button primary" disabled={!selfTotals.marked} onClick={syncMarked}><Download size={15} />Install everything marked for this machine{selfTotals.marked > 0 && <span className="fleet-count">{selfTotals.marked}</span>}</button>
      </> : machine ? <span className="fleet-strip-note">Marks take effect when {machine.name} next opens Kiln and syncs.</span> : <span className="fleet-strip-note">Click a cell to see that machine.</span>}
    </div>

    <div className="fleet-toolbar">
      <div className="fleet-seg" role="group" aria-label="Show">
        <button aria-pressed={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All <span>{rows.length}</span></button>
        <button aria-pressed={filter === 'attention'} className={filter === 'attention' ? 'on' : ''} onClick={() => setFilter('attention')}>Needs attention <span>{rows.filter(needsAttention).length}</span></button>
      </div>
      <span className="fleet-grow" />
      <div className="fleet-legend" aria-label="Legend">{(['installed', 'changed', 'outdated', 'external', 'marked', 'off', 'unavailable'] as CellState[]).map(state => <span key={state}><Glyph state={state} />{state === 'off' ? 'Off' : state === 'unavailable' ? 'Can’t install' : state === 'external' ? 'Not managed' : state === 'marked' ? 'Marked' : glyphLabel[state]}</span>)}</div>
    </div>

    {!rows.length ? <Empty icon={<Monitor size={28} />} title="Nothing to install yet.">Approved skills and agents appear here with every place they’re installed.</Empty>
      : machine ? (machine.locations.length ? Matrix() : machine.self ? <Empty icon={<Monitor size={28} />} title="Choose where approved skills belong." action={<div className="wrap-actions"><button className="button" onClick={onSettings}><Settings size={15} />Set up skill locations</button><button className="button" onClick={onEnroll}>Enroll project folder</button></div>}>Personal skill folders for Codex, Claude Code and Copilot are set up in Settings. Project folders are enrolled here.</Empty>
        : <Empty icon={<Laptop size={28} />} title={`${machine.name} has no skill locations set up.`}>Locations appear once they are set up in Kiln on that machine.</Empty>)
      : Overview()}
    {machine && !machine.self && (() => { const unknown = Object.keys(machine.report.copies).filter(id => !snapshot.items.some(i => i.id === id)).length; return unknown ? <p className="fleet-note">{unknown} item{unknown === 1 ? '' : 's'} installed on {machine.name} {unknown === 1 ? 'isn’t' : 'aren’t'} in this library yet. Pull from GitHub to see {unknown === 1 ? 'it' : 'them'}.</p> : null; })()}
    {machine?.self && ThisMachine()}
  </div>;

  function Matrix() {
    const m = machine!, personal = m.locations.filter(l => !isProject(l.key)), projects = m.locations.filter(l => isProject(l.key)), columns = [...personal, ...projects];
    return <div className="fleet-card"><table className="fleet-grid" aria-label={`Installs on ${m.self ? 'this machine' : m.name}`}>
      <colgroup><col className="fleet-col-item" />{columns.map(c => <col key={c.key} />)}<col className="fleet-col-end" /></colgroup>
      <thead>
        <tr className="fleet-groups"><th />{personal.length > 0 && <th colSpan={personal.length}><span>Personal</span></th>}{projects.length > 0 && <th colSpan={projects.length} className="fleet-projects"><span>Projects</span></th>}<th /></tr>
        <tr className="fleet-cols"><th className="fleet-itemhead">Item <span className="muted">· approved revision</span></th>
          {columns.map((c, n) => { const here = rows.filter(item => { const s = cellFor(item, approved.get(item.id), m.report, c).state; return s !== 'off' && s !== 'unavailable' && s !== 'marked'; }).length;
            return <th key={c.key} className={n === personal.length && n ? 'fleet-first-project' : ''} title={m.self && c.root ? `${c.root}${c.targetId ? '' : '\nNot managed by Kiln'}` : c.managed ? c.label : `${c.label}: not managed by Kiln there`}><span className="fleet-colname">{c.label}</span><span className="fleet-colmeta">{c.managed ? `${here} here` : 'not managed'}</span></th>; })}
          <th /></tr>
      </thead>
      <tbody>{visible.map(item => {
        const row = cells(m, item), count = row.filter(({ cell }) => !['off', 'unavailable', 'marked'].includes(cell.state)).length, rev = approved.get(item.id);
        return <tr key={item.id} className={open?.itemId === item.id ? 'active' : ''}>
          <th className="fleet-item" scope="row"><span className="fleet-kind"><KindIcon kind={item.kind} size={15} /></span><span className="fleet-itemtext">
            {onOpenItem ? <button className="fleet-title" onClick={() => onOpenItem(item.id)} title="Open this item">{item.title}</button> : <span className="fleet-title">{item.title}</span>}{item.kind === 'agent' && <span className="fleet-kindtag">{item.agent ? providerName[item.agent.provider] : 'agent'}</span>}
            <span className="fleet-rev">{rev ? <><Check size={11} className="fleet-ok" /><code>{shortHash(rev)}</code></> : <span>Draft · not approved</span>}{rev && rev !== item.revision && <span className="fleet-draft" title={`Draft ${shortHash(item.revision)} is newer than the approved revision. Sync and Update install ${shortHash(rev)} until you approve it.`}>newer draft</span>}</span>
          </span></th>
          {row.map(({ location, cell }, n) => {
            const isOpen = open?.itemId === item.id && open.key === location.key;
            return <td key={location.key} className={n === personal.length && n ? 'fleet-first-project' : ''}>
              {cell.state === 'unavailable' ? <span className="fleet-cell disabled" title={cell.reason} aria-label={`${item.title} in ${location.label}: ${cell.reason}`}><Glyph state="unavailable" /></span>
                : <button className={`fleet-cell ${cell.state} ${isOpen ? 'open' : ''} ${m.pending.has(`${item.id} ${location.key}`) ? 'pending' : ''}`} aria-label={`${item.title} in ${location.label}: ${glyphLabel[cell.state]}`} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : { itemId: item.id, key: location.key })}><Glyph state={cell.state} /></button>}
              {isOpen && Popover({ item, location, cell, flip: n >= columns.length - 2 && columns.length > 2 })}
            </td>;
          })}
          <td className="fleet-end"><span className={count ? '' : 'muted'}>{count ? `${count} of ${columns.length}` : 'Nowhere'}</span></td>
        </tr>;
      })}</tbody>
    </table>{!visible.length && <p className="fleet-empty-row">Nothing needs attention.</p>}</div>;
  }

  function Popover({ item, location, cell, flip }: { item: Item; location: Machine['locations'][number]; cell: Cell; flip: boolean }) {
    const m = machine!, rev = approved.get(item.id)!, name = m.self ? 'this machine' : m.name;
    const installation = m.self ? installations.find(i => i.itemId === item.id && (location.targetId ? i.targetId === location.targetId : !i.targetId && i.location === (location.key.split(':').at(-1) ?? location.key))) : undefined;
    const target = snapshot.targets.find(t => t.id === location.targetId);
    const receipt = installation?.receiptId ?? null;
    const explicitMark = explicit(m, item.id, location.key), fromLibrary = cell.wanted && !explicitMark, pending = m.pending.has(`${item.id} ${location.key}`);
    const words: Record<CellState, [string, string]> = {
      installed: ['Installed, matches Kiln', `Approved revision ${shortHash(cell.revision ?? rev)}`],
      outdated: ['Older approved revision', `Has ${cell.revision ? shortHash(cell.revision) : 'an older revision'} · latest approved is ${shortHash(rev)}`],
      changed: ['Changed outside Kiln', 'Kiln installed it; the folder was edited afterwards'],
      external: ['Found, not managed by Kiln', cell.revision ? `Same files as ${shortHash(cell.revision)}` : 'Differs from the library'],
      marked: [`Marked for ${name}`, m.self ? 'Not installed here yet' : `Installs when ${m.name} next opens Kiln and syncs`],
      off: ['Not installed here', `Latest approved: ${shortHash(rev)}`],
      unavailable: ['Can’t be installed', cell.reason ?? ''],
    };
    const [title, detail] = words[cell.state];
    const path = installation?.destination ?? (target ? `${target.root}/${item.kind === 'agent' ? agentFolder(target.provider, target.scope) : targetSkillsFolder(target)}/` : '');
    const install = target && onInstall ? () => { setOpen(null); onInstall(item.id, target.provider, target.id); } : null;
    return <div className={`fleet-pop ${flip ? 'left' : ''}`} role="dialog" aria-label={`${item.title} in ${location.label}`}>
      <div className="fleet-pophead"><Glyph state={cell.state} /><div><b>{title}</b><span>{detail}</span></div><button className="icon-button" aria-label="Close" onClick={() => setOpen(null)}><X size={14} /></button></div>
      <div className="fleet-popmeta"><span className="muted">{item.title} · {location.label}{m.self ? '' : ` · ${m.name}`}</span>{m.self && path && <code>{path}</code>}
        {cell.wanted && cell.state !== 'marked' && <span>{fromLibrary ? 'Listed in the library’s personal installs.' : `Also marked for ${name}.`}</span>}
        {cell.state === 'marked' && fromLibrary && <span>Listed in the library’s personal installs (installed on another machine).</span>}
        {pending && <span className="fleet-pending">Not on GitHub yet: {view?.publish.state === 'behind' ? 'pull from GitHub to send it.' : 'sending…'}</span>}
        {m.self && install && rev !== item.revision && (cell.state === 'off' || cell.state === 'marked') && <span>Installing from here installs the newer draft and approves it.</span>}
        {!m.self && <span>Reported {ago(m.reportedAt)}.</span>}</div>
      <div className="fleet-popactions">
        {m.self ? <>
          {(cell.state === 'off' || cell.state === 'marked') && install && <button className="button primary" onClick={install}><Download size={14} />Install…</button>}
          {cell.state === 'outdated' && target && <button className="button primary" onClick={() => updateOutdated([{ itemId: item.id, targetId: target.id }])}><ArrowUp size={14} />Update to {shortHash(rev)}</button>}
          {(cell.state === 'changed' || cell.state === 'external') && install && <button className="button primary" onClick={install}>Review…</button>}
          {(cell.state === 'changed' || cell.state === 'outdated' || (cell.state === 'external' && !installation?.matches)) && target && <button className="button" onClick={() => { setOpen(null); onCompare(item.id, target.id); }}><FileDiff size={14} />Compare…</button>}
          {cell.state === 'installed' && installation && <button className="button" onClick={() => void api('desktop.revealPath', { path: installation.destination }).catch(e => onMessage(String(e)))}><FolderOpen size={14} />Open folder</button>}
          {(cell.state === 'installed' || cell.state === 'outdated') && receipt && <button className="button danger-text" onClick={() => { setOpen(null); onUninstall(receipt); }}><Trash2 size={14} />Remove</button>}
        </> : <>{cell.state === 'off' && <button className="button primary" onClick={() => mark(m, item.id, location.key, true)}><Download size={14} />Mark for {m.name}</button>}</>}
        {explicitMark && <button className="button" onClick={() => mark(m, item.id, location.key, false)}>Unmark</button>}
      </div>
    </div>;
  }

  function Overview() {
    return <div className="fleet-card"><table className="fleet-grid fleet-overview" aria-label="Installs on all machines">
      <colgroup><col className="fleet-col-item" />{machines.map(m => <col key={m.self ? 'self' : m.id} />)}</colgroup>
      <thead><tr className="fleet-cols"><th className="fleet-itemhead">Item <span className="muted">· approved revision</span></th>{machines.map(m => <th key={m.self ? 'self' : m.id}><span className="fleet-colname">{m.self ? 'This machine' : m.name}</span><span className="fleet-colmeta">{m.self ? 'live' : `reported ${ago(m.reportedAt)}`}</span></th>)}</tr></thead>
      <tbody>{visible.map(item => { const rev = approved.get(item.id); return <tr key={item.id}>
        <th className="fleet-item" scope="row"><span className="fleet-kind"><KindIcon kind={item.kind} size={15} /></span><span className="fleet-itemtext"><span className="fleet-title">{item.title}</span><span className="fleet-rev">{rev ? <><Check size={11} className="fleet-ok" /><code>{shortHash(rev)}</code></> : <span>Draft · not approved</span>}{rev && rev !== item.revision && <span className="fleet-draft">newer draft</span>}</span></span></th>
        {machines.map(m => {
          const states = cells(m, item).map(({ cell }) => cell.state), n = (s: CellState) => states.filter(x => x === s).length;
          const parts: [string, string][] = [];
          if (n('changed')) parts.push([`${n('changed')} changed`, 'warn']);
          if (n('outdated')) parts.push([n('outdated') === 1 ? 'outdated' : `${n('outdated')} outdated`, 'accent']);
          if (n('installed')) parts.push([`${n('installed')} ✓`, 'ok']);
          if (n('external')) parts.push([`${n('external')} not managed`, 'quiet']);
          if (n('marked')) parts.push([n('marked') === 1 ? 'marked' : `${n('marked')} marked`, 'accent']);
          return <td key={m.self ? 'self' : m.id}><button className="fleet-summary" aria-label={`${item.title} on ${m.self ? 'this machine' : m.name}: ${parts.map(p => p[0]).join(', ') || 'nowhere'}`} onClick={() => setSelected(m.self ? 'self' : m.id)}>{parts.length ? parts.slice(0, 3).map(([text, tone]) => <span key={text} className={`fleet-chip ${tone}`}>{text}</span>) : <span className="fleet-none">—</span>}</button></td>;
        })}
      </tr>; })}</tbody>
    </table>{!visible.length && <p className="fleet-empty-row">Nothing needs attention.</p>}</div>;
  }

  function ThisMachine() {
    const locations = self.locations.filter(l => l.targetId);
    return <section className="fleet-local" aria-label="Locations on this machine">
      <div className="fleet-local-head"><h3>Locations on this machine</h3><span className="muted small">Personal locations are set up in <button className="text-button" onClick={onSettings}>Settings</button>; project folders are enrolled here.</span><span className="fleet-grow" />
        <button className="button" onClick={() => void perform(async () => { setDrift(await api('deploy.drift')); await refresh(); }, 'Installed files checked')}><RefreshCw size={14} />Check drift</button>
        <button className="button" onClick={() => void perform(async () => { const result = await api<{ id: string; status: string }[]>('deploy.recover'); onMessage(result.length ? result.map(r => r.status).join('; ') : 'No interrupted installs'); await refresh(); })}>Recover interrupted installs</button></div>
      <div className="fleet-locations">{locations.map(l => { const t = snapshot.targets.find(x => x.id === l.targetId)!; return <div className="fleet-location" key={l.key}>
        <div><b>{l.label}</b><small>{isProject(l.key) ? 'Project' : 'Personal'} · {providerName[t.provider]}{locationClient(l.key) === null ? ' · skills only' : ''} · {(n => `${n} install receipt${n === 1 ? '' : 's'}`)(snapshot.receipts.filter(r => r.targetId === t.id && r.status === 'applied').length)} · {providers.find(p => p.id === t.provider)?.available ? 'client detected' : 'client not on PATH'}</small><code className="path-text">{t.root}/{targetSkillsFolder(t)}</code></div>
        <button className="button danger-text" onClick={() => void perform(async () => { await api('targets.remove', { id: t.id, confirm: true }); await refresh(); }, 'Location removed; installed files were left in place')}>Stop managing</button>
      </div>; })}</div>
      {drift.length > 0 && <div className="fleet-drift"><h3>Live destination checks</h3>{drift.map(d => <div className="drift-row" key={d.id}><code className="path-text">{d.destination}</code><Badge status={d.drifted ? 'drifted' : 'current'} />{d.drifted && <button className="button" title="See which files differ and how" onClick={() => onCompare(d.itemId, d.targetId)}>Compare</button>}<small>{date(d.checkedAt)}</small></div>)}</div>}
    </section>;
  }
}
