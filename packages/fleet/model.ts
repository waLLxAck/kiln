/**
 * The fleet model without Node: how this machine's targets and copies become a portable machine report, and how any report
 * reads as matrix cells. The backend publishes what `buildReport` returns; the Machines view runs the same function on the
 * snapshot it already has, so the live column for this machine is exactly what other machines will see.
 */
import { skillLocation, skillLocationLabel, type SkillLocation } from '../providers/skill-locations';
import type { Approval, CopyState, Installation, Item, LocationKey, MachineIdentity, MachineReport, Receipt, Target } from '../protocol/schema';

export type FleetLocation = MachineReport['locations'][number];
export type LocalLocation = FleetLocation & { targetId: string | null; root: string | null };
export type FleetInputs = { items: Item[]; approvals: Approval[]; targets: Target[]; receipts: Receipt[]; installations: Installation[]; home: string };

const personalOrder: SkillLocation[] = ['agents', 'claude', 'codex', 'copilot'];
const normal = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '');
const folded = (value: string) => normal(value).toLowerCase();
/** The last segment of a path on either platform, cleaned so it fits a location key. */
export const folderName = (root: string) => (normal(root).split('/').pop() || 'project').replace(/[:\u0000-\u001f]/g, '-').slice(0, 100);
const locationOf = (key: LocationKey): SkillLocation => key.startsWith('project:') ? (key.match(/:(agents|claude|codex|copilot)$/)?.[1] as SkillLocation | undefined) ?? 'agents' : key as SkillLocation;
/** The client whose agent definitions a location can hold; the Codex-specific folder holds skills only. */
export const locationClient = (key: LocationKey) => ({ agents: 'codex', claude: 'claude', copilot: 'copilot', codex: null } as const)[locationOf(key)];
export const isProject = (key: LocationKey) => key.startsWith('project:');

/**
 * Location keys for this machine's enrolled targets. Personal targets are keyed by their skill location; when two personal
 * targets share a location, the one in the home folder wins, as it does for installs. Projects are keyed by folder name; a
 * second project folder with the same name gets " (2)", in root order so the key is stable.
 */
export function targetLocations(targets: Target[], home: string): LocalLocation[] {
  const result: LocalLocation[] = [];
  const personal = targets.filter(t => t.scope === 'personal').sort((a, b) => Number(folded(b.root) === folded(home)) - Number(folded(a.root) === folded(home)) || a.root.localeCompare(b.root));
  for (const location of personalOrder) {
    const target = personal.find(t => skillLocation(t) === location);
    if (target) result.push({ key: location, label: skillLocationLabel[location], scope: 'personal', managed: true, targetId: target.id, root: target.root });
  }
  // Folder name per project root; the same folder enrolled for two locations shares it.
  const names = new Map<string, string>(), used = new Map<string, number>();
  for (const target of targets.filter(t => t.scope === 'project').sort((a, b) => a.root.localeCompare(b.root) || a.provider.localeCompare(b.provider))) {
    const location = skillLocation(target), root = folded(target.root);
    let name = names.get(root);
    if (!name) { const base = folderName(target.root), n = (used.get(base.toLowerCase()) ?? 0) + 1; used.set(base.toLowerCase(), n); name = n === 1 ? base : `${base} (${n})`; names.set(root, name); }
    const key = `project:${name}${location === 'agents' ? '' : `:${location}`}`;
    if (result.some(l => l.key === key)) continue;
    result.push({ key, label: location === 'agents' ? name : `${name} · ${skillLocationLabel[location]}`, scope: 'project', managed: true, targetId: target.id, root: target.root });
  }
  return result;
}
/** The newest locally trusted approval of an item: the revision installs and sync use. */
export function latestApproval(approvals: Approval[], itemId: string) {
  return approvals.filter(a => a.itemId === itemId && a.trust === 'local' && !a.revokedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
const rank: Record<CopyState, number> = { installed: 0, outdated: 1, changed: 2, external: 3 };
/** This machine's locations (enrolled ones, plus unmanaged folders that hold copies) and its copies, keyed portably. */
export function localCopies(inputs: FleetInputs) {
  const locations = targetLocations(inputs.targets, inputs.home);
  const copies: MachineReport['copies'] = {};
  const byTarget = new Map(locations.filter(l => l.targetId).map(l => [l.targetId!, l]));
  const approved = new Map<string, string | undefined>();
  const itemsById = new Map(inputs.items.map(i => [i.id, i]));
  const receipts = new Map(inputs.receipts.map(r => [r.id, r]));
  for (const copy of inputs.installations) {
    const item = itemsById.get(copy.itemId); if (!item) continue;
    let location = copy.targetId ? byTarget.get(copy.targetId) : undefined;
    if (!location) {
      // A folder found next to an enrolled target, such as .claude/skills in a home enrolled only for Agents.
      const where = copy.location ?? 'agents';
      const owner = inputs.targets.find(t => folded(copy.destination).startsWith(folded(t.root) + '/') && t.scope === copy.scope);
      if (!owner) continue;
      const projectName = copy.scope === 'project' ? locations.find(l => l.scope === 'project' && l.root && folded(l.root) === folded(owner.root))?.key.slice('project:'.length).replace(/:(agents|claude|codex|copilot)$/, '') ?? folderName(owner.root) : '';
      const key = copy.scope === 'personal' ? where : `project:${projectName}${where === 'agents' ? '' : `:${where}`}`;
      location = locations.find(l => l.key === key);
      if (!location) { location = { key, label: copy.scope === 'personal' ? skillLocationLabel[where] : where === 'agents' ? projectName : `${projectName} · ${skillLocationLabel[where]}`, scope: copy.scope ?? 'personal', managed: false, targetId: null, root: null }; locations.push(location); }
    }
    if (!approved.has(item.id)) approved.set(item.id, latestApproval(inputs.approvals, item.id)?.revision);
    const latest = approved.get(item.id);
    const receipt = copy.receiptId ? receipts.get(copy.receiptId) : undefined;
    const revision = receipt?.revision ?? (copy.matches ? item.revision : null);
    const state: CopyState = copy.state === 'drifted' ? 'changed' : copy.state === 'external' ? 'external' : latest && revision !== latest ? 'outdated' : 'installed';
    const existing = copies[item.id]?.[location.key];
    if (existing && rank[existing.state] <= rank[state]) continue;
    (copies[item.id] ??= {})[location.key] = { revision, state };
  }
  return { locations, copies };
}
/** Items a machine report covers: skills and agents that are not in the trash. */
export const installable = (item: Item) => (item.kind === 'skill' || item.kind === 'agent') && !item.deletedAt;
/** This machine's report. `wanted` is carried over from the committed report (with local edits applied), never derived here. */
export function buildReport(identity: MachineIdentity, appVersion: string, inputs: FleetInputs, wanted: MachineReport['wanted'], reportedAt: string): MachineReport {
  const { locations, copies } = localCopies(inputs);
  const order = (l: FleetLocation) => l.scope === 'personal' ? personalOrder.indexOf(l.key as SkillLocation) : 10;
  return {
    schemaVersion: 1, id: identity.id, name: identity.name, platform: identity.platform, appVersion, reportedAt,
    locations: locations.map(({ key, label, scope, managed }) => ({ key, label, scope, managed })).sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label)),
    copies: sortRecord(copies),
    // Requests for items this machine has not seen yet are kept: they may arrive with the next pull.
    wanted: sortRecord(Object.fromEntries(Object.entries(wanted).map(([id, keys]) => [id, [...new Set(keys)].sort()]).filter(([, keys]) => keys.length))) as MachineReport['wanted'],
  };
}
function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? sortRecord(v as Record<string, unknown>) as T : v]));
}
/** Whether two reports say the same thing, ignoring when they were written. */
export const sameReport = (a: MachineReport | null, b: MachineReport) => Boolean(a) && stable({ ...a, reportedAt: '' }) === stable({ ...b, reportedAt: '' });
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
/** Sets or clears one wanted entry; returns a new list. */
export function applyWanted(wanted: MachineReport['wanted'], itemId: string, location: LocationKey, on: boolean): MachineReport['wanted'] {
  const next = { ...wanted }, keys = new Set(next[itemId] ?? []);
  if (on) keys.add(location); else keys.delete(location);
  if (keys.size) next[itemId] = [...keys].sort(); else delete next[itemId];
  return next;
}

