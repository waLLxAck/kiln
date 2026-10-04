import fs from 'node:fs';
import path from 'node:path';
import { hashSchema, type Item, type ProviderId, type Revision } from '../protocol/schema';
import { atomicWrite, digest } from '../storage/files';
import { skillName, validateContent } from './content';
import type { Workbench } from './workbench';

/** Identity of a skill's content for matching a folder with the library (imports, scans): the text with LF endings and its files. */
export const contentKey = (value: { content: string; files: Record<string, string> }) => digest({ content: value.content.replace(/\r\n/g, '\n'), files: value.files });
/** Identity of an agent definition for matching: its text with LF endings and the client it is for. */
export const agentKey = (value: { content: string; agent?: { provider: ProviderId } }) => digest({ content: value.content.replace(/\r\n/g, '\n'), provider: value.agent?.provider });

/**
 * What scans need from one revision, so the installations list, usage names and repository matching need not read, check and
 * re-hash every bundle on every call. Revisions are immutable, so these are worked out once per revision.
 */
export type RevisionFacts = {
  kind: Item['kind'];
  /** A skill's frontmatter `name` ('' when it has none or cannot be read); an agent definition's filename. */
  name: string;
  /** State hash of the files a deployment writes for it: an installed copy with these bytes hashes the same. */
  rendered: string;
  /** The client an agent definition is written for. */
  provider: ProviderId | null;
  /** What `validateContent` reports, for agent definitions only (scans never check skills). */
  problems: string[];
  /** Matching key: `contentKey` for skills, `agentKey` for agents, '' for other kinds. */
  key: string;
  parent: string | null;
  summary: string;
};

export function revisionFacts(revision: Revision): RevisionFacts {
  const agent = revision.kind === 'agent';
  let name = '';
  if (agent) name = revision.agent?.filename ?? '';
  else try { name = skillName(revision); } catch { /* Unreadable frontmatter: no name. */ }
  let problems: string[] = [];
  if (agent) try { problems = validateContent(revision); } catch (error) { problems = [error instanceof Error ? error.message : String(error)]; }
  const rendered = digest(agent ? { '.instruction': Buffer.from(revision.content).toString('base64') } : { 'SKILL.md': Buffer.from(revision.content).toString('base64'), ...revision.files });
  return { kind: revision.kind, name, rendered, provider: revision.agent?.provider ?? null, problems, key: revision.kind === 'skill' ? contentKey(revision) : agent ? agentKey(revision) : '', parent: revision.parent, summary: revision.summary };
}

type Stored = { schemaVersion: 1; entries: Record<string, { stamp: string; facts: RevisionFacts }> };
const MAX_ENTRIES = 20_000;

/**
 * Revision facts per item revision, kept in the machine-private folder (`<local>/cache/revision-facts.json`) so a cold start
 * reads no revision bodies either. An entry is trusted while its revision file has the size and modification time it had when
 * the entry was made; anything else (a restored or damaged file) is read again through `getRevision`, which checks the hash.
 */
export class RevisionFactsCache {
  private entries = new Map<string, { stamp: string; facts: RevisionFacts }>();
  private loaded = false;
  private dirty = false;
  constructor(private wb: Workbench) {}
  private get file() { return path.join(this.wb.local, 'cache', 'revision-facts.json'); }
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Stored;
      if (stored?.schemaVersion === 1 && stored.entries && typeof stored.entries === 'object') this.entries = new Map(Object.entries(stored.entries));
    } catch { /* No cache yet, or a damaged one: start over. */ }
  }
  /** Size and modification time of the revision's file, where `getRevision` would read it; null when there is none. */
  private stamp(itemId: string, hash: string) {
    if (!hashSchema.safeParse(hash).success) return null;
    const stat = fs.statSync(path.join(this.wb.itemDir(itemId), 'revisions', `${hash}.json`), { throwIfNoEntry: false })
      ?? fs.statSync(path.join(this.wb.local, 'private-revisions', itemId, `${hash}.json`), { throwIfNoEntry: false });
    return stat?.isFile() ? `${stat.size}:${stat.mtimeMs}` : null;
  }
  /** Facts of `hash` (the item's current revision by default). Throws as `getRevision` does when the revision cannot be read. */
  get(item: Pick<Item, 'id' | 'revision'>, hash = item.revision): RevisionFacts {
    this.load();
    const key = `${item.id}:${hash}`, stamp = this.stamp(item.id, hash), hit = this.entries.get(key);
    if (hit && stamp && hit.stamp === stamp) return hit.facts;
    const facts = revisionFacts(this.wb.getRevision(item.id, hash));
    if (stamp) { this.entries.set(key, { stamp, facts }); this.dirty = true; }
    return facts;
  }
  /** Writes new entries, if any. Called once at the end of each scan rather than after every revision. */
  save() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.entries.size > MAX_ENTRIES) this.entries = new Map([...this.entries].slice(-MAX_ENTRIES / 2));
    try { atomicWrite(this.file, JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries(this.entries) } satisfies Stored)); }
    catch { /* A cache that cannot be written is rebuilt next time. */ }
  }
}

const caches = new WeakMap<Workbench, RevisionFactsCache>();
/** The one facts cache per open library, shared by deployment, usage and import scans. */
export function factsCache(wb: Workbench) {
  let cache = caches.get(wb);
  if (!cache) caches.set(wb, cache = new RevisionFactsCache(wb));
  return cache;
}
