import { useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronRight, Circle, ExternalLink, FileDiff, FileInput, FlaskConical, History as HistoryIcon, Layers3, Plus, Rocket, Server, ShieldCheck, ShieldOff, Star, Trash2, X } from 'lucide-react';
import type { Installation, ItemDetail, Provider, ProviderId, Snapshot, Trial } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { Badge } from './components';
import { machinesEnabled } from './features';
import { copyLocation, EventGlyph, eventTitle, PublishState, trialVerdict } from './History';
import type { HistoryEvent } from './history-model';
import { dayLabel } from './history-model';
import { trialPlace } from './trial-place';
import { installationLabel } from './Installations';
import { SkillToggles } from './Skills';

const closedKey = 'kiln-rail-closed';
const closedSections = (): string[] => { try { const value = JSON.parse(localStorage.getItem(closedKey) ?? '[]'); return Array.isArray(value) ? value : []; } catch { return []; } };

/** A collapsible rail section with a count; `more` is shown in place by its "See all" control. Open state is remembered. */
function Section({ id, title, count, tone, children, more, moreLabel, action }: { id: string; title: string; count?: ReactNode; tone?: 'bad'; children: ReactNode; more?: ReactNode; moreLabel?: string; action?: ReactNode }) {
  const [open, setOpen] = useState(() => !closedSections().includes(id));
  const [expanded, setExpanded] = useState(false);
  const toggle = () => { const next = !open; setOpen(next); const rest = closedSections().filter(s => s !== id); localStorage.setItem(closedKey, JSON.stringify(next ? rest : [...rest, id])); };
  return <section className={`rail-section ${open ? 'open' : ''}`} aria-label={title}>
    <button type="button" className="rail-head" aria-expanded={open} onClick={toggle}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="rail-title">{title}</span>{count !== undefined && <span className={`rail-count ${tone ?? ''}`}>{count}</span>}</button>
    {open && <div className="rail-body">
      {children}
      {expanded && more}
      {(more || action) && <div className="rail-links">{more && <button type="button" className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : moreLabel ?? 'See all'}</button>}{action}</div>}
    </div>}
  </section>;
}
const Row = ({ label, children, top = false }: { label: string; children: ReactNode; top?: boolean }) => <div className={`rail-row ${top ? 'top' : ''}`}><span>{label}</span><div>{children}</div></div>;

function CopyGlyph({ copy }: { copy: Installation }) {
  if (copy.state === 'installed') return <span className="rail-glyph ok"><Check size={11} strokeWidth={3} /></span>;
  if (copy.state === 'drifted') return <span className="rail-glyph bad">!</span>;
  return copy.matches ? <span className="rail-glyph accent"><Circle size={7} fill="currentColor" /></span> : <span className="rail-glyph warn">≠</span>;
}

