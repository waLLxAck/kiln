import { primarySkillLabel } from '../../../packages/providers/skill-locations';
import { useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronUp, Github, RefreshCw, Rows3 } from 'lucide-react';
import type { Approval, Installation, Item, Provider, Target, Trial } from '../../../packages/protocol/schema';
import { Badge, ContextMenu, statusHelp, type MenuEntry } from './components';
import { date } from './api';
import { skillState } from './Skills';
import { installable } from './library-filters';
import { outdatedCopies } from './item-page';
import type { GroupKey } from './library-sort';
import './library.css';

export { arrangeItems, defaultSort, groupItems, KINDS, kindPlural, moveInOrder, nextSort, sortItems, type GroupKey, type Sort, type SortKey } from './library-sort';

/** A configured personal skill folder: which agent reads it and the target Kiln installs into. */
export type Location = { provider: Provider; target: Target };
/** The locations an item can be installed into: its own agent's folder for a native agent, every skill folder but Copilot's otherwise. */
export const locationsFor = (item: Item, locations: Location[]) => locations.filter(l => item.kind === 'agent' ? l.provider.id === item.agent?.provider : l.provider.id !== 'copilot');
export const locationName = (item: Item, provider: Provider) => item.kind === 'agent' ? provider.label : primarySkillLabel(provider.id);

/**
 * Draft, Testing or Approved in plain words. An approved revision shows whether it reached GitHub; a draft on top of an earlier
 * approval says so, because what is installed is still the approved one. A source is material, so it shows what was made from it.
 */
export function StatusCell({ item, approvals, published, made = 0 }: { item: Item; approvals: Approval[]; published: boolean; made?: number }) {
  if (item.kind === 'source') return <span className="lib-made" title="Items made from this source">{made} made</span>;
  if (['archived', 'rejected'].includes(item.status)) return <Badge status={item.status} />;
  const earlier = item.status !== 'approved' && approvals.some(a => a.itemId === item.id && a.revision !== item.revision && a.trust === 'local' && !a.revokedAt);
  if (item.status === 'approved' || earlier) return <span className="lib-status" title={earlier ? 'The current revision is a draft on top of the approved one. Installs use the approved revision.' : published ? 'Approved and on GitHub' : 'Approved; the push to GitHub has not finished'}>
    <span className="lib-pill ok"><Check size={11} />Approved</span>{earlier ? <span className="lib-newer">+ newer draft</span> : <Github size={13} className={`lib-pushed ${published ? 'on' : 'pending'}`} aria-label={published ? 'On GitHub' : 'Push pending'} />}
  </span>;
  return item.status === 'testing' ? <span className="lib-pill warn" title={statusHelp.testing}>Testing</span> : <span className="lib-pill" title={statusHelp.captured}>Draft</span>;
}

/** Copy states that no longer match the library revision. */
const changedStates = ['drifted', 'differs'];
/** Copies that are there but Kiln did not install: an identical copy it found, or a link. Kiln can take them over. */
const unmanagedStates = ['found', 'linked'];
/** The dot for one folder: installed by Kiln, behind the approved revision, there but unmanaged, changed, or empty. */
const dotClass = (state: string) => state === 'off' ? 'off' : changedStates.includes(state) ? 'changed' : state;
/** What a personal folder's copy is, for the cell's tooltip. */
const stateWords: Record<string, string> = { off: 'not installed', on: 'installed', outdated: 'installed, update available', found: 'identical copy, not managed by Kiln', linked: 'a link, not managed by Kiln', differs: 'differs', drifted: 'edited outside Kiln' };
/**
 * "2 of 3" personal folders with one dot per folder, then a note when a copy changed outside Kiln, has an update (personal
 * and project copies, as the header's Update installs counts them) or is there without Kiln managing it. Copies in enrolled
 * project folders are counted after. Kinds that cannot be installed show a dash.
 */
export function InstalledCell({ item, locations, installations }: { item: Item; locations: Location[]; installations: Installation[] }) {
  if (!installable(item)) return <span className="faint" title="Only skills and agent definitions install into agent folders">—</span>;
  const places = locationsFor(item, locations).map(l => ({ ...l, state: skillState(item, l.target, installations).state }));
  const present = places.filter(p => p.state !== 'off'), changed = places.filter(p => changedStates.includes(p.state)).length, unmanaged = places.filter(p => unmanagedStates.includes(p.state)).length;
  const personal = new Set(places.map(p => p.target.id));
  const projects = installations.filter(i => i.itemId === item.id && !personal.has(i.targetId) && i.scope === 'project'), project = projects.length;
  const outdated = outdatedCopies(item.id, installations).length, outdatedProjects = projects.filter(i => i.state === 'installed' && i.outdated).length;
  const title = [...places.map(p => `${locationName(item, p.provider)}: ${stateWords[p.state] ?? p.state}`), ...(project ? [`${project} project cop${project === 1 ? 'y' : 'ies'}${outdatedProjects ? `, ${outdatedProjects} with an update` : ''}`] : [])].join('\n');
  if (!places.length && !project) return <span className="faint" title="No skill folder is set up. Choose one in Settings.">Not set up</span>;
  return <span className="lib-installed" title={title}>
    {places.length > 0 && <span className="lib-dots" aria-hidden="true">{places.map(p => <i key={p.target.id} className={dotClass(p.state)} />)}</span>}
    {/* With only project copies the empty dots already say "not in a personal folder", so the words stay short. */}
    <span className={present.length || project ? '' : 'faint'}>{present.length ? `${present.length} of ${places.length}` : places.length && !project ? 'Not installed' : ''}{project ? `${present.length ? ' · ' : ''}${project} project` : ''}</span>
    {changed > 0 && <span className="lib-changed">{changed} changed</span>}
    {outdated > 0 && <span className="lib-outdated">{outdated} update{outdated === 1 ? '' : 's'}</span>}
    {!changed && !outdated && unmanaged > 0 && <span className="lib-unmanaged">{unmanaged} unmanaged</span>}
  </span>;
}

