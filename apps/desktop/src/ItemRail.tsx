import { experimentsOf, reviews, verdictOf } from './trial-verdicts';
import { Fragment, useState, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, Circle, CircleArrowUp, ExternalLink, FileDiff, FlaskConical, FolderPlus, History as HistoryIcon, Plus, Rocket, Server, ShieldCheck, ShieldOff, Trash2, X } from 'lucide-react';
import type { Installation, ItemDetail, Provider, ProviderId, Snapshot, Trial } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { Badge } from './components';
import { machinesEnabled } from './features';
import { EventGlyph, eventTitle, PublishState, trialVerdict } from './History';
import type { HistoryEvent } from './history-model';
import { dayLabel } from './history-model';
import { trialPlace } from './trial-place';
import { copyName, installationLabel } from './Installations';
import { outdatedCopies } from './item-page';
import { clientSpecific, SkillToggles, toggleTargets } from './Skills';
import './installs.css';

const closedKey = 'kiln-rail-closed';
const closedSections = (): string[] => { try { const value = JSON.parse(localStorage.getItem(closedKey) ?? '[]'); return Array.isArray(value) ? value : []; } catch { return []; } };

/** A collapsible rail section with a count; `more` is shown in place by its "See all" control. Open state is remembered. */
function Section({ id, title, count, tone, children, more, moreLabel, action }: { id: string; title: string; count?: ReactNode; tone?: 'bad' | 'accent'; children: ReactNode; more?: ReactNode; moreLabel?: string; action?: ReactNode }) {
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
  if (copy.state === 'installed' && copy.outdated) return <span className="rail-glyph accent"><ArrowUp size={11} strokeWidth={3} /></span>;
  if (copy.state === 'installed') return <span className="rail-glyph ok"><Check size={11} strokeWidth={3} /></span>;
  if (copy.state === 'drifted') return <span className="rail-glyph bad">!</span>;
  return copy.matches ? <span className="rail-glyph accent"><Circle size={7} fill="currentColor" /></span> : <span className="rail-glyph warn">≠</span>;
}

export type RailProps = {
  detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; installations: Installation[]; events: HistoryEvent[];
  sameTitle?: { label: string; full: string }; editing: boolean;
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>;
  onAction: (name: string, trial?: Trial) => void; onToggleInstall: (provider: ProviderId, targetId?: string) => void;
  onSetup: () => void; onMachines?: () => void;
  onOpenTests: () => void; onOpenHistory: () => void;
  /** The header's primary button already approves this revision. */ approveInHeader?: boolean;
  /** The header's primary button already opens the source URL. */ sourceInHeader?: boolean;
  /** Where each experiment ran, by trial id (trial-place.ts). */ places?: Map<string, string>;
};
/**
 * The item page's right rail: approval, installs, tests, history, provenance and organisation. Each fact appears once on
 * the page, so what the header shows (status badge, favourite star, collection, the source chip, Updated) isn't repeated here.
 */
