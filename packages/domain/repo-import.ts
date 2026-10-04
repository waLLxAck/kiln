import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Authoring, Item, ProviderId } from '../protocol/schema';
import { readJson, writeJson } from '../storage/files';
import { listGitHubRepositories } from '../git/github';
import { fetchRepository, type Checkout } from '../git/repo-source';
import { agentBundle, agentKey } from './agents-import';
import { validateContent } from './content';
import { invariant } from './errors';
import { commitUrl, parseGitHubRepo, repoName, repoSourceOf, type GitHubRepoLink } from './github-url';
import { detectLayout, folderLicence, type RepoLayout } from './repo-layout';
import { contentKey, skillBundle } from './skills-import';
import type { Workbench } from './workbench';
import { factsCache } from './revision-facts';

/** How a found skill or agent compares with the library: not there, the same bytes as an item (its current or approved revision), or a different version of one. */
export type RepoEntryStatus = 'new' | 'identical' | 'differs';
/** One skill or agent definition a scan found. `key` identifies it in `repos.import`'s `select`. */
export type RepoEntry = {
  key: string; kind: 'skill' | 'agent'; title: string; path: string; layout: string; provider?: ProviderId; plugin?: string; licence: string; fileCount: number;
  status: RepoEntryStatus;
  /** The library item it matches. `against`: which of that item's revisions it was compared with (the approved one when there is one). `sameSource`: the item was imported from this path of this repository, so importing updates it instead of adding a copy. */
  match: { itemId: string; title: string; against: 'approved' | 'current'; sameSource: boolean; /** The item was changed in Kiln since it was last imported: not offered by default, so an import never quietly replaces your edits. */ edited: boolean } | null;
  validation: string[]; error: string | null; /** Offered for import by default: not already identical, readable, and listed by its plugin. */ selected: boolean;
};
/** What a repository offers, compared with the library. Nothing is written except the machine-private checkout. */
export type RepoScan = { name: string; url: string; ref: string; scope: string; commit: string; licence: string; readme: string; collection: string; skills: RepoEntry[]; agents: RepoEntry[]; instructions: string[]; plugins: string[]; truncated: boolean; /** The source item an earlier scan of this repository (and folder) created, if any. */ sourceItemId: string | null };
export type RepoImportResult = { sourceItemId: string; collection: string; imported: { id: string; title: string }[]; updated: { id: string; title: string }[]; unchanged: string[]; failed: { key: string; error: string }[] };
/** A well-known public repository of skills in "Browse skill repositories". */
export type Registry = { url: string; description: string };

/** Starting list for "Browse skill repositories": public repositories checked to exist, each mostly skills. Users can edit it. */
export const DEFAULT_REGISTRIES: Registry[] = [
  { url: 'https://github.com/anthropics/skills', description: 'Anthropic’s public Agent Skills: documents, design, building with Claude' },
  { url: 'https://github.com/mattpocock/skills', description: 'Matt Pocock’s engineering skills: grilling, specs, TDD, code review' },
  { url: 'https://github.com/openai/skills', description: 'OpenAI’s skills catalog for Codex' },
  { url: 'https://github.com/obra/superpowers', description: 'Superpowers: a skills framework and development methodology' },
  { url: 'https://github.com/vercel-labs/agent-skills', description: 'Vercel’s collection of agent skills' },
  { url: 'https://github.com/huggingface/skills', description: 'Hugging Face ecosystem skills' },
  { url: 'https://github.com/trailofbits/skills', description: 'Trail of Bits security research and audit skills' },
  { url: 'https://github.com/microsoft/skills', description: 'Microsoft SDK skills, custom agents and AGENTS.md files' },
];
const registrySchema = z.object({ url: z.string().trim().min(1).max(500), description: z.string().trim().max(300).default('') });
const urlSchema = z.object({ url: z.string().trim().min(1).max(2000) });
const MAX_README = 60_000;
/** Checkouts reused for this long before a scan asks GitHub for the latest commit again. */
const FRESH_MS = 10 * 60_000;