const verdict: Record<string, { label: string; tone: string }> = { pass: { label: 'Pass', tone: 'ok' }, fail: { label: 'Fail', tone: 'bad' }, uncertain: { label: 'Uncertain', tone: 'warn' } };
/** The newest experiment on an item: its verdict and the project it ran in. `trial` is picked by the caller from the snapshot. */
export function TestCell({ item, trial, place = 'Unknown project' }: { item: Item; trial?: Trial; /** Where it ran (trial-place.ts). */ place?: string }) {
  if (item.kind === 'source') return <span className="faint">—</span>;
  if (!trial) return <span className="faint">Not tested</span>;
  const older = trial.revision !== item.revision ? ' (an earlier revision)' : '';
  if (trial.status !== 'completed' || !trial.judgement) return <span className="lib-test" title={`${trial.status === 'prepared' ? 'Waiting for a result' : 'Cancelled'}${older}`}><span className="lib-pill">{trial.status === 'prepared' ? 'Waiting' : 'Cancelled'}</span><span className="muted ellipsis">{place}</span></span>;
  const v = verdict[trial.judgement];
  return <span className="lib-test" title={`${v.label} on ${place} · ${trial.case} case · ${date(trial.createdAt)}${older}`}><span className={`lib-pill ${v.tone}`}>{v.label}</span><span className="muted ellipsis">{place}</span></span>;
}

/** A pill that opens a menu of choices, used for Sort and Group by (QueryBar.tsx). */
export function MenuPill({ icon, name, value, entries, title }: { icon: ReactNode; name: string; value: string; entries: MenuEntry[]; title: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  return <span className="menu-pill">
    <button ref={ref} type="button" aria-haspopup="menu" aria-expanded={Boolean(open)} title={title} onClick={() => { const box = ref.current!.getBoundingClientRect(); setOpen({ x: box.right - 220, y: box.bottom + 4 }); }}>{icon}<span className="faint">{name}:</span> <b>{value}</b><ChevronDown size={12} /></button>
    {open && <ContextMenu x={open.x} y={open.y} entries={entries} onClose={() => setOpen(null)} />}
  </span>;
}
const groupLabel: Record<GroupKey, string> = { none: 'None', collection: 'Collection', kind: 'Kind', status: 'Status' };
export function GroupMenu({ group, onGroup }: { group: GroupKey; onGroup: (group: GroupKey) => void }) {
  return <MenuPill icon={<Rows3 size={13} />} name="Group" value={groupLabel[group]} title="Group the list under headings" entries={(Object.keys(groupLabel) as GroupKey[]).map(g => ({ label: groupLabel[g], checked: g === group, onSelect: () => onGroup(g) }))} />;
}

/**
 * The thin bar above an open item: back to the list, and where the item sits in it with steps to its neighbours. Refresh sits
 * here too, since the list heading that has it is hidden while an item is open.
 */
export function ItemBar({ label, position, total, onBack, onStep, onRefresh }: { label: string; position: number; total: number; onBack: () => void; onStep: (direction: number) => void; onRefresh: () => void }) {
  return <div className="item-bar" role="toolbar" aria-label="Item navigation">
    <button type="button" className="item-bar-back" onClick={onBack} title="Back to the list (Esc)"><ArrowLeft size={14} />{label}</button>
    <span className="item-bar-sep" />
    {position > 0 ? <span className="muted small item-bar-pos">{position} of {total}</span> : <span className="muted small item-bar-pos">Not in this view</span>}
    <button type="button" className="icon-button" aria-label="Previous item" title="Previous item (Alt+↑)" disabled={position <= 1} onClick={() => onStep(-1)}><ChevronUp size={15} /></button>
    <button type="button" className="icon-button" aria-label="Next item" title="Next item (Alt+↓)" disabled={position < 1 || position >= total} onClick={() => onStep(1)}><ChevronDown size={15} /></button>
    <kbd className="item-bar-esc">Esc</kbd>
    <button type="button" className="icon-button" aria-label="Refresh library" title="Re-read the library and installed copies" onClick={onRefresh}><RefreshCw size={14} /></button>
  </div>;
}