export function ItemRail({ detail, snapshot, providers, installations, events, sameTitle, editing, perform, refresh, onAction, onToggleInstall, onSetup, onMachines, onOpenTests, onOpenHistory, approveInHeader = false, sourceInHeader = false, places = new Map() }: RailProps) {
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
  const judged = reviews(detail.trials);
  const trials = [...experimentsOf(detail.trials)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const originGone = Boolean(item.origin && !snapshot.items.some(i => i.id === item.origin!.itemId));
  const completed = experimentsOf(detail.trials).filter(t => t.revision === item.revision && t.status === 'completed').length;
  const copied = detail.observations.filter(o => o.kind === 'copied').length;
  const licence = item.licence && item.licence !== 'Unknown' ? item.licence : '';
  const url = /^https?:\/\//i.test(item.source);

  const move = (collection: string) => void perform(async () => { await api('items.move', { ids: [item.id], collection }); await refresh(); }, collection ? `Moved to “${collection}”` : 'Moved out of its collection');
  // Tags are part of the revision, so changing them saves a new draft the way the editor does.
  const retag = (tags: string[], summary: string) => void perform(async () => { await api('items.update', { id: item.id, expect: item.revision, summary, value: { ...revision, collection: item.collection, tags } }); await refresh(); }, 'Tags saved in a new draft revision');
  const addTag = () => { const value = tag.trim().replace(/^#/, ''); if (!value || item.tags.includes(value)) { setTag(''); return; } setTag(''); retag([...item.tags, value], `Added tag “${value}”`); };
  const tagsLocked = editing || Boolean(item.deletedAt);

  // One action per copy: Update when it is behind (the dialog also offers Remove), Remove, Compare for a different copy, or
  // Install to let Kiln manage an identical one. A copy in a folder Kiln doesn't manage has no action here.
  const copyRow = (copy: Installation) => <div className="rail-item" key={`${copy.targetId}-${copy.destination}`}>
    <CopyGlyph copy={copy} />
    <div className="rail-text"><span className="rail-name">{copyName(copy, snapshot, item.kind)}</span><span className={`rail-sub ${copy.state === 'drifted' ? 'bad' : copy.outdated ? 'accent' : ''}`} title={copy.destination}>{installationLabel(copy)}</span></div>
    {!copy.targetId ? null
      : copy.state === 'installed' && copy.outdated ? <button className="rail-mini accent" title="Install the approved revision over this copy, or remove it" onClick={() => onToggleInstall(copy.provider, copy.targetId)}><CircleArrowUp size={12} />Update</button>
      : copy.receiptId && copy.state === 'installed' ? <button className="rail-mini" onClick={() => onToggleInstall(copy.provider, copy.targetId)}><Trash2 size={12} />Remove</button>
      : copy.state === 'drifted' || !copy.matches ? <button className="rail-mini bad" title="See which files differ and how" onClick={() => onAction(`compare:${copy.itemId}:${copy.targetId}`)}><FileDiff size={12} />Compare</button>
      : <button className="rail-mini accent" title="Let Kiln manage this identical copy, or remove it" onClick={() => onToggleInstall(copy.provider, copy.targetId)}>Install</button>}
  </div>;
  const trialRow = (t: Trial) => <button type="button" className="rail-item rail-button" key={t.id} onClick={onOpenTests} title={t.note || t.task}>
    <Badge status={verdictOf(t, judged) ?? t.status} />
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
  const outdated = outdatedCopies(item.id, copies).length;
  // Personal copies in a location with a toggle, or in the client-specific disclosure, are shown there; the rows list the rest.
  const toggled = new Set(toggleTargets(item, providers, snapshot.targets).map(t => t.id));
  const listed = copies.filter(c => c.scope !== 'project' && !(c.targetId && toggled.has(c.targetId)) && !clientSpecific(item, c));
  const projectCopies = copies.filter(c => c.scope === 'project');
  const rows = [...listed, ...projectCopies];
  const row = (copy: Installation, n: number) => <Fragment key={`${copy.targetId}-${copy.destination}`}>{n === listed.length && <h4 className="rail-subhead">Projects</h4>}{copyRow(copy)}</Fragment>;
  const installsCount = item.kind === 'instruction' ? receipts.length : drifted ? `${drifted} changed` : outdated ? `${outdated} update${outdated === 1 ? '' : 's'} available` : `${installed} installed`;

  return <aside className="item-rail" aria-label="Item status and organisation">
    {/* A source has no approval; what was made from it is on the page itself. */}
    {!isSource && <Section id="status" title="Approval"
      more={approvals.length > 0 ? <div className="rail-more">{[...approvals].reverse().map(a => <div className="rail-approval" key={a.id}><b>{shortHash(a.revision)} · approved by {a.reviewer}</b><span>{a.scope}{a.note ? ` · ${a.note}` : ''}</span>{a.waivedChecks && <span>Checks waived: {a.waivedChecks}</span>}<small>{date(a.createdAt)}</small></div>)}</div> : undefined}
      moreLabel={`See all ${approvals.length} approval${approvals.length === 1 ? '' : 's'}`}>
      <Row label="Approved revision">{lastApproved ? <code title={currentApproved ? 'The current revision' : 'GitHub and installs keep this revision until you approve the draft.'}>{shortHash(lastApproved.revision)}</code> : <span className="muted">None yet</span>}</Row>
      {!currentApproved && lastApproved && <Row label="Draft"><code title="Only on this machine until you approve it">{shortHash(item.revision)}</code></Row>}
      {currentApproved && <Row label="Published"><PublishState compact job={publishJob} ahead={snapshot.git.ahead} onRetry={() => void perform(async () => { if (publishJob) await api('publish.retry', { id: publishJob.id }); await refresh(); })} /></Row>}
      <Row label="Evidence"><span className="muted">{completed} completed test{completed === 1 ? '' : 's'} · copied {copied}×</span></Row>
      {!item.deletedAt && !shelved && (currentApproved || !approveInHeader) && <div className="rail-actions">{currentApproved
        ? <button className="rail-mini" title="Withdraw approval; installed copies stay in place." onClick={() => onAction('unapprove')}><ShieldOff size={12} />Unapprove</button>
        : <button className="rail-mini accent" title="Approve this revision and publish it to GitHub." onClick={() => onAction('approve')}><ShieldCheck size={12} />Approve</button>}</div>}
    </Section>}

    {installable && <Section id="installs" title="Installs" count={installsCount} tone={drifted ? 'bad' : outdated && item.kind !== 'instruction' ? 'accent' : undefined}
      more={rows.length > 3 ? <>{rows.slice(3).map((copy, n) => row(copy, n + 3))}</> : undefined} moreLabel={`See all ${rows.length} copies`}
      action={onMachines && machinesEnabled ? <button type="button" className="text-button" onClick={onMachines}><Server size={13} />Other machines…</button> : undefined}>
      {['skill', 'agent'].includes(item.kind) && <SkillToggles item={item} providers={providers} snapshot={snapshot} installations={installations} onToggle={onToggleInstall} onSetup={onSetup} />}
      {rows.slice(0, 3).map(row)}
      {item.kind === 'instruction' && !receipts.length && <p className="rail-note">Not installed anywhere yet.</p>}
      {/* Instruction files go to folders Kiln manages; skills and agents go into any project folder, which becomes one of your projects. */}
      {item.kind === 'instruction'
        ? <button className="rail-mini" disabled={!approvals.length} title={approvals.length ? 'Install an approved revision, including an earlier one, into a folder Kiln manages.' : 'Approve a revision first; only approved revisions are installed.'} onClick={() => onAction('deploy')}><Rocket size={12} />Install an approved revision…</button>
        : !item.deletedAt && <button className="rail-mini" title="Install into a project folder on this machine: one you used before, or any folder." onClick={() => onAction('install-project')}><FolderPlus size={12} />Install into project…</button>}
    </Section>}

    {!isSource && <Section id="tests" title="Tests" count={trials.length} action={<button type="button" className="text-button" onClick={onOpenTests}><FlaskConical size={13} />Open tests</button>}>
      {trials.slice(0, 2).map(trialRow)}
      {!trials.length && <p className="rail-note">Not tested yet.</p>}
    </Section>}

    <Section id="history" title="History" count={events.length} action={<button type="button" className="text-button" onClick={onOpenHistory}><HistoryIcon size={13} />Open history</button>}>
      {events.slice(0, 3).map(eventRow)}
    </Section>

    {/* Where it came from; the item it was made from is the header's "From …" chip. */}
    <Section id="provenance" title="Provenance">
      {originGone && <p className="rail-note">Made from an item no longer in the library.</p>}
      {(item.source || sameTitle) && <Row label="Source">{url && !sourceInHeader ? <button className="text-button rail-link" title={item.source} onClick={() => void perform(() => api('desktop.openContentUrl', { url: item.source }))}>{item.source.replace(/^https?:\/\/(www\.)?/, '')}<ExternalLink size={12} /></button> : <span className="rail-wrap" title={sameTitle?.full ?? item.source}>{sameTitle ? sameTitle.label : item.source.replace(/^https?:\/\/(www\.)?/, '')}</span>}</Row>}
      {licence && <Row label="Licence">{licence}</Row>}
      <Row label="Captured">{date(item.createdAt)}</Row>
    </Section>

    <Section id="organisation" title="Organisation">
      <Row label="Collection"><select className="rail-select" aria-label="Collection" value={item.collection} disabled={Boolean(item.deletedAt)} onChange={e => move(e.target.value)}><option value="">Unfiled</option>{[...new Set([...snapshot.collections, ...(item.collection ? [item.collection] : [])])].map(name => <option key={name} value={name}>{name.replaceAll('/', ' / ')}</option>)}</select></Row>
      <Row label="Tags" top><div className="rail-tags" title={tagsLocked ? 'Finish editing first' : 'Tags are part of the revision: changing them saves a new draft.'}>
        {item.tags.map(t => <span className="rail-chip" key={t}>#{t}{!tagsLocked && <button aria-label={`Remove tag ${t}`} onClick={() => retag(item.tags.filter(x => x !== t), `Removed tag “${t}”`)}><X size={11} /></button>}</span>)}
        {!tagsLocked && <span className="rail-chip add"><Plus size={11} /><input aria-label="Add tag" value={tag} placeholder="tag" size={5} onChange={e => setTag(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } if (e.key === 'Escape') setTag(''); }} onBlur={() => { if (tag.trim()) addTag(); }} /></span>}
      </div></Row>
    </Section>
  </aside>;
}