export type RailProps = {
  detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; installations: Installation[]; events: HistoryEvent[];
  sameTitle?: { label: string; full: string }; editing: boolean;
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>;
  onAction: (name: string, trial?: Trial) => void; onToggleInstall: (provider: ProviderId, targetId?: string) => void;
  onSetup: () => void; onSelect: (id: string) => void; onCollection: (name: string) => void; onMadeFrom: (sourceId: string) => void; onMachines?: () => void;
  onOpenTests: () => void; onOpenHistory: () => void;
  /** Where each experiment ran, by trial id (trial-place.ts). */ places?: Map<string, string>;
};
/** The item page's right rail: status and approval, installs, tests, history, provenance and organisation. */
export function ItemRail({ detail, snapshot, providers, installations, events, sameTitle, editing, perform, refresh, onAction, onToggleInstall, onSetup, onSelect, onCollection, onMadeFrom, onMachines, onOpenTests, onOpenHistory, places = new Map() }: RailProps) {
  const { item, revision } = detail;
  const [tag, setTag] = useState('');
  const isSource = item.kind === 'source';
  const shelved = ['archived', 'rejected'].includes(item.status);
  const approvals = detail.approvals.filter(a => a.trust === 'local');
  const currentApproved = approvals.some(a => a.revision === item.revision);
  const lastApproved = [...approvals].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const publishJob = snapshot.publish.find(j => j.itemId === item.id && j.revision === item.revision);
  const copies = installations.filter(copy => copy.itemId === item.id);
  const receipts = snapshot.receipts.filter(r => r.itemId === item.id);
  const trials = [...detail.trials].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const made = isSource ? snapshot.items.filter(i => i.origin?.itemId === item.id && !i.deletedAt).length : 0;
  const origin = item.origin ? snapshot.items.find(i => i.id === item.origin!.itemId) : undefined;
  const status = item.deletedAt ? 'deleted' : shelved ? item.status : currentApproved ? 'approved' : 'draft';

  const meta = (change: Record<string, unknown>, message?: string) => void perform(async () => { await api('items.meta', { id: item.id, expect: item.revision, ...change }); await refresh(); }, message);
  const move = (collection: string) => void perform(async () => { await api('items.move', { ids: [item.id], collection }); await refresh(); }, collection ? `Moved to “${collection}”` : 'Moved out of its collection');
  // Tags are part of the revision, so changing them saves a new draft the way the editor does.
  const retag = (tags: string[], summary: string) => void perform(async () => { await api('items.update', { id: item.id, expect: item.revision, summary, value: { ...revision, collection: item.collection, tags } }); await refresh(); }, 'Tags saved in a new draft revision');
  const addTag = () => { const value = tag.trim().replace(/^#/, ''); if (!value || item.tags.includes(value)) { setTag(''); return; } setTag(''); retag([...item.tags, value], `Added tag “${value}”`); };
  const tagsLocked = editing || Boolean(item.deletedAt);

  const copyRow = (copy: Installation) => <div className="rail-item" key={`${copy.targetId}-${copy.destination}`}>
    <CopyGlyph copy={copy} />
    <div className="rail-text"><span className="rail-name">{copyLocation(copy, snapshot)}</span><span className={`rail-sub ${copy.state === 'drifted' ? 'bad' : ''}`} title={copy.destination}>{installationLabel(copy)}</span></div>
    {copy.receiptId && copy.state === 'installed' ? <button className="rail-mini" onClick={() => onAction(`uninstall:${copy.receiptId}`)}><Trash2 size={12} />Remove</button>
      : copy.targetId && (copy.state === 'drifted' || !copy.matches) ? <button className="rail-mini bad" title="See which files differ and how" onClick={() => onAction(`compare:${copy.itemId}:${copy.targetId}`)}><FileDiff size={12} />Compare</button>
      : <button className="rail-mini accent" title="Let Kiln manage this identical copy, or remove it" onClick={() => onToggleInstall(copy.provider, copy.targetId)}>Install</button>}
  </div>;
  const trialRow = (t: Trial) => <button type="button" className="rail-item rail-button" key={t.id} onClick={onOpenTests} title={t.note || t.task}>
    <Badge status={trialVerdict(t)} />
    <div className="rail-text"><span className="rail-name">{trialPlace(t, places)}</span><span className="rail-sub"><code>{shortHash(t.revision)}</code>{t.model ? ` · ${t.model}` : ''}</span></div>
    <span className="rail-when">{date(t.createdAt)}</span>
  </button>;
  const eventRow = (e: HistoryEvent) => <button type="button" className="rail-item rail-button rail-event" key={e.id} onClick={onOpenHistory}>
    <EventGlyph event={e} />
    <div className="rail-text"><span className="rail-name">{eventTitle(e, snapshot)}</span><span className="rail-sub">{e.at ? `${dayLabel(e.at)} · ${new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Now'}</span></div>
  </button>;

  const installable = !isSource && ['skill', 'agent', 'instruction'].includes(item.kind);
  const drifted = copies.filter(c => c.state === 'drifted').length;
  const installed = copies.filter(c => c.state === 'installed').length;
  const deployLabel = machinesEnabled ? 'Install into a project folder…' : 'Install a specific revision…';

  return <aside className="item-rail" aria-label="Item status and organisation">
    <Section id="status" title={isSource ? 'Status' : 'Status & approval'} count={isSource && status === 'draft' ? undefined : <Badge status={status} />}
      more={!isSource && approvals.length > 0 ? <div className="rail-more">{[...approvals].reverse().map(a => <div className="rail-approval" key={a.id}><b>{shortHash(a.revision)} · approved by {a.reviewer}</b><span>{a.scope}{a.note ? ` · ${a.note}` : ''}</span>{a.waivedChecks && <span>Checks waived: {a.waivedChecks}</span>}<small>{date(a.createdAt)}</small></div>)}</div> : undefined}
      moreLabel={`See all ${approvals.length} approval${approvals.length === 1 ? '' : 's'}`}>
      {isSource ? <>
        <Row label="Made from it"><button className="text-button" disabled={!made} onClick={() => onMadeFrom(item.id)}><Layers3 size={13} />{made} item{made === 1 ? '' : 's'}</button></Row>
        <Row label="Updated">{date(item.updatedAt)}</Row>
      </> : <>
        <Row label="Approved revision">{lastApproved ? <code>{shortHash(lastApproved.revision)}</code> : <span className="muted">None yet</span>}</Row>
        {!currentApproved && <Row label="Current draft"><code>{shortHash(item.revision)}</code></Row>}
        {currentApproved && <Row label="Published"><PublishState compact job={publishJob} ahead={snapshot.git.ahead} onRetry={() => void perform(async () => { if (publishJob) await api('publish.retry', { id: publishJob.id }); await refresh(); })} /></Row>}
        {!currentApproved && lastApproved && detail.revisions.some(r => r.hash === lastApproved.revision) && <p className="rail-callout">Draft <code>{shortHash(item.revision)}</code> exists only on this machine until you approve it. GitHub and installs keep <code>{shortHash(lastApproved.revision)}</code>.</p>}
        <Row label="Evidence"><span className="muted">{detail.trials.filter(t => t.revision === item.revision && t.status === 'completed').length} completed test{detail.trials.filter(t => t.revision === item.revision && t.status === 'completed').length === 1 ? '' : 's'} · copied {detail.observations.filter(o => o.kind === 'copied').length}×</span></Row>
        {!item.deletedAt && <div className="rail-actions">{currentApproved
          ? <button className="rail-mini" title="Withdraw approval; installed copies stay in place." onClick={() => onAction('unapprove')}><ShieldOff size={12} />Unapprove</button>
          : <button className="rail-mini accent" title="Approve this revision and publish it to GitHub." onClick={() => onAction('approve')}><ShieldCheck size={12} />Approve {shortHash(item.revision)}</button>}</div>}
      </>}
    </Section>

    {installable && <Section id="installs" title="Installs" count={item.kind === 'instruction' ? receipts.length : `${installed} installed`} tone={drifted ? 'bad' : undefined}
      more={copies.length > 3 ? <>{copies.slice(3).map(copyRow)}</> : undefined} moreLabel={`See all ${copies.length} copies`}
      action={onMachines && machinesEnabled ? <button type="button" className="text-button" onClick={onMachines}><Server size={13} />Other machines…</button> : undefined}>
      {['skill', 'agent'].includes(item.kind) && <SkillToggles item={item} providers={providers} snapshot={snapshot} installations={installations} onToggle={onToggleInstall} onSetup={onSetup} />}
      {copies.slice(0, 3).map(copyRow)}
      {item.kind === 'instruction' && <p className="rail-note">{receipts.length ? `${receipts.length} install receipt${receipts.length === 1 ? '' : 's'}; each is in History.` : 'Not installed anywhere yet.'}</p>}
      <button className="rail-mini" disabled={!approvals.length} title={approvals.length ? (machinesEnabled ? 'Install an approved revision into a project folder or an earlier revision anywhere.' : 'Install an approved revision, including an earlier one, into a folder Kiln manages.') : 'Approve a revision first; only approved revisions are installed.'} onClick={() => onAction('deploy')}><Rocket size={12} />{deployLabel}</button>
      <p className="rail-note">{machinesEnabled ? 'Install receipts are in History. Check live drift in Machines before treating an old receipt as current.' : 'Install receipts are in History. The toggles show what is in each folder now.'}</p>
    </Section>}

    {!isSource && <Section id="tests" title="Tests" count={trials.length} action={<button type="button" className="text-button" onClick={onOpenTests}><FlaskConical size={13} />Open tests</button>}>
      {trials.slice(0, 2).map(trialRow)}
      {!trials.length && <p className="rail-note">Not tested yet. A test runs this revision on a real task.</p>}
    </Section>}

    <Section id="history" title="History" count={events.length} action={<button type="button" className="text-button" onClick={onOpenHistory}><HistoryIcon size={13} />Open history</button>}>
      {events.slice(0, 3).map(eventRow)}
    </Section>

    <Section id="provenance" title="Provenance">
      {origin && <div className="rail-prov"><FileInput size={14} /><span>{origin.kind === 'source' ? 'From' : 'Derived from'} “{origin.title}”{origin.kind !== 'source' && <> @ <code>{shortHash(item.origin!.revision)}</code></>}</span><button className="rail-mini accent" onClick={() => onSelect(origin.id)}>Open</button></div>}
      {item.origin && !origin && <div className="rail-prov"><FileInput size={14} /><span>Made from an item no longer in the library (<code>{shortHash(item.origin.itemId)}</code>)</span></div>}
      <Row label="Source" top>{/^https?:\/\//i.test(item.source) ? <button className="text-button rail-link" title={item.source} onClick={() => void perform(() => api('desktop.openContentUrl', { url: item.source }))}>{item.source.replace(/^https?:\/\/(www\.)?/, '')}<ExternalLink size={12} /></button> : <span className="rail-wrap" title={sameTitle?.full}>{sameTitle ? sameTitle.label : item.source || 'Captured locally'}</span>}</Row>
      <Row label="Licence">{item.licence}</Row>
      <Row label="Captured">{date(item.createdAt)}</Row>
      <Row label="Item ID"><code className="rail-wrap">{item.id}</code></Row>
    </Section>

    <Section id="organisation" title="Organisation">
      <Row label="Collection"><select className="rail-select" aria-label="Collection" value={item.collection} disabled={Boolean(item.deletedAt)} onChange={e => move(e.target.value)}><option value="">Unfiled</option>{[...new Set([...snapshot.collections, ...(item.collection ? [item.collection] : [])])].map(name => <option key={name} value={name}>{name.replaceAll('/', ' / ')}</option>)}</select>{item.collection && <button className="icon-button rail-icon" aria-label={`Open the “${item.collection}” collection`} title="Open this collection" onClick={() => onCollection(item.collection)}><ArrowRight size={13} /></button>}</Row>
      <Row label="Tags" top><div className="rail-tags" title={tagsLocked ? 'Finish editing first' : 'Tags are part of the revision: changing them saves a new draft.'}>
        {item.tags.map(t => <span className="rail-chip" key={t}>#{t}{!tagsLocked && <button aria-label={`Remove tag ${t}`} onClick={() => retag(item.tags.filter(x => x !== t), `Removed tag “${t}”`)}><X size={11} /></button>}</span>)}
        {!tagsLocked && <span className="rail-chip add"><Plus size={11} /><input aria-label="Add tag" value={tag} placeholder="tag" size={5} onChange={e => setTag(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } if (e.key === 'Escape') setTag(''); }} onBlur={() => { if (tag.trim()) addTag(); }} /></span>}
      </div></Row>
      <Row label="Favourite"><button className={`rail-fav ${item.favourite ? 'on' : ''}`} aria-pressed={item.favourite} onClick={() => meta({ favourite: !item.favourite })}><Star size={14} fill={item.favourite ? 'currentColor' : 'none'} />{item.favourite ? 'In favourites' : 'Add'}</button></Row>
    </Section>
  </aside>;
}