const linkOf = (url: string) => { const link = parseGitHubRepo(url); invariant(link, 'INVALID_URL', 'Paste a GitHub repository link such as https://github.com/owner/repo.'); return link; };
/** The first paragraph of prose in a README, for the source item's one-line description. */
function readmeSummary(text: string) {
  const paragraph = text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n\s*\n/).map(p => p.trim()).find(p => p && !/^(#|<|!\[|\[!\[|>|```|\||-{3,})/.test(p)) ?? '';
  return paragraph.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}
type Found = { entry: RepoEntry; bundle: Authoring | null };

/**
 * Skills and agents from GitHub repositories: `scan` fetches one commit into the machine-private cache and lists what it holds,
 * `import` copies the chosen ones into the library as drafts linked to a source item for the repository, `source` makes only that
 * source item (for an agent's deeper look). Items record where they came from as `https://github.com/<owner>/<repo>/tree/<commit>/<path>`
 * and carry the repository's (or the skill folder's own) licence.
 */
export class RepoImports {
  private fetched = new Map<string, { at: number; checkout: Promise<Checkout> }>();
  constructor(private wb: Workbench) {}
  private registryFile() { return path.join(this.wb.local, 'skill-repositories.json'); }
  /** The "Browse skill repositories" list: the user's edited list, or the defaults until it is edited. */
  registries(): Registry[] {
    try { return z.array(registrySchema).max(200).parse((readJson(this.registryFile()) as { repositories: unknown }).repositories); } catch { return DEFAULT_REGISTRIES; }
  }
  saveRegistries(input: unknown): Registry[] {
    const { repositories } = z.object({ repositories: z.array(registrySchema).max(200) }).parse(input);
    const seen = new Set<string>(), list = repositories.map(r => { const link = linkOf(r.url); return { url: link.rest ? r.url.replace(/\/+$/, '') : link.url, description: r.description }; }).filter(r => !seen.has(r.url.toLowerCase()) && seen.add(r.url.toLowerCase()));
    writeJson(this.registryFile(), { schemaVersion: 1, repositories: list }); return list;
  }
  /** The signed-in user's repositories (GitHub CLI, at most 100), filtered by name or description. */
  async mine(input: unknown = {}) {
    const { filter } = z.object({ filter: z.string().max(200).default('') }).parse(input ?? {});
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (await listGitHubRepositories()).filter(r => words.every(w => `${r.nameWithOwner} ${r.description ?? ''}`.toLowerCase().includes(w)));
  }
  /** The checkout for a link. A scan (`fresh`) asks GitHub for the latest commit; an import or preview right after reuses what it fetched. */
  private checkout(link: GitHubRepoLink, fresh = false): Promise<Checkout> {
    const key = `${link.url}|${link.blob}|${link.rest}`.toLowerCase(), cached = this.fetched.get(key);
    if (cached && !fresh && Date.now() - cached.at < FRESH_MS) return cached.checkout.then(c => fs.existsSync(c.dir) ? c : (this.fetched.delete(key), this.checkout(link)));
    const checkout = fetchRepository(this.wb.local, link);
    this.fetched.set(key, { at: Date.now(), checkout }); checkout.catch(() => this.fetched.delete(key));
    return checkout;
  }
  /**
   * Library skills and agents by content (current and approved revision), by the repository path they were imported from, and by
   * name. Content keys come from the revision facts cache (revision-facts.ts), so a scan reads no library revision it read before.
   */
  private library() {
    const facts = factsCache(this.wb);
    const approvedAt = new Map<string, { revision: string; at: string }>();
    for (const a of this.wb.approvals()) if (a.trust === 'local' && (approvedAt.get(a.itemId)?.at ?? '') < a.createdAt) approvedAt.set(a.itemId, { revision: a.revision, at: a.createdAt });
    const byContent = new Map<string, { item: Item; against: 'approved' | 'current' }>(), byOrigin = new Map<string, Item>(), byName = new Map<string, Item>();
    const keyOf = (kind: Item['kind'], value: Authoring) => kind === 'skill' ? `skill:${contentKey(value)}` : `agent:${agentKey(value)}`;
    for (const item of this.wb.listItems().filter(i => i.kind === 'skill' || i.kind === 'agent')) {
      try {
        const current = facts.get(item), approved = approvedAt.get(item.id)?.revision;
        byContent.set(`${item.kind}:${current.key}`, { item, against: approved === item.revision ? 'approved' : 'current' });
        if (approved && approved !== item.revision) byContent.set(`${item.kind}:${facts.get(item, approved).key}`, { item, against: 'approved' });
        const origin = parseGitHubRepo(item.source);
        if (origin?.rest) byOrigin.set(`${item.kind}:${repoName(origin).toLowerCase()}:${origin.rest.split('/').slice(1).join('/')}`, item);
        if (!byName.has(`${item.kind}:${item.title.toLowerCase()}`)) byName.set(`${item.kind}:${item.title.toLowerCase()}`, item);
      } catch { /* A damaged item cannot be matched; it is reported elsewhere. */ }
    }
    facts.save();
    return { byContent, byOrigin, byName, keyOf, approvedAt, facts };
  }
  /** Reads every found skill and agent from the checkout as a draft bundle and compares it with the library. */
  private found(link: GitHubRepoLink, checkout: Checkout, layout: RepoLayout, collection: string): Found[] {
    const lib = this.library(), abs = (relative: string) => path.join(checkout.dir, ...relative.split('/').filter(Boolean));
    const compare = (kind: 'skill' | 'agent', relative: string, bundle: Authoring) => {
      const same = lib.byContent.get(lib.keyOf(kind, bundle));
      if (same) return { status: 'identical' as const, match: { itemId: same.item.id, title: same.item.title, against: same.against, sameSource: false, edited: false } };
      const origin = lib.byOrigin.get(`${kind}:${repoName(link).toLowerCase()}:${relative}`), other = origin ?? lib.byName.get(`${kind}:${bundle.title.toLowerCase()}`);
      if (!other) return { status: 'new' as const, match: null };
      // Imported and untouched since: the first revision, or one an earlier import of this path wrote.
      let edited = true; try { const current = lib.facts.get(other); edited = !(current.parent === null || current.summary.startsWith('Updated from ')); } catch { /* unreadable: treat as edited */ }
      return { status: 'differs' as const, match: { itemId: other.id, title: other.title, against: lib.approvedAt.has(other.id) ? 'approved' as const : 'current' as const, sameSource: Boolean(origin), edited: Boolean(origin) && edited } };
    };
    const skills = layout.skills.map((skill): Found => {
      const base = { key: `skill:${skill.path}`, kind: 'skill' as const, title: skill.name, path: skill.path, layout: skill.layout, ...(skill.plugin ? { plugin: skill.plugin } : {}) };
      try {
        const licence = folderLicence(checkout.dir, skill.path) || layout.licence;
        const bundle = skillBundle(abs(skill.path), commitUrl(link, checkout.commit, skill.path), { collection, licence, tags: ['imported', 'github'] });
        const { status, match } = compare('skill', skill.path, bundle);
        return { bundle, entry: { ...base, title: bundle.title, licence, fileCount: Object.keys(bundle.files).length + 1, status, match, validation: validateContent(bundle), error: null, selected: status !== 'identical' && skill.listed && !match?.edited } };
      } catch (error) { return { bundle: null, entry: { ...base, licence: layout.licence, fileCount: 0, status: 'new', match: null, validation: [], error: error instanceof Error ? error.message : String(error), selected: false } }; }
    });
    const agents = layout.agents.map((agent): Found => {
      const base = { key: `agent:${agent.path}`, kind: 'agent' as const, title: agent.name, path: agent.path, layout: path.posix.dirname(agent.path), provider: agent.provider };
      try {
        const bundle: Authoring = { ...agentBundle(abs(agent.path), agent.provider), source: commitUrl(link, checkout.commit, agent.path), collection, licence: layout.licence, tags: ['imported', 'github'] };
        const { status, match } = compare('agent', agent.path, bundle);
        return { bundle, entry: { ...base, title: bundle.title, licence: layout.licence, fileCount: 1, status, match, validation: validateContent(bundle), error: null, selected: status !== 'identical' && !match?.edited } };
      } catch (error) { return { bundle: null, entry: { ...base, licence: layout.licence, fileCount: 0, status: 'new', match: null, validation: [], error: error instanceof Error ? error.message : String(error), selected: false } }; }
    });
    return [...skills, ...agents];
  }
  private existingSource(link: GitHubRepoLink, scope: string) {
    return this.wb.listItems().find(i => { const s = repoSourceOf(i); return s && s.link.url.toLowerCase() === link.url.toLowerCase() && s.scope === scope; }) ?? null;
  }
  private async read(input: unknown, fresh = false) {
    const { url } = urlSchema.parse(input); const link = linkOf(url);
    const checkout = await this.checkout(link, fresh), layout = detectLayout(checkout.dir, checkout.scope);
    return { link, checkout, layout };
  }
  /** Fetches a repository (one shallow commit) and lists its skills, agents and instruction files, each compared with the library. */
  async scan(input: unknown): Promise<RepoScan> {
    const { link, checkout, layout } = await this.read(input, true);
    const collection = repoName(link), found = this.found(link, checkout, layout, collection).map(f => f.entry);
    return { name: repoName(link), url: link.url, ref: checkout.ref, scope: checkout.scope, commit: checkout.commit, licence: layout.licence, readme: layout.readme, collection, skills: found.filter(e => e.kind === 'skill'), agents: found.filter(e => e.kind === 'agent'), instructions: layout.instructions, plugins: layout.plugins.map(p => p.name), truncated: layout.truncated, sourceItemId: this.existingSource(link, checkout.scope)?.id ?? null };
  }
  /** One found entry's text and file list, for a look before importing. */
  async preview(input: unknown) {
    const { key } = z.object({ key: z.string().min(1).max(2000) }).passthrough().parse(input);
    const { link, checkout, layout } = await this.read(input);
    const found = this.found(link, checkout, layout, repoName(link)).find(f => f.entry.key === key);
    invariant(found?.bundle, 'NOT_FOUND', 'That skill is no longer in the repository. Scan it again.');
    return { key, title: found.bundle.title, content: found.bundle.content.slice(0, 200_000), files: Object.keys(found.bundle.files).sort(), licence: found.bundle.licence };
  }
  /** Creates or refreshes the source item for a repository (and folder): its link, README and the commit it was read at. */
  private ensureSource(link: GitHubRepoLink, checkout: Checkout, layout: RepoLayout, collection: string): Item {
    const readmeFile = layout.readme ? path.join(checkout.dir, ...layout.readme.split('/')) : '';
    const readme = readmeFile ? fs.readFileSync(readmeFile, 'utf8').slice(0, MAX_README) : '';
    const shown = checkout.scope ? `${link.url}/tree/${checkout.ref || checkout.commit}/${checkout.scope}` : link.url;
    const value: Authoring = { title: `${repoName(link)}${checkout.scope ? ` · ${checkout.scope}` : ''}`.slice(0, 160), kind: 'source', description: readmeSummary(readme), content: `${shown}\n\n${readme.trim() || 'This repository has no README.'}\n`, files: {}, tags: ['github', 'repository'], collection, source: commitUrl(link, checkout.commit, checkout.scope), licence: layout.licence };
    const existing = this.existingSource(link, checkout.scope);
    if (!existing) { const item = this.wb.create(value, undefined, false); this.wb.record('imported', `Scanned ${repoName(link)} at ${checkout.commit.slice(0, 7)}`, item.id, item.revision); return item; }
    const current = this.wb.authoring(existing.id);
    if (current.source === value.source) return existing;
    // A newer commit refreshes the link and README; the collection and any analysis summary stay.
    return this.wb.update({ id: existing.id, expect: existing.revision, summary: `Scanned ${repoName(link)} at ${checkout.commit.slice(0, 7)}`, value: { ...current, content: value.content, source: value.source, licence: value.licence, description: current.description || value.description } });
  }
  /** The repository's source item without importing anything: what "Dig deeper" runs the agent on. */
  async source(input: unknown) {
    const { collection } = z.object({ collection: z.string().trim().max(200).optional() }).passthrough().parse(input);
    const { link, checkout, layout } = await this.read(input);
    return this.ensureSource(link, checkout, layout, collection || repoName(link));
  }
  /**
   * Imports the chosen entries (`select`: keys or paths; default: what the scan offers) as drafts linked to the repository's source
   * item. Identical content is not duplicated; an item imported earlier from the same path gets the new version as a new revision
   * (its approval stays on the approved revision); everything else becomes a new item. Nothing is installed or approved.
   */
  async import(input: unknown): Promise<RepoImportResult> {
    const data = z.object({ url: z.string(), select: z.array(z.string().min(1).max(2000)).max(5000).optional(), collection: z.string().trim().max(200).optional(), confirm: z.literal(true) }).parse(input);
    const { link, checkout, layout } = await this.read(data);
    const collection = data.collection || repoName(link), found = this.found(link, checkout, layout, collection);
    const wanted = data.select ? new Set(data.select) : null;
    const chosen = found.filter(f => wanted ? wanted.has(f.entry.key) || wanted.has(f.entry.path) : f.entry.selected);
    if (wanted) { const known = new Set(found.flatMap(f => [f.entry.key, f.entry.path])); const missing = [...wanted].filter(k => !known.has(k)); invariant(!missing.length, 'NOT_FOUND', `Not found in ${repoName(link)}: ${missing.slice(0, 5).join(', ')}. Run repos scan to list what it holds.`); }
    const source = this.ensureSource(link, checkout, layout, collection);
    const result: RepoImportResult = { sourceItemId: source.id, collection, imported: [], updated: [], unchanged: [], failed: [] };
    for (const { entry, bundle } of chosen) {
      if (!bundle || entry.error) { result.failed.push({ key: entry.key, error: entry.error ?? 'Unreadable' }); continue; }
      if (entry.status === 'identical') { result.unchanged.push(entry.key); continue; }
      try {
        if (entry.match?.sameSource) {
          const item = this.wb.getItem(entry.match.itemId);
          const updated = this.wb.update({ id: item.id, expect: item.revision, summary: `Updated from ${repoName(link)} at ${checkout.commit.slice(0, 7)}`, value: { ...bundle, collection: item.collection } });
          result.updated.push({ id: updated.id, title: updated.title });
        } else {
          const item = this.wb.createFrom({ id: source.id, revision: this.wb.getItem(source.id).revision, item: bundle, author: 'GitHub import' });
          result.imported.push({ id: item.id, title: item.title });
        }
      } catch (error) { result.failed.push({ key: entry.key, error: error instanceof Error ? error.message : String(error) }); }
    }
    if (result.imported.length || result.updated.length) this.wb.record('imported', `Imported ${result.imported.length} and updated ${result.updated.length} from ${repoName(link)} at ${checkout.commit.slice(0, 7)}`, source.id);
    return result;
  }
}
