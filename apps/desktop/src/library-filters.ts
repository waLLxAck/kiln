/**
 * The library query: filter tokens (`kind:skill`, `in:claude`, `tag:git`…) typed into one bar. Kept free of React so it can be
 * tested. Two tokens of one facet match either value; different facets must all match. Copy facets (`in:`, `scope:`,
 * `provider:` and the copy kinds of `state:`) describe one local copy, so together they must hold for the same copy.
 */
import type { Installation, Item, ProviderId, SkillInvocation } from '../../../packages/protocol/schema';
import type { SkillLocation } from '../../../packages/providers/skill-locations';
import { isWithin } from '../../../packages/domain/collections';

export type Facet = 'kind' | 'status' | 'in' | 'state' | 'provider' | 'scope' | 'tag' | 'from' | 'collection' | 'is';
export type QueryToken = { facet: Facet; value: string };
export const sameToken = (a: QueryToken, b: QueryToken) => a.facet === b.facet && a.value === b.value;

/** Facets in the order the autocomplete lists them, each with what its values mean. */
export const facets: { key: Facet; label: string; hint: string }[] = [
  { key: 'kind', label: 'Kind', hint: 'skill, prompt, source…' },
  { key: 'status', label: 'Status', hint: 'draft, testing, approved' },
  { key: 'state', label: 'Installed', hint: 'installed, not installed, changed outside Kiln' },
  { key: 'in', label: 'Installed in', hint: 'a skill folder, personal or in a project' },
  { key: 'is', label: 'Is', hint: 'favourite, duplicate, model-invoked, you only' },
  { key: 'tag', label: 'Tag', hint: 'a tag' },
  { key: 'from', label: 'From source', hint: 'what one source produced, wherever it is filed' },
  { key: 'collection', label: 'Collection', hint: 'a collection and its subfolders' },
  { key: 'provider', label: 'Provider', hint: 'native agent definitions or client-specific copies' },
  { key: 'scope', label: 'Scope', hint: 'personal folders or enrolled project folders' },
];

export const statusLabel: Record<Item['status'], string> = { captured: 'draft', testing: 'testing', approved: 'approved', rejected: 'rejected', archived: 'archived' };
export const locationLabel: Record<SkillLocation, string> = { agents: 'Shared Agents', claude: 'Claude', codex: 'Codex-specific', copilot: 'Copilot-specific' };
export const providerLabel: Record<ProviderId, string> = { codex: 'Codex-specific', claude: 'Claude-specific', copilot: 'Copilot-specific' };
/** Item-level install states first, then the ones that describe a single copy. */
export const stateLabel = { installed: 'installed', none: 'not installed', changed: 'changed outside Kiln', managed: 'managed by Kiln', external: 'external copy', linked: 'link or junction' } as const;
export type InstallState = keyof typeof stateLabel;
export const stateHint: Record<InstallState, string> = {
  installed: 'At least one copy on this machine, in any folder.', none: 'A skill or agent with no copy on this machine.',
  changed: 'A copy no longer matches the library revision.', managed: 'Installed by Kiln and tracked.',
  external: 'Found in a skill folder but not installed by Kiln.', linked: 'A link or junction instead of a real folder.',
};
export const installable = (item: Pick<Item, 'kind'>) => item.kind === 'skill' || item.kind === 'agent';

/** The words a token shows after its facet. Sources and unknown values fall back to the raw value. */
export function tokenLabel(token: QueryToken, sourceTitle?: (id: string) => string | undefined): string {
  switch (token.facet) {
    case 'status': return statusLabel[token.value as Item['status']] ?? token.value;
    case 'in': return locationLabel[token.value as SkillLocation] ?? token.value;
    case 'provider': return providerLabel[token.value as ProviderId] ?? token.value;
    case 'state': return stateLabel[token.value as InstallState] ?? token.value;
    case 'from': return sourceTitle?.(token.value) ?? 'a removed source';
    case 'is': return isLabel[token.value] ?? token.value;
    default: return token.value;
  }
}

/** `is:` values past favourite: `model-invoked` is a skill some client's model may invoke on its own (its description loads in
 * every new session), `user-only` one only you can invoke. */