export type CellState = CopyState | 'marked' | 'off' | 'unavailable';
export type Cell = { state: CellState; revision: string | null; wanted: boolean; reason?: string };
/**
 * One matrix cell. A copy wins over a mark; an installed copy of an older revision than the approval this machine knows reads
 * as outdated even when its report is older than the approval. Without a copy, a cell needs an approval and a suitable client.
 */
export function cellFor(item: Item, approved: string | undefined, report: Pick<MachineReport, 'copies' | 'wanted'>, location: FleetLocation): Cell {
  const copy = report.copies[item.id]?.[location.key], wanted = Boolean(report.wanted[item.id]?.includes(location.key));
  if (copy) return { state: copy.state === 'installed' && approved && copy.revision !== approved ? 'outdated' : copy.state, revision: copy.revision, wanted };
  if (!approved) return { state: 'unavailable', revision: null, wanted, reason: 'Approve first. Only approved revisions are installed.' };
  if (item.kind === 'agent' && locationClient(location.key) !== item.agent?.provider) return { state: 'unavailable', revision: null, wanted, reason: locationClient(location.key) ? `This location isn’t read by ${item.agent?.provider === 'claude' ? 'Claude Code' : item.agent?.provider === 'copilot' ? 'Copilot' : 'Codex'}, the client this agent was written for.` : 'Agent definitions don’t go in the Codex-specific skills folder.' };
  if (wanted) return { state: 'marked', revision: null, wanted };
  if (!location.managed) return { state: 'unavailable', revision: null, wanted, reason: 'Kiln doesn’t manage this folder on that machine.' };
  return { state: 'off', revision: null, wanted };
}
/** Per machine: how many copies there are in each state, and marks not installed yet. */
export function summarise(items: Item[], approvals: Approval[], report: Pick<MachineReport, 'copies' | 'wanted' | 'locations'>) {
  const totals = { copies: 0, installed: 0, changed: 0, outdated: 0, external: 0, marked: 0 };
  for (const item of items.filter(installable)) {
    const approved = latestApproval(approvals, item.id)?.revision;
    for (const location of report.locations) {
      const cell = cellFor(item, approved, report, location);
      if (cell.state === 'marked') totals.marked++;
      else if (cell.state !== 'off' && cell.state !== 'unavailable') { totals.copies++; totals[cell.state]++; }
    }
    // A mark for a location that machine doesn't have (yet) still counts as waiting.
    for (const key of report.wanted[item.id] ?? []) if (!report.locations.some(l => l.key === key) && !report.copies[item.id]?.[key]) totals.marked++;
  }
  return totals;
}