const isLabel: Record<string, string> = { duplicate: 'a duplicate', 'model-invoked': 'invoked by the model', 'user-only': 'you only' };
export const isHint: Record<string, string> = { 'model-invoked': 'Skills a model may invoke on its own: their descriptions load in every new session.', 'user-only': 'Skills only you can invoke, by name.' };
/** Whether a skill matches `is:model-invoked` (any client's model may invoke it) or `is:user-only` (none may). */
const invokedBy = (value: string, item: Item, invocation?: Record<string, SkillInvocation>) => {
  const state = item.kind === 'skill' ? invocation?.[item.id] : undefined; if (!state) return false;
  return value === 'model-invoked' ? state.claude || state.codex : !state.claude && !state.codex;
};
/** Groups the tokens by facet: one set of accepted values per facet in use. */
const byFacet = (tokens: QueryToken[]) => { const map = new Map<Facet, string[]>(); for (const t of tokens) map.set(t.facet, [...(map.get(t.facet) ?? []), t.value]); return map; };

const none: ReadonlySet<string> = new Set();
/**
 * Whether an item passes every token. `copies` are all installations on this machine; only the item's own are looked at.
 * `duplicates` holds the ids of items in a duplicate group (`is:duplicate`); `invocation` the snapshot's model-invocation switches.
 */
export function matchesQuery(item: Item, copies: Installation[], tokens: QueryToken[], duplicates = none, invocation?: Record<string, SkillInvocation>): boolean {
  if (!tokens.length) return true;
  const groups = byFacet(tokens), any = (facet: Facet, test: (value: string) => boolean) => { const values = groups.get(facet); return !values || values.some(test); };
  if (!any('kind', v => item.kind === v) || !any('status', v => item.status === v) || !any('is', v => v === 'favourite' ? item.favourite : v === 'duplicate' ? duplicates.has(item.id) : invokedBy(v, item, invocation))) return false;
  if (!any('tag', v => item.tags.includes(v)) || !any('from', v => item.origin?.itemId === v) || !any('collection', v => isWithin(item.collection, v))) return false;
  const where = groups.get('in'), scope = groups.get('scope'), provider = groups.get('provider'), state = groups.get('state');
  if (!where && !scope && !provider && !state) return true;
  const own = copies.filter(c => c.itemId === item.id);
  // A provider names client-specific content, not inferred runtime access to shared skills; a native agent names it itself.
  const fits = (c: Installation) => (!where || where.includes(c.location ?? '')) && (!scope || scope.includes(c.scope ?? '')) && (!provider || (item.kind === 'agent' ? provider.includes(item.agent?.provider ?? '') : provider.includes(c.location ?? '')));
  if (!state) return !where && !scope && item.kind === 'agent' ? provider!.includes(item.agent?.provider ?? '') : own.some(fits);
  return state.some(value => value === 'none' ? installable(item) && !own.some(fits)
    : value === 'installed' ? own.some(fits)
    : own.some(c => fits(c) && (value === 'managed' ? c.state === 'installed' : value === 'external' ? c.state === 'external' : value === 'linked' ? c.linked : value === 'changed' ? !c.matches : false)));
}

/** Every token worth offering for these items, most useful facets first. Values that no item has are left out. */
export function candidateTokens(items: Item[], copies: Installation[], sources: Item[], duplicates = none, invocation?: Record<string, SkillInvocation>): QueryToken[] {
  const out: QueryToken[] = [];
  const push = (facet: Facet, values: Iterable<string>) => { for (const value of values) out.push({ facet, value }); };
  const kinds = new Set(items.map(i => i.kind)), statuses = new Set(items.map(i => i.status));
  push('kind', [...kinds]);
  push('status', (Object.keys(statusLabel) as Item['status'][]).filter(s => statuses.has(s)));
  if (items.some(installable)) push('state', Object.keys(stateLabel));
  const ids = new Set(items.map(i => i.id)), own = copies.filter(c => ids.has(c.itemId));
  push('in', (Object.keys(locationLabel) as SkillLocation[]).filter(l => own.some(c => c.location === l)));
  push('is', [...(items.some(i => i.favourite) ? ['favourite'] : []), ...(items.some(i => duplicates.has(i.id)) ? ['duplicate'] : []), ...['model-invoked', 'user-only'].filter(v => items.some(i => invokedBy(v, i, invocation)))]);
  push('tag', [...new Set(items.flatMap(i => i.tags))].sort((a, b) => a.localeCompare(b)));
  const made = new Set(items.map(i => i.origin?.itemId).filter(Boolean));
  push('from', sources.filter(s => made.has(s.id)).map(s => s.id));
  push('collection', [...new Set(items.map(i => i.collection).filter(Boolean))].sort((a, b) => a.localeCompare(b)));
  push('provider', (Object.keys(providerLabel) as ProviderId[]).filter(p => own.some(c => c.location === p) || items.some(i => i.kind === 'agent' && i.agent?.provider === p)));
  push('scope', (['personal', 'project'] as const).filter(s => own.some(c => c.scope === s)));
  return out;
}

/**
 * When nothing matches, the token (or the free text, as `null`) whose removal brings back the most items, with that count.
 * `count` answers "how many would show with these tokens and this text".
 */
export function narrowest(tokens: QueryToken[], text: string, count: (tokens: QueryToken[], text: string) => number): { token: QueryToken | null; count: number } | null {
  const options: { token: QueryToken | null; count: number }[] = tokens.map(token => ({ token, count: count(tokens.filter(t => !sameToken(t, token)), text) }));
  if (text.trim()) options.push({ token: null, count: count(tokens, '') });
  return options.sort((a, b) => b.count - a.count)[0] ?? null;
}

/** Reads `facet:value` typing: the facet when the prefix names one, and what follows it. */
export function parseTyped(text: string): { facet: Facet | null; rest: string } {
  const match = text.match(/^\s*(\w+):(.*)$/);
  const facet = match && facets.find(f => f.key === match[1].toLowerCase())?.key;
  return facet ? { facet, rest: match![2].trim().toLowerCase() } : { facet: null, rest: text.trim().toLowerCase() };
}

/** The lifecycle stages in the sidebar. Installed means a copy on this machine, whatever the item's status. */
export type Stage = 'drafts' | 'testing' | 'approved' | 'installed';
export const stages: { id: Stage; label: string; hint: string }[] = [
  { id: 'drafts', label: 'Drafts', hint: 'New or edited, only on this machine. Nothing tried on this revision yet.' },
  { id: 'testing', label: 'Testing', hint: 'Drafts with at least one experiment on the current revision.' },
  { id: 'approved', label: 'Approved', hint: 'You approved this exact revision. It is on GitHub and can be installed.' },
  { id: 'installed', label: 'Installed', hint: 'Skills and agents with at least one copy on this machine.' },
];
export const inStage = (item: Item, stage: Stage | '', copies: Installation[]) => !stage
  || (stage === 'drafts' ? item.status === 'captured' : stage === 'testing' ? item.status === 'testing' : stage === 'approved' ? item.status === 'approved' : installable(item) && copies.some(c => c.itemId === item.id));

/** The rail's numbers (Rail.tsx): the library, Unfiled, Archive, Trash, each stage and each collection with its subfolders. */
export type RailCounts = { library: number; unfiled: number; archive: number; trash: number; stages: Partial<Record<Stage, number>>; collections: Map<string, number> };
/**
 * Counts everything in one pass over the items, so the rail costs the same however many collections there are. Archived and
 * rejected items (`hidden`) count only under Archive; `inStage` says whether an item is in a stage.
 */
export function railCounts(items: Item[], hidden: (item: Item) => boolean, inStage: (item: Item, stage: Stage) => boolean): RailCounts {
  const counts: RailCounts = { library: 0, unfiled: 0, archive: 0, trash: 0, stages: {}, collections: new Map() };
  for (const item of items) {
    if (item.deletedAt) { counts.trash++; continue; }
    if (hidden(item)) { counts.archive++; continue; }
    counts.library++;
    if (!item.collection) counts.unfiled++;
    else { const parts = item.collection.split('/'); for (let n = 1; n <= parts.length; n++) { const name = parts.slice(0, n).join('/'); counts.collections.set(name, (counts.collections.get(name) ?? 0) + 1); } }
    for (const s of stages) if (inStage(item, s.id)) counts.stages[s.id] = (counts.stages[s.id] ?? 0) + 1;
  }
  return counts;
}
