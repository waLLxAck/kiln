import { privateAttachment, shareableAuthoring, shareableTrial } from './privacy';
import { MAX_ATTACHMENT_BYTES } from '../protocol/limits';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { analysisSchema, approvalSchema, authoringSchema, hashSchema, idSchema, itemSchema, observationSchema, revisionSchema, statusSchema, targetSchema, trialSchema, type Activity, type Analysis, type Authoring, type Installs, type Item, type ItemDetail, type Observation, type ProviderId, type RepositoryState, type Revision, type Settings, type Snapshot, type Usage } from '../protocol/schema';
import { atomicWrite, bundleFiles, digest, noLinks, now, readJson, readRecords, safeRelative, withLock, writeJson } from '../storage/files';
import { SearchIndex } from '../storage/search';
import { gitStatus, isDedicated } from '../git/service';
import { invariant, WorkbenchError } from './errors';
import { resolveVariables, revisionHash, skillName, validateContent } from './content';
import { readFiles, writeWorkingFiles } from '../storage/bundles';
import { collectionPath, collectionTree, isWithin, parentOf, relocate } from './collections';

/** Cheap identity of an item's working files: the current revision plus size and mtime of content.md and everything under files/. Stats only, no reads. */
function workingFingerprint(dir: string, revision: string) {
  const parts: string[] = [revision];
  const stat = (file: string) => { try { const s = fs.statSync(file); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'missing'; } };
  parts.push(stat(path.join(dir, 'content.md')));
  const walk = (folder: string, prefix: string) => {
    let entries: fs.Dirent[]; try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { parts.push(`${prefix}:missing`); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`); else parts.push(`${prefix}${entry.name}=${stat(full)}`);
    }
  };
  walk(path.join(dir, 'files'), '');
  return parts.join('|');
}
/** Summary a revision carries until a generated description replaces it. */
export const PENDING_SUMMARY = 'Edited';
export class Workbench {
  readonly canonical: string;
  readonly local: string;
  readonly index: SearchIndex;
  private dirty = true;
  private gitCache?: { at: number; value: ReturnType<typeof gitStatus>; dedicated: boolean };
  private watcher?: fs.FSWatcher;
  private indexedItems: Item[] = [];
  private indexedAllItems: Item[] = [];
  private indexedContentHashes = new Map<string, string>();
  /** Per item: size and mtime of its working files at the last reconciliation. Unchanged files mean nothing to re-read. */
  private fingerprints = new Map<string, string>();
  /** Items whose folders the watcher saw change since the last reconciliation; null means every item (first run, or an event without a path). */
  private changedItems: Set<string> | null = null;
  /** Content digest per revision hash, for duplicate detection without re-reading revisions. */
  private contentDigests = new Map<string, string>();
  /** Usage counts from the observations folder; dropped when an observation is written and on a full refresh, which also picks up other processes' writes. */
  private usageCache?: Usage;
  warnings: string[] = [];
  constructor(readonly root: string, localRoot = path.join(os.homedir(), '.kiln')) {
    invariant(path.isAbsolute(root), 'INVALID_PATH', 'Library root must be absolute.');
    noLinks(root); noLinks(localRoot);
    const formatFile = path.join(root, 'kiln.json');
    if (fs.existsSync(formatFile)) z.object({ format: z.literal('kiln-library'), schemaVersion: z.literal(1), library: z.literal('workbench') }).parse(readJson(formatFile));
    this.canonical = path.join(root, 'workbench');
    this.local = path.join(localRoot, digest(path.resolve(root)).slice(0, 24));
    for (const dir of ['items', 'approvals', 'experiments', 'activity', 'analyses']) fs.mkdirSync(path.join(this.canonical, dir), { recursive: true });
    for (const dir of ['runs', 'plans', 'receipts', 'targets', 'observations', 'journals', 'keys']) fs.mkdirSync(path.join(this.local, dir), { recursive: true });
    const marker = path.join(this.canonical, 'workbench.json');
    if (!fs.existsSync(marker)) writeJson(marker, { schemaVersion: 1, application: 'Kiln', assetsLimitBytes: 10_485_760 });
    const ignore = path.join(this.canonical, '.gitignore');
    if (!fs.existsSync(ignore)) atomicWrite(ignore, '.mutation.lock\n.git-index-*\n*.tmp\n.transactions/\n');
    else if (!fs.readFileSync(ignore, 'utf8').includes('.transactions/')) atomicWrite(ignore, fs.readFileSync(ignore, 'utf8') + '\n.transactions/\n');
    const config = readJson(marker) as { schemaVersion: number };
    invariant(config.schemaVersion === 1, 'SCHEMA_UNSUPPORTED', 'This library was created by a newer version of Kiln.');
    this.index = new SearchIndex(path.join(this.local, 'search.sqlite'));
    this.refresh();
    this.cleanPrivateContent();
    this.fileEntriesByKind();
    this.fileSources();
    this.watcher = fs.watch(this.canonical, { recursive: true }, (_event, filename) => {
      const name = filename?.toString().replaceAll('\\', '/') ?? '';
      if (!filename) { this.dirty = true; this.changedItems = null; return; } // Unknown path: reconcile everything next time.
      if (name.startsWith('items/') && !name.endsWith('.tmp')) { this.dirty = true; const id = name.split('/')[1]; if (id) this.changedItems?.add(id); }
    });
  }
  close() { this.watcher?.close(); this.index.close(); }
  /**
   * One-time tidy-up for libraries distilled before entry types became item kinds: an entry derived from a video that still carries
   * its type as a tag (tool, technique, resource, insight) is re-filed under that kind, tag dropped. Skipped when another process
   * holds the library; it simply runs on the next start. Prompts are already the right kind and are left alone.
   */
  private fileEntriesByKind() {
    const types = ['tool', 'technique', 'resource', 'insight'] as const;
    const pending = this.listItems(true).filter(i => i.origin && (i.kind === 'prompt' || i.kind === 'link') && types.some(t => i.tags.includes(t)));
    if (!pending.length) return;
    try {
      this.mutate(() => {
        for (const item of pending) {
          const kind = types.find(t => item.tags.includes(t))!;
          const revision = this.getRevision(item.id);
          const updated = this.saveRevision(item, authoringSchema.parse({ ...revision, collection: item.collection, kind, tags: item.tags.filter(t => !(types as readonly string[]).includes(t)) }), `Filed as ${kind}`);
          this.record('revised', `Filed as ${kind}`, item.id, updated.revision);
        }
      });
    } catch (error) { this.warnings.push(`Entries could not be re-filed by kind yet: ${error instanceof Error ? error.message : error}`); }
  }
  /**
   * One-time tidy-up for libraries analysed before sources existed: material that was distilled into entries becomes a source.
   * Recognised by the revision note every distillation writes, or by a video transcript. Approved items are left as they are,
   * because changing the kind makes a new revision; the rest keep their collection and everything made from them.
   */
  private fileSources() {
    const distilled = / distilled \d+ entries into “/;
    // Each item revision is looked at once per machine: reading a history means parsing every revision with its attachments.
    const checkedFile = path.join(this.local, 'sources-checked.json');
    const checked = new Set<string>(fs.existsSync(checkedFile) ? z.array(z.string()).catch([]).parse(readJson(checkedFile)) : []);
    const candidates = this.listItems(true).filter(i => ['prompt', 'link', 'file', 'image'].includes(i.kind) && !i.origin && (i.description || i.tags.includes('youtube')) && !checked.has(`${i.id}:${i.revision}`));
    if (!candidates.length) return;
    const found = candidates.filter(item => { try { return (item.tags.includes('youtube') && Boolean(this.getRevision(item.id).files['transcript.md'])) || this.revisionHistory(item.id).some(r => distilled.test(r.summary)); } catch { return false; } });
    const approvedOnes = new Set(this.approvals().filter(a => a.trust === 'local').map(a => `${a.itemId}:${a.revision}`));
    // Items that are not sources, and approved ones that stay as they are, need no second look until they change.
    for (const item of candidates) if (!found.includes(item) || approvedOnes.has(`${item.id}:${item.revision}`)) checked.add(`${item.id}:${item.revision}`);
    writeJson(checkedFile, [...checked]);
    if (!found.length) return;
    const approved = new Set(this.approvals().filter(a => a.trust === 'local').map(a => `${a.itemId}:${a.revision}`));
    try {
      this.mutate(() => {
        for (const item of found) {
          if (approved.has(`${item.id}:${item.revision}`)) { this.warnings.push(`“${item.title}” was analysed into entries but stays a ${item.kind} while it is approved. Unapprove it and reopen Kiln to file it as a source.`); continue; }
          const updated = this.saveRevision(item, authoringSchema.parse({ ...this.getRevision(item.id), collection: item.collection, kind: 'source' }), 'Filed as source');
          this.record('revised', 'Filed as source', item.id, updated.revision);
        }
      });
    } catch (error) { this.warnings.push(`Analysed material could not be filed as sources yet: ${error instanceof Error ? error.message : error}`); }
  }
  itemDir(id: string) { return path.join(this.canonical, 'items', idSchema.parse(id)); }
  private itemFile(id: string) { return path.join(this.itemDir(id), 'item.json'); }
  /** Symlink guard for a path under the canonical folder. The folders above it were checked once when the library opened. */
  private guard(file: string) {
    const relative = path.relative(this.canonical, file);
    invariant(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'INVALID_PATH', 'Path escapes the library.');
    let current = this.canonical;
    for (const part of relative.split(path.sep)) { current = path.join(current, part); let stat: fs.Stats; try { stat = fs.lstatSync(current); } catch { return; } invariant(!stat.isSymbolicLink(), 'SYMLINK_REJECTED', `Linked path must be handled by its existing manager: ${current}`); }
  }
  /** item.json parsed once per size and mtime; every snapshot reads every item, so this is the difference between a stat and a read plus parse. */
  private itemCache = new Map<string, { key: string; item: Item }>();
  getItem(id: string): Item {
    const file = this.itemFile(id); this.guard(file);
    let stat: fs.Stats; try { stat = fs.statSync(file); } catch { throw new WorkbenchError('ITEM_NOT_FOUND', 'This item no longer exists.'); }
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = this.itemCache.get(id); if (cached?.key === key) return cached.item;
    const item = itemSchema.parse(readJson(file)); this.itemCache.set(id, { key, item }); return item;
  }
  getRevision(id: string, revision?: string): Revision {
    const item = this.getItem(id); const hash = hashSchema.parse(revision ?? item.revision);
    let file = path.join(this.itemDir(id), 'revisions', `${hash}.json`); this.guard(file);
    if (!fs.existsSync(file)) { file = path.join(this.local, 'private-revisions', id, `${hash}.json`); noLinks(file); }
    invariant(fs.existsSync(file), 'REVISION_NOT_FOUND', 'This revision is not available.');
    const value = revisionSchema.parse(readJson(file)); bundleFiles(value.files);
    invariant(value.itemId === id && value.hash === hash && revisionHash(value) === hash, 'BUNDLE_TAMPERED', 'Revision content does not match its recorded hash. Restore it from history.');
    return value;
  }
  /**
   * The current revision's values with the collection the item is filed in now. Moving an item between collections changes only
   * item.json, so the revision may still name an earlier collection; start edits from this rather than from `getRevision`.
   */
  authoring(id: string): Authoring {
    return { ...this.getRevision(id), collection: this.getItem(id).collection };
  }
  /** Whether authored values still match a revision. The collection is left out: it is organisation, kept on the item, and moving never makes a revision. */
  private matches(next: Authoring, revision: Revision) {
    return revisionHash({ ...next, collection: revision.collection }, revision.hashVersion ?? 1) === revision.hash && next.description === revision.description;
  }
  listItems(includeDeleted = false) {
    return fs.readdirSync(path.join(this.canonical, 'items'), { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
      try { const item = this.getItem(d.name); return includeDeleted || !item.deletedAt ? [item] : []; }
      catch (error) { this.warnings.push(`${d.name}: ${error instanceof Error ? error.message : error}`); return []; }
    }).sort((a, b) => Number(b.favourite) - Number(a.favourite) || a.order - b.order || b.updatedAt.localeCompare(a.updatedAt));
  }
  /** Recorded analyses, newest first; one item's when `itemId` is given. */
  analyses(itemId?: string) { return readRecords(path.join(this.canonical, 'analyses'), value => analysisSchema.parse(value), this.warnings).filter(a => !itemId || a.itemId === itemId).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)); }
  /** Keeps what an analysis produced beside the library. Written once per run; the record never changes afterwards. */
  recordAnalysis(input: Analysis) {
    const analysis = analysisSchema.parse(input); this.getItem(analysis.itemId);
    const file = path.join(this.canonical, 'analyses', `${analysis.id}.json`);
    if (!fs.existsSync(file)) writeJson(file, analysis);
    return analysis;
  }
  /** Items made directly from this one: entries distilled from a source, skills shaped from a prompt, chat additions. Trash excluded. */
  madeFrom(id: string) { return this.listItems().filter(i => i.origin?.itemId === id); }
  approvals(includeRevoked = false) { return readRecords(path.join(this.canonical, 'approvals'), value => approvalSchema.parse(value), this.warnings).filter(a => includeRevoked || !a.revokedAt); }
  trials(includeDeleted = false) { return readRecords(path.join(this.canonical, 'experiments'), value => trialSchema.parse(value), this.warnings).filter(t => includeDeleted || !t.deletedAt); }
  targets() { return readRecords(path.join(this.local, 'targets'), value => targetSchema.parse(value), this.warnings); }
  observations() { return readRecords(path.join(this.local, 'observations'), value => observationSchema.parse(value), this.warnings); }
  /** Every snapshot carries these counts; reading every observation file each time would grow with use, so they are cached. */
  usage(): Usage {
    return this.usageCache ??= this.observations().reduce<Usage>((acc, o) => { if (o.itemId) { const n = acc[o.itemId] ??= { copied: 0, used: 0 }; n.used++; if (o.kind === 'copied') n.copied++; } return acc; }, {});
  }
  activity() { return readRecords(path.join(this.canonical, 'activity'), value => value as Activity, this.warnings).sort((a, b) => b.at.localeCompare(a.at)); }
  record(kind: string, message: string, itemId: string | null = null, revision?: string) {
    const event: Activity = { id: randomUUID(), at: now(), itemId, kind, message, ...(revision ? { revision } : {}) };
    writeJson(path.join(this.canonical, 'activity', `${event.id}.json`), event);
  }
  private mutate<T>(action: () => T, key?: string, itemsChanged = true): T {
    if (itemsChanged) this.dirty = true;
    return withLock(this.canonical, () => {
      const file = key ? path.join(this.local, 'keys', `${digest(key)}.json`) : null;
      this.recoverSaves();
      if (file && fs.existsSync(file)) return readJson(file) as T;
      const result = action(); if (file) writeJson(file, result);
      return result;
    });
  }
  private saveRevision(item: Item, data: Authoring, summary: string) {
    this.dirty = true;
    const original = data;
    data = shareableAuthoring(data);
    if (JSON.stringify(original) !== JSON.stringify(data)) writeJson(path.join(this.local, 'private-sources', item.id, `${revisionHash(original)}.json`), { source: original.source, description: original.description, files: Object.fromEntries(Object.entries(original.files).filter(([name]) => privateAttachment(name))) });
    const revision = revisionHash(data);
    const record: Revision = { schemaVersion: 1, hashVersion: 2, itemId: item.id, hash: revision, parent: item.revision === revision ? null : item.revision, author: os.userInfo().username, createdAt: now(), summary, ...data };
    const { content: _content, files: _files, ...metadata } = data;
    const updated: Item = { ...item, ...metadata, revision, status: item.revision === revision ? item.status : 'captured', updatedAt: now() };
    // The durable intent comes first. Recovery completes exactly this save before reconciling external edits.
    const journal = path.join(this.canonical, '.transactions', `${item.id}.json`);
    writeJson(journal, { item: updated, revision: record });
    this.completeSave(journal, updated, record);
    return updated;
  }
  /** Old snapshots remain available locally; current private attachments become a clean, unapproved draft. */
  private cleanPrivateContent() {
    this.mutate(() => {
      for (const item of this.listItems(true)) {
        try {
          const revision = this.getRevision(item.id), safe = shareableAuthoring(revision);
          if (JSON.stringify(safe) !== JSON.stringify(revision)) this.saveRevision(item, authoringSchema.parse({ ...revision, collection: item.collection }), 'Moved private session data and machine provenance out of shared content');
          for (const old of readRecords(path.join(this.itemDir(item.id), 'revisions'), value => revisionSchema.parse(value))) {
            if (JSON.stringify(shareableAuthoring(old)) === JSON.stringify(old)) continue;
            invariant(revisionHash(old) === old.hash, 'BUNDLE_TAMPERED', 'Cannot archive a modified revision.');
            writeJson(path.join(this.local, 'private-revisions', item.id, `${old.hash}.json`), old);
            fs.unlinkSync(path.join(this.itemDir(item.id), 'revisions', `${old.hash}.json`));
          }
        } catch (error) { this.warnings.push(`${item.title}: ${String(error)}`); }
      }
    });
  }
  private completeSave(journal: string, item: Item, revision: Revision) {
    invariant(item.id === revision.itemId && item.revision === revision.hash && revisionHash(revision) === revision.hash, 'INVALID_TRANSACTION', 'Invalid pending save.');
    validateContent(revision);
    const dir = this.itemDir(item.id), file = path.join(dir, 'revisions', `${revision.hash}.json`);
    if (!fs.existsSync(file)) writeJson(file, revision);
    atomicWrite(path.join(dir, 'content.md'), revision.content);
    const working = path.join(dir, 'files');
    noLinks(working);
    // A journal owns this working projection until item.json is committed. Rebuild it on retry, including file/directory transitions.
    if (fs.existsSync(working)) { readFiles(working); fs.rmSync(working, { recursive: true }); }
    writeWorkingFiles(working, revision.files);
    writeJson(this.itemFile(item.id), item);
    fs.unlinkSync(journal);
    this.itemCache.delete(item.id); this.fingerprints.delete(item.id);
  }
  private recoverSaves() {
    const folder = path.join(this.canonical, '.transactions');
    if (!fs.existsSync(folder)) return;
    noLinks(folder);
    for (const name of fs.readdirSync(folder).filter(name => name.endsWith('.json'))) {
      const file = path.join(folder, name); noLinks(file);
      const pending = z.object({ item: itemSchema, revision: revisionSchema }).parse(readJson(file));
      this.completeSave(file, pending.item, pending.revision);
    }
  }
  private reconcileItem(id: string) {
    const item = this.getItem(id), previous = this.getRevision(id);
    const contentFile = path.join(this.itemDir(id), 'content.md'); this.guard(contentFile);
    invariant(fs.statSync(contentFile).size <= 2_000_000, 'CONTENT_TOO_LARGE', 'External text content exceeds 2 MB. Keep large data in a referenced file.');
    const filesDir = path.join(this.itemDir(id), 'files');
    const next = authoringSchema.parse({ ...item, content: fs.readFileSync(contentFile, 'utf8'), files: fs.existsSync(filesDir) ? readFiles(filesDir) : previous.files });
    if (this.matches(next, previous)) return item;
    validateContent(next); const updated = this.saveRevision(item, next, 'External file edit');
    this.record('external_edit', 'External changes saved as an unapproved revision', id, updated.revision); return updated;
  }
  /** `announce: false` skips the "Captured" activity row for callers that record a more specific event themselves (derived and distilled items). */
  create(input: unknown, key?: string, announce = true): Item {
    const data = authoringSchema.parse(input); validateContent(data);
    return this.mutate(() => {
      // Trimmed but not matched against existing spellings: bulk imports create hundreds of items and must not read the library for each.
      data.collection = data.collection.trim() ? collectionPath(data.collection) : '';
      const timestamp = now();
      const item: Item = { schemaVersion: 1, id: randomUUID(), title: data.title, kind: data.kind, description: data.description, tags: data.tags, collection: data.collection, source: data.source, licence: data.licence, status: 'captured', revision: revisionHash(data), favourite: false, order: Date.now(), createdAt: timestamp, updatedAt: timestamp, deletedAt: null, origin: null };
      const saved = this.saveRevision(item, data, 'Captured into library'); if (announce) this.record('captured', `Captured “${item.title}”`, item.id, item.revision);
      return saved;
    }, key);
  }
  /** An empty summary is allowed: the revision is saved as “Edited” and the caller may describe it afterwards with `describeRevision`. */
  update(input: unknown, key?: string): Item {
    const data = z.object({ id: idSchema, expect: hashSchema, summary: z.string().trim().max(500).default(''), value: authoringSchema }).parse(input);
    validateContent(data.value);
    const summary = data.summary || PENDING_SUMMARY;
    return this.mutate(() => {
      const item = this.reconcileItem(data.id);
      invariant(item.revision === data.expect, 'REVISION_CONFLICT', 'This item changed elsewhere. Reload and compare before saving; your draft is still in the editor.');
      if (data.value.collection !== item.collection) data.value.collection = this.filedName(data.value.collection);
      // Only the collection changed: file the item there and keep its revision, and with it any approval.
      if (this.matches(data.value, this.getRevision(item.id))) return data.value.collection === item.collection ? item : this.fileItems([item], data.value.collection)[0];
      const updated = this.saveRevision(item, data.value, summary);
      this.record('revised', summary, item.id, updated.revision); return updated;
    }, key);
  }
  /** Replaces the placeholder summary of a saved revision, and of its activity row, with a generated description. Summaries are not part of the revision hash. */
  describeRevision(id: string, revision: string, summary: string) {
    const text = summary.replace(/\s+/g, ' ').trim().slice(0, 500); if (!text) return;
    return this.mutate(() => {
      const file = path.join(this.itemDir(id), 'revisions', `${hashSchema.parse(revision)}.json`); this.guard(file);
      if (!fs.existsSync(file)) return;
      const record = revisionSchema.parse(readJson(file)); if (record.summary !== PENDING_SUMMARY) return;
      writeJson(file, { ...record, summary: text });
      for (const event of this.activity()) if (event.itemId === id && event.revision === revision && event.kind === 'revised' && event.message === PENDING_SUMMARY) writeJson(path.join(this.canonical, 'activity', `${event.id}.json`), { ...event, message: text });
    }, undefined, false);
  }
  /** Reconciles working files into revisions and rebuilds the index. A full pass looks at every item; the snapshot path passes false and trusts the folder watcher. */
  refresh(full = true) {
    this.warnings = [];
    if (full) this.usageCache = undefined;
    try {
      this.mutate(() => {
        // Only folders the watcher reported (or everything, the first time) are looked at; a snapshot after a small change must not walk the whole library.
        const changed = full ? null : this.changedItems; this.changedItems = new Set();
        const candidates = this.listItems(true).filter(item => !changed || changed.has(item.id));
        for (const item of candidates) {
          try {
            // Reconciling means reading and hashing every bundled file; skip items whose working files have not changed on disk since last time.
            const fingerprint = workingFingerprint(this.itemDir(item.id), item.revision);
            if (this.fingerprints.get(item.id) === fingerprint) continue;
            this.fingerprints.set(item.id, fingerprint);
            const previous = this.getRevision(item.id);
            const file = path.join(this.itemDir(item.id), 'content.md'); this.guard(file);
            const content = fs.readFileSync(file, 'utf8');
            const working = path.join(this.itemDir(item.id), 'files');
            if (!fs.existsSync(working)) writeWorkingFiles(working, previous.files);
            const next = authoringSchema.parse({ ...item, content, files: readFiles(working) });
            if (!this.matches(next, previous)) {
              validateContent(next); const updated = this.saveRevision(item, next, 'External file edit');
              this.record('external_edit', 'External changes saved as an unapproved revision', item.id, updated.revision);
            }
          } catch (error) { this.warnings.push(`${item.title}: ${error instanceof Error ? error.message : error}`); }
        }
      });
    } catch (error) { this.warnings.push(error instanceof Error ? error.message : String(error)); }
    this.indexedAllItems = this.listItems(true);
    this.indexedItems = this.indexedAllItems.filter(item => !item.deletedAt);
    this.indexedContentHashes.clear();
    // Revisions are immutable, so a content digest computed once per revision hash stays valid; the index loads only revisions it has not seen.
    this.index.rebuild(this.indexedItems.map(item => {
      let loaded: Revision | undefined; const load = () => loaded ??= this.getRevision(item.id);
      let contentDigest = this.contentDigests.get(item.revision);
      if (!contentDigest) { try { contentDigest = digest(load().content); this.contentDigests.set(item.revision, contentDigest); } catch { contentDigest = ''; } }
      this.indexedContentHashes.set(item.id, contentDigest);
      return { item, load };
    }));
    this.dirty = false;
  }
  search(query: string, includeArchived = false) {
    if (this.dirty) this.refresh();
    const ids = query.trim() ? new Set(this.index.search(query)) : null;
    return this.indexedItems.filter(item => (!ids || ids.has(item.id)) && (includeArchived || !['archived', 'rejected'].includes(item.status)));
  }
  private revisionHistory(id: string) {
    return [...readRecords(path.join(this.itemDir(id), 'revisions'), value => revisionSchema.parse(value), this.warnings),
      ...readRecords(path.join(this.local, 'private-revisions', id), value => revisionSchema.parse(value), this.warnings)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /**
   * Where items came from on this machine. The shared source of an imported item is only its folder name (see privacy.ts), so
   * two skills with one name read the same; the full source kept privately at import tells them apart. Items without one are left out.
   */
  origins(input: unknown): Record<string, string> {
    const { ids } = z.object({ ids: z.array(idSchema).max(5000) }).parse(input);
    const result: Record<string, string> = {};
    for (const id of new Set(ids)) {
      const folder = path.join(this.local, 'private-sources', id);
      let newest: { at: number; source: string } | null = null;
      try {
        for (const name of fs.readdirSync(folder)) {
          const file = path.join(folder, name), at = fs.statSync(file).mtimeMs, source = (readJson(file) as { source?: unknown }).source;
          if (typeof source === 'string' && source && (!newest || at > newest.at)) newest = { at, source };
        }
      } catch { /* Nothing private recorded for this item on this machine. */ }
      if (newest) result[id] = newest.source;
    }
    return result;
  }
  detail(id: string): ItemDetail {
    const item = this.getItem(id), revision = this.getRevision(id);
    const contentHash = digest(revision.content);
    const duplicates = this.dirty ? this.listItems().filter(other => other.id !== id && this.getRevision(other.id).content === revision.content) : this.indexedItems.filter(other => other.id !== id && this.indexedContentHashes.get(other.id) === contentHash);
    return { analyses: this.analyses(id), item, revision, revisions: this.revisionHistory(id), approvals: this.approvals().filter(a => a.itemId === id), trials: this.trials().filter(t => t.itemId === id), observations: this.observations().filter(o => o.itemId === id), validation: validateContent(revision), duplicates };
  }
  setMeta(input: unknown) {
    this.dirty = true;
    const data = z.object({ id: idSchema, expect: hashSchema, favourite: z.boolean().optional(), order: z.number().optional(), status: statusSchema.optional(), deleted: z.boolean().optional() }).parse(input);
    return this.mutate(() => {
      const item = this.reconcileItem(data.id); invariant(item.revision === data.expect, 'REVISION_CONFLICT', 'Reload this item before changing it.');
      // "approved" is only a status while a live approval names the current revision; that keeps undoing an archive honest without letting metadata edits grant approval.
      invariant(data.status !== 'approved' || this.approvals().some(a => a.itemId === item.id && a.revision === item.revision), 'APPROVAL_REQUIRED', 'Use Approve on the item; approval always names an exact revision.');
      const next = { ...item, ...(data.favourite === undefined ? {} : { favourite: data.favourite }), ...(data.order === undefined ? {} : { order: data.order }), ...(data.status ? { status: data.status } : {}), ...(data.deleted === undefined ? {} : { deletedAt: data.deleted ? now() : null }), updatedAt: now() };
      writeJson(this.itemFile(item.id), next); this.record(data.deleted ? 'deleted' : 'organised', data.deleted ? 'Moved to trash; recoverable' : 'Updated library organisation', item.id, item.revision); return next;
    });
  }
  /** Permanently removes an item that is already in the trash, together with its approvals and experiments. Installed copies are untouched. */
  purge(input: unknown) {
    this.dirty = true;
    const data = z.object({ id: idSchema, confirm: z.literal(true) }).parse(input);
    return this.mutate(() => {
      const item = this.getItem(data.id);
      invariant(item.deletedAt, 'NOT_IN_TRASH', 'Move this item to the trash before deleting it permanently.');
      for (const approval of this.approvals(true).filter(a => a.itemId === item.id)) fs.rmSync(path.join(this.canonical, 'approvals', `${approval.id}.json`), { force: true });
      for (const analysis of this.analyses(item.id)) fs.rmSync(path.join(this.canonical, 'analyses', `${analysis.id}.json`), { force: true });
      for (const trial of this.trials(true).filter(t => t.itemId === item.id)) { fs.rmSync(path.join(this.canonical, 'experiments', `${trial.id}.json`), { force: true }); fs.rmSync(path.join(this.local, 'runs', trial.id), { recursive: true, force: true }); }
      const installs = this.installs(); if (installs[item.id]) { delete installs[item.id]; writeJson(this.installsFile(), installs); }
      fs.rmSync(this.itemDir(item.id), { recursive: true, force: true });
      for (const folder of ['private-revisions', 'private-sources']) fs.rmSync(path.join(this.local, folder, item.id), { recursive: true, force: true });
      this.record('purged', `Deleted “${item.title}” permanently`, null);
      return { id: item.id, title: item.title };
    });
  }
  restore(input: unknown) {
    const data = z.object({ id: idSchema, expect: hashSchema, revision: hashSchema }).parse(input);
    // Restoring brings back the content, not the folder the item was in back then.
    const revision = { ...this.getRevision(data.id, data.revision), collection: this.getItem(data.id).collection };
    return this.update({ id: data.id, expect: data.expect, summary: `Restored revision ${data.revision.slice(0, 8)}`, value: revision });
  }
  approve(input: unknown) {
    this.dirty = true;
    const data = z.object({ id: idSchema, revision: hashSchema, reviewer: z.string().trim().min(1), scope: z.string().trim().min(1), note: z.string().default(''), evidence: z.array(idSchema).default([]), waivedChecks: z.string().default('') }).parse(input);
    return this.mutate(() => {
      const item = this.reconcileItem(data.id); invariant(!item.deletedAt && item.revision === data.revision, 'REVISION_CONFLICT', 'Only the current, non-deleted revision can be approved.');
      const revision = this.getRevision(data.id, data.revision), errors = validateContent(revision);
      invariant(errors.length === 0, 'VALIDATION_FAILED', errors.join('\n'));
      const evidence = this.trials().filter(t => data.evidence.includes(t.id));
      invariant(evidence.length === data.evidence.length && evidence.every(t => t.itemId === item.id && t.revision === data.revision && t.status === 'completed'), 'INVALID_EVIDENCE', 'Evidence must be completed trials of this exact revision.');
      invariant(data.note.trim() || evidence.length, 'APPROVAL_REASON_REQUIRED', 'Add evidence or an explicit approval reason.');
      const hasTypical = evidence.some(t => t.case === 'typical' && t.judgement === 'pass');
      const hasBoundary = evidence.some(t => t.case === 'boundary' && t.judgement === 'pass');
      invariant((hasTypical && hasBoundary) || data.waivedChecks.trim(), 'CHECKS_REQUIRED', 'Link passing typical and boundary trials, or explicitly explain why these checks are waived.');
      const approval = approvalSchema.parse({ ...data, schemaVersion: 1, id: randomUUID(), itemId: item.id, createdAt: now() });
      writeJson(path.join(this.canonical, 'approvals', `${approval.id}.json`), approval);
      writeJson(this.itemFile(item.id), { ...item, status: 'approved', updatedAt: now() });
      this.record('approved', `Approved by ${data.reviewer}: ${data.scope}`, item.id, item.revision); return approval;
    });
  }
  unapprove(input: unknown) {
    const data = z.object({ id: idSchema, revision: hashSchema }).parse(input);
    return this.mutate(() => {
      const item = this.reconcileItem(data.id);
      invariant(!item.deletedAt && item.revision === data.revision, 'REVISION_CONFLICT', 'Reload this item before changing its approval.');
      const revokedAt = now();
      for (const approval of this.approvals().filter(a => a.itemId === item.id && a.revision === data.revision)) {
        writeJson(path.join(this.canonical, 'approvals', `${approval.id}.json`), { ...approval, revokedAt });
      }
      const next = { ...item, status: 'captured' as const, updatedAt: revokedAt };
      writeJson(this.itemFile(item.id), next);
      this.record('unapproved', 'Approval removed for this revision', item.id, item.revision);
      return next;
    });
  }
  derive(input: unknown) {
    const data = z.object({ id: idSchema, revision: hashSchema, name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), description: z.string().trim().min(1).max(1024), trigger: z.string().trim().min(1), inputs: z.string().trim().min(1), procedure: z.string().trim().min(1), checks: z.string().trim().min(1), limitations: z.string().trim().min(1) }).parse(input);
    const content = `---\nname: ${data.name}\ndescription: ${JSON.stringify(data.description)}\n---\n\n# ${data.name}\n\n## When to use\n${data.trigger}\n\n## Inputs\n${data.inputs}\n\n## Procedure\n${data.procedure}\n\n## Checks\n${data.checks}\n\n## Limitations\n${data.limitations}\n`;
    return this.deriveSkill({ id: data.id, revision: data.revision, content, author: 'form' });
  }
  /** Creates a new skill item from complete SKILL.md text, linked to the source revision it was shaped from. */
  deriveSkill(input: unknown) {
    const data = z.object({ id: idSchema, revision: hashSchema, content: z.string().min(1).max(2_000_000), files: z.record(z.string(), z.string()).default({}), author: z.string().default('agent') }).parse(input);
    const source = this.getRevision(data.id, data.revision);
    const name = skillName({ content: data.content } as Revision) || source.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'new-skill';
    const item = this.create({ ...source, kind: 'skill', title: name, content: data.content, files: data.files, source: `kiln:${source.itemId}@${source.hash}` }, undefined, false);
    return this.mutate(() => {
      const updated = { ...item, origin: { itemId: source.itemId, revision: source.hash } };
      writeJson(this.itemFile(item.id), updated); this.record('derived', `Created draft skill from “${source.title}” (${data.author})`, item.id, item.revision); return updated;
    });
  }
  /** Creates any item from authoring fields and links it to the source revision it was distilled from. */
  createFrom(input: unknown) {
    const data = z.object({ id: idSchema, revision: hashSchema, item: authoringSchema, author: z.string().default('agent') }).parse(input);
    const source = this.getRevision(data.id, data.revision);
    const item = this.create(data.item, undefined, false);
    return this.mutate(() => {
      const updated = { ...item, origin: { itemId: source.itemId, revision: source.hash } };
      writeJson(this.itemFile(item.id), updated); this.record('derived', `Created “${item.title}” from “${source.title}” (${data.author})`, item.id, item.revision); return updated;
    });
  }
  prepareTrial(input: unknown) {
    const data = z.object({ id: idSchema, revision: hashSchema, provider: z.enum(['codex', 'claude', 'manual']), mode: z.enum(['manual','codex']).default('manual'), variables: z.record(z.string(), z.string()).default({}), task: z.string().trim().min(1), rubric: z.array(z.string().trim().min(1)).min(1), case: z.enum(['typical', 'boundary']), workspace: z.string().default(''), retainInput: z.boolean().default(false), agentVersion: z.string().default('unknown'), model: z.string().default('reported by official client') }).parse(input);
    return this.mutate(() => {
      const revision = this.getRevision(data.id, data.revision);
      const resolved = resolveVariables(revision.content, data.variables);
      const trial = trialSchema.parse({ schemaVersion: 1, id: randomUUID(), itemId: data.id, revision: data.revision, provider: data.provider, mode: data.mode, variables: data.retainInput ? data.variables : {}, task: data.retainInput ? data.task : 'Private input retained in local run folder', rubric: data.rubric, case: data.case, workspace: 'Local run folder (machine-private)', machine: 'local', permissionProfile: 'Official client defaults; user controls approvals', agentVersion: data.agentVersion, model: data.model, status: 'prepared', judgement: null, note: '', outputReference: '', createdAt: now(), completedAt: null });
      const folder = path.join(this.local, 'runs', trial.id); fs.mkdirSync(folder);
      const handoff = `${resolved}\n\n## Representative task\n${data.task}\n\n## Evaluation rubric\n${data.rubric.map(r => `- ${r}`).join('\n')}\n`;
      atomicWrite(path.join(folder, 'prompt.md'), handoff);
      writeJson(path.join(folder, 'environment.json'), { variables: data.variables, task: data.task, requestedWorkspace: data.workspace, revision: data.revision, provider: data.provider, authentication: 'Use the official client login', permissionProfile: trial.permissionProfile });
      writeJson(path.join(this.canonical, 'experiments', `${trial.id}.json`), trial);
      const item = this.getItem(data.id); if (item.revision === data.revision && item.status === 'captured') { this.dirty = true; writeJson(this.itemFile(item.id), { ...item, status: 'testing' }); }
      this.record('trial_prepared', data.mode === 'codex' ? 'Started a Codex CLI experiment' : 'Prepared manual agent handoff; execution not yet observed', item.id, data.revision);
      this.observeUnlocked({ schemaVersion: 1, eventId: `${trial.id}-prepared`, itemId: item.id, revision: data.revision, kind: 'test_prepared', source: 'kiln', confidence: 'observed', sessionId: trial.id, occurredAt: now() });
      return { trial, folder, prompt: handoff };
    });
  }
  deleteTrial(input: unknown) {
    const { id } = z.object({ id: idSchema }).parse(input);
    return this.mutate(() => {
      const trial = this.trials(true).find(t => t.id === id);
      invariant(trial, 'TRIAL_NOT_FOUND', 'Trial not found.');
      if (trial.deletedAt) return trial;
      const deleted = { ...trial, deletedAt: now() };
      writeJson(path.join(this.canonical, 'experiments', `${id}.json`), deleted);
      this.record('trial_deleted', 'Experiment deleted from the trial lists; historical evidence retained', trial.itemId, trial.revision);
      return deleted;
    });
  }
  finishTrial(input: unknown) {
    const data = z.object({ id: idSchema, judgement: z.enum(['pass', 'fail', 'uncertain']), note: z.string().trim().min(1), output: z.string().max(2_000_000).default(''), outputReference: z.string().max(2000).default(''), cancel: z.boolean().default(false) }).parse(input);
    return this.mutate(() => {
      const trial = this.trials().find(t => t.id === data.id); invariant(trial, 'TRIAL_NOT_FOUND', 'Trial not found.');
      invariant(trial.status === 'prepared', 'TRIAL_CLOSED', 'A completed trial is immutable. Prepare another trial to run again.');
      invariant(data.cancel || data.output.trim() || data.outputReference.trim(), 'OUTPUT_REQUIRED', 'Attach output or a transcript reference.');
      if (data.output) atomicWrite(path.join(this.local, 'runs', trial.id, 'output.md'), data.output);
      if (data.outputReference) writeJson(path.join(this.local, 'runs', trial.id, 'output-reference.json'), { reference: data.outputReference });
      const updated = { ...trial, judgement: data.cancel ? null : data.judgement, note: data.note, status: data.cancel ? 'cancelled' as const : 'completed' as const, outputReference: data.output || data.outputReference ? `local-run:${trial.id}` : '', completedAt: now() };
      writeJson(path.join(this.canonical, 'experiments', `${trial.id}.json`), updated);
      this.record(data.cancel ? 'trial_cancelled' : 'trial_completed', data.cancel ? 'Handoff cancelled; any independently running agent must be stopped in its own window' : `${trial.mode === 'codex' ? 'Codex assessment' : 'Human judgement'}: ${data.judgement}`, trial.itemId, trial.revision);
      if (!data.cancel) this.observeUnlocked({ schemaVersion: 1, eventId: `${trial.id}-completed`, itemId: trial.itemId, revision: trial.revision, kind: 'test_completed', source: 'kiln', confidence: 'observed', sessionId: trial.id, occurredAt: now() });
      return updated;
    });
  }
  observe(input: unknown) { return this.mutate(() => this.observeUnlocked(observationSchema.parse(input)), undefined, false); }
  private observeUnlocked(event: Observation) {
    const file = path.join(this.local, 'observations', `${digest({ source: event.source, id: event.eventId })}.json`);
    if (fs.existsSync(file)) return { duplicate: true };
    writeJson(file, event); this.usageCache = undefined; return { duplicate: false };
  }
  enroll(input: unknown) {
    const data = targetSchema.omit({ id: true, machine: true }).parse(input);
    invariant(!data.skillFolder || data.provider === 'codex', 'INVALID_TARGET', 'The Codex-specific folder belongs to a Codex environment.');
    invariant(path.isAbsolute(data.root) && fs.statSync(data.root).isDirectory(), 'INVALID_PATH', 'Choose an existing absolute target folder.'); noLinks(data.root);
    invariant(!path.resolve(data.root).startsWith(path.resolve(this.canonical)), 'INVALID_TARGET', 'The canonical library cannot also be a deployment target.');
    return this.mutate(() => {
      const existing = this.targets().find(t => path.resolve(t.root).toLowerCase() === path.resolve(data.root).toLowerCase() && t.provider === data.provider && t.scope === data.scope && t.skillFolder === data.skillFolder);
      if (existing) return existing;
      const target = targetSchema.parse({ ...data, id: randomUUID(), machine: 'local' }); writeJson(path.join(this.local, 'targets', `${target.id}.json`), target); return target;
    });
  }
  /** Forgets an enrolled environment. Files already installed there stay as they are; their receipts become historical. */
  removeTarget(input: unknown) {
    const data = z.object({ id: idSchema, confirm: z.literal(true) }).parse(input);
    return this.mutate(() => {
      const target = this.targets().find(t => t.id === data.id); invariant(target, 'TARGET_NOT_ENROLLED', 'This environment is not enrolled.');
      fs.rmSync(path.join(this.local, 'targets', `${target.id}.json`), { force: true });
      this.record('target_removed', `Stopped managing ${target.name}; installed files were left in place`);
      return target;
    }, undefined, false);
  }
  private installsFile() { return path.join(this.canonical, 'installs.json'); }
  /** Desired personal installs by item, shared through the repository. */
  installs(): Installs {
    const file = this.installsFile();
    if (!fs.existsSync(file)) return {};
    try { return z.record(idSchema, z.array(z.enum(['codex', 'claude', 'copilot', 'codex-native']))).parse(readJson(file)); } catch (error) { this.warnings.push(`installs.json: ${error instanceof Error ? error.message : error}`); return {}; }
  }
  setInstall(itemId: string, provider: ProviderId | 'codex-native', desired: boolean) {
    const installs = this.installs(); const current = new Set(installs[itemId] ?? []);
    if (desired) current.add(provider); else current.delete(provider);
    if (current.size) installs[itemId] = [...current].sort(); else delete installs[itemId];
    writeJson(this.installsFile(), installs); return installs;
  }
  settings(): Settings {
    const file = path.join(this.local, 'settings.json');
    return z.object({ shortcut: z.string().min(1).default('CommandOrControl+Shift+Space'), launchAtLogin: z.boolean().default(false), theme: z.enum(['light', 'dark', 'system']).default('light'), agentProvider: z.enum(['codex', 'claude']).default('codex'), codexModel: z.string().max(80).default(''), codexEffort: z.string().max(20).default(''), commitModel: z.string().max(80).default('gpt-5.6-luna'), commitEffort: z.string().max(20).default('medium'), updateSource: z.string().max(1000).default('') }).parse(fs.existsSync(file) ? readJson(file) : {});
  }
  /** Every collection in sidebar order, subfolders after their parent. Custom names come from workbench.json; the rest from the items filed in them. */
  collections(items = this.listItems()) {
    const config = readJson(path.join(this.canonical, 'workbench.json')) as { collections?: string[] };
    return collectionTree([...(config.collections ?? []), ...items.map(i => i.collection)]);
  }
  private saveCollectionNames(names: string[]) {
    const file = path.join(this.canonical, 'workbench.json'), config = readJson(file) as Record<string, unknown>;
    const lower = new Set<string>(), unique = collectionTree(names).filter(name => !lower.has(name.toLowerCase()) && lower.add(name.toLowerCase()));
    writeJson(file, { ...config, collections: unique }); return unique;
  }
  /** An existing collection spelled the same apart from case wins, level by level, so "game design/puzzles" joins "Game Design". */
  private existingSpelling(name: string, names = this.collections(this.listItems(true))) {
    const known = new Map(names.map(n => [n.toLowerCase(), n]));
    let result = '';
    for (const part of name ? name.split('/') : []) { const next = result ? `${result}/${part}` : part; result = known.get(next.toLowerCase()) ?? next; }
    return result;
  }
  /** A typed collection as it is stored: levels trimmed, an existing spelling reused, '' for unfiled. */
  private filedName(collection: string) { return collection.trim() ? this.existingSpelling(collectionPath(collection)) : ''; }
  /** Files items under `collection` ('' leaves them unfiled). Only item.json changes: revisions, approvals and installs are untouched. */
  private fileItems(items: Item[], collection: string, note = (from: string) => from ? `Moved from “${from}” to ${collection ? `“${collection}”` : 'no collection'}` : `Filed in “${collection}”`) {
    return items.map(item => {
      if (item.collection === collection) return item;
      const next = { ...item, collection, updatedAt: now() };
      writeJson(this.itemFile(item.id), next); this.itemCache.delete(item.id);
      this.record('organised', note(item.collection), item.id, item.revision); return next;
    });
  }
  /** Adds an empty collection, or a subfolder when the name contains "/". Its parents appear with it. */
  createCollection(input: unknown) {
    const name = collectionPath(z.object({ name: z.string() }).parse(input).name);
    return this.mutate(() => {
      const names = this.collections();
      invariant(!names.some(n => n.toLowerCase() === name.toLowerCase()), 'DUPLICATE_COLLECTION', `A collection called “${name}” already exists.`);
      const spelled = this.existingSpelling(name, names);
      this.saveCollectionNames([...names, spelled]); this.record('collection_created', `Created the “${spelled}” collection`);
      return { name: spelled, collections: this.collections() };
    });
  }
  /**
   * Moves items into a collection, or out of every collection with an empty name. Organising never makes a revision, so approved
   * items stay approved and installed copies keep matching.
   */
  moveItems(input: unknown) {
    const value = z.object({ ids: z.array(idSchema).min(1).max(10_000), collection: z.string() }).parse(input);
    invariant(new Set(value.ids).size === value.ids.length, 'INVALID_INPUT', 'List each item once.');
    if (value.collection.trim()) collectionPath(value.collection);
    return this.mutate(() => {
      const collection = this.filedName(value.collection);
      const items = value.ids.map(id => this.reconcileItem(id));
      const moved = this.fileItems(items, collection).filter((item, index) => item !== items[index]);
      return { collection, moved: moved.map(i => i.id) };
    });
  }
  /**
   * Renames a collection everywhere: the sidebar list, its subfolders, and every item in them, trashed ones included. A path moves
   * it: "Puzzles" → "Game Design/Puzzles" makes it a subfolder. Items keep their revisions and approvals.
   */
  renameCollection(input: unknown) {
    const raw = z.object({ from: z.string(), to: z.string() }).parse(input);
    const value = { from: collectionPath(raw.from), to: collectionPath(raw.to) };
    invariant(value.from !== value.to, 'SAME_NAME', 'Choose a different name.');
    return this.mutate(() => {
      const all = this.collections(this.listItems(true));
      invariant(all.includes(value.from), 'COLLECTION_NOT_FOUND', `There is no collection called “${value.from}”.`);
      const remaining = all.filter(name => !isWithin(name, value.from));
      invariant(!remaining.some(name => name.toLowerCase() === value.to.toLowerCase()), 'DUPLICATE_COLLECTION', `A collection called “${value.to}” already exists.`);
      const to = this.existingSpelling(value.to, remaining);
      const moved: string[] = [];
      for (const item of this.listItems(true).filter(i => isWithin(i.collection, value.from))) {
        const destination = relocate(item.collection, value.from, to);
        this.fileItems([this.reconcileItem(item.id)], destination, from => `Moved from “${from}” to “${destination}”`); moved.push(item.id);
      }
      this.saveCollectionNames(this.collections().map(name => relocate(name, value.from, to)));
      this.record('collection_renamed', `Renamed the “${value.from}” collection to “${to}”${moved.length ? ` (${moved.length} item${moved.length === 1 ? '' : 's'})` : ''}`);
      return { from: value.from, to, moved };
    });
  }
  /** Replaces the custom collection list, which sets the sidebar order. Collections that still hold items stay listed regardless. */
  saveCollections(input: unknown) {
    const value = z.object({ names: z.array(z.string()).max(500) }).parse(input);
    const names = value.names.map(collectionPath);
    invariant(new Set(names.map(n => n.toLowerCase())).size === names.length, 'DUPLICATE_COLLECTION', 'Collection names must be unique.');
    return this.mutate(() => this.saveCollectionNames(names));
  }
  /**
   * Removes a collection and its subfolders from the sidebar. `items: 'keep'` moves everything up one level, subfolders included:
   * items directly in a top-level collection become unfiled, and no revision or approval changes. `items: 'trash'` moves the
   * items to the trash instead; they keep the name, so restoring one brings the collection back.
   */
  deleteCollection(input: unknown) {
    const raw = z.object({ name: z.string(), confirm: z.literal(true), items: z.enum(['keep', 'trash']) }).parse(input);
    const name = collectionPath(raw.name), parent = parentOf(name);
    return this.mutate(() => {
      const all = this.collections(this.listItems(true));
      invariant(all.includes(name), 'COLLECTION_NOT_FOUND', `There is no collection called “${name}”.`);
      const remaining = all.filter(n => !isWithin(n, name)), within = (i: Item) => isWithin(i.collection, name);
      const trashed: string[] = [], moved: string[] = [];
      if (raw.items === 'trash') {
        for (const item of this.listItems().filter(within).map(i => this.reconcileItem(i.id))) {
          writeJson(this.itemFile(item.id), { ...item, deletedAt: now(), updatedAt: now() }); this.itemCache.delete(item.id);
          this.record('deleted', `Moved to trash with the “${name}” collection; recoverable`, item.id, item.revision); trashed.push(item.id);
        }
      } else {
        // Trashed items move too, or restoring one would bring the deleted collection back.
        for (const item of this.listItems(true).filter(within)) {
          const destination = this.existingSpelling(relocate(item.collection, name, parent), remaining);
          this.fileItems([this.reconcileItem(item.id)], destination, from => `Moved from “${from}” to ${destination ? `“${destination}”` : 'no collection'} when “${name}” was deleted`); moved.push(item.id);
        }
      }
      const names = this.collections().filter(n => raw.items === 'keep' || !isWithin(n, name)).map(n => this.existingSpelling(relocate(n, name, parent), remaining));
      this.saveCollectionNames(names);
      const count = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
      this.record('collection_deleted', trashed.length ? `Deleted the “${name}” collection; ${count(trashed.length)} moved to the trash` : moved.length ? `Deleted the “${name}” collection; ${count(moved.length)} moved to ${parent ? `“${parent}”` : 'no collection'}` : `Deleted the empty “${name}” collection`);
      return { name, items: raw.items, to: parent, trashed, moved };
    });
  }
  reorderItems(input: unknown) {
    this.dirty = true;
    const value = z.object({ ids: z.array(idSchema).max(10_000) }).parse(input);
    invariant(new Set(value.ids).size === value.ids.length, 'INVALID_ORDER', 'List each item once.');
    return this.mutate(() => {
      const items = value.ids.map(id => this.getItem(id));
      items.forEach((item, order) => writeJson(this.itemFile(item.id), { ...item, order })); return { reordered: items.length };
    });
  }
  saveSettings(input: unknown) {
    const value = z.object({ shortcut: z.string().min(1).max(100), launchAtLogin: z.boolean(), theme: z.enum(['light', 'dark', 'system']), agentProvider: z.enum(['codex', 'claude']).default('codex'), codexModel: z.string().max(80).default(''), codexEffort: z.string().max(20).default(''), commitModel: z.string().max(80).default('gpt-5.6-luna'), commitEffort: z.string().max(20).default('medium'), updateSource: z.string().max(1000).default('') }).parse(input);
    writeJson(path.join(this.local, 'settings.json'), value); return value;
  }
  invalidateGit() { this.gitCache = undefined; }
  /** A library can publish approvals only when it has the standard layout, is a Git repository, and has a GitHub remote. */
  repositoryState(): RepositoryState {
    const git = this.cachedGitStatus();
    const standard = fs.existsSync(path.join(this.root, 'kiln.json'));
    const dedicated = standard && Boolean(this.gitCache?.dedicated);
    return { standard, dedicated, git: git.attached, remote: Boolean(git.remote), ready: dedicated && git.attached && Boolean(git.remote) };
  }
  private cachedGitStatus() {
    if (!this.gitCache || Date.now() - this.gitCache.at > 10000) this.gitCache = { at: Date.now(), value: gitStatus(this.root), dedicated: isDedicated(this.root) };
    return this.gitCache.value;
  }
  snapshot(): Snapshot {
    if (this.dirty) this.refresh(false);
    const git = this.cachedGitStatus();
    return { schemaVersion: 1, root: this.root, items: this.indexedAllItems, trials: this.trials(), approvals: this.approvals(), targets: this.targets(), receipts: readRecords(path.join(this.local, 'receipts'), v => v as Snapshot['receipts'][number]), activity: this.activity().slice(0, 300), warnings: [...new Set(this.warnings)], collections: this.collections(this.indexedItems), git, repository: this.repositoryState(), publish: [], settings: this.settings(), installs: this.installs(), coverage: 'App actions and human-recorded trials. External agent sessions: unknown coverage.', usage: this.usage() };
  }
  exportLibrary(destination: string) {
    invariant(path.isAbsolute(destination), 'INVALID_PATH', 'Export path must be absolute.'); noLinks(destination);
    invariant(!fs.existsSync(destination), 'FILE_EXISTS', 'Choose a new export filename.');
    return this.mutate(() => {
      // Revisions are read straight from disk: `detail()` also hunts for duplicates across the whole library, which made exporting a few hundred items quadratic.
      const mapped = new Map<string, string>();
      const items = this.listItems(true).map(item => {
        const revisions = this.revisionHistory(item.id).map(revision => {
          invariant(revisionHash(revision) === revision.hash, 'BUNDLE_TAMPERED', 'Cannot export a modified revision.');
          const safe = shareableAuthoring(revision);
          const changed = JSON.stringify(safe) !== JSON.stringify(revision);
          const hash = changed ? revisionHash(authoringSchema.parse(safe)) : revision.hash;
          mapped.set(`${item.id}:${revision.hash}`, hash);
          return { ...safe, hash, ...(changed ? { hashVersion: 2 as const } : {}) };
        });
        return { item: { ...item }, revisions };
      });
      for (const entry of items) {
        for (const revision of entry.revisions) {
          const parent = revision.parent ? mapped.get(`${entry.item.id}:${revision.parent}`) ?? null : null;
          revision.parent = parent === revision.hash ? null : parent;
        }
        const unique = new Map<string, Revision>();
        for (const revision of entry.revisions) if (!unique.has(revision.hash)) unique.set(revision.hash, revision);
        entry.revisions = [...unique.values()];
        entry.item.revision = mapped.get(`${entry.item.id}:${entry.item.revision}`)!;
        entry.item.source = entry.revisions.find(r => r.hash === entry.item.revision)!.source;
        if (entry.item.origin) entry.item.origin = { ...entry.item.origin, revision: mapped.get(`${entry.item.origin.itemId}:${entry.item.origin.revision}`) ?? entry.item.origin.revision };
      }
      const approvals = this.approvals(true).filter(a => mapped.get(`${a.itemId}:${a.revision}`) === a.revision);
      const trials = this.trials(true).map(t => ({ ...shareableTrial(t), revision: mapped.get(`${t.itemId}:${t.revision}`) ?? t.revision }));
      const analyses = this.analyses().map(a => ({ ...a, revision: mapped.get(`${a.itemId}:${a.revision}`) ?? a.revision }));
      const exported = { schemaVersion: 1, exportedAt: now(), items, collections: this.collections(), approvals, trials, analyses, activity: this.activity().map(event => ({ ...event, message: event.kind.replaceAll('_', ' '), ...(event.revision && event.itemId ? { revision: mapped.get(`${event.itemId}:${event.revision}`) ?? event.revision } : {}) })), excluded: ['Machine paths and deployment ownership', 'Private inputs and session transcripts', 'Private activity details and observation logs', 'Approvals for privacy-transformed revisions'] };
      writeJson(destination, exported); return { destination, items: items.length, excluded: exported.excluded };
    });
  }
  importLibrary(file: string) {
    this.dirty = true;
    noLinks(file); invariant(fs.statSync(file).size < 150_000_000, 'IMPORT_TOO_LARGE', 'Export exceeds 150 MB.');
    const data = z.object({ schemaVersion: z.literal(1), items: z.array(z.object({ item: itemSchema, revisions: z.array(revisionSchema) })), collections: z.array(z.string().min(1).max(100)).default([]), approvals: z.array(approvalSchema), trials: z.array(trialSchema), analyses: z.array(analysisSchema).default([]), activity: z.array(z.unknown()).default([]) }).parse(readJson(file));
    for (const { item, revisions } of data.items) {
      invariant(revisions.some(r => r.hash === item.revision), 'INVALID_EXPORT', 'Current revision is missing.');
      for (const r of revisions) { validateContent(r); invariant(r.itemId === item.id && r.hash === revisionHash(r), 'BUNDLE_TAMPERED', 'Export contains a modified revision.'); }
    }
    const result = this.mutate(() => {
      let imported = 0; const conflicts: string[] = [];
      for (const { item, revisions } of data.items) {
        const exists = fs.existsSync(this.itemFile(item.id));
        for (const revision of revisions) {
          const destination = path.join(this.itemDir(item.id), 'revisions', `${revision.hash}.json`);
          if (!fs.existsSync(destination)) writeJson(destination, revision);
        }
        if (exists) { if (this.getItem(item.id).revision !== item.revision) conflicts.push(item.id); continue; }
        const current = revisions.find(r => r.hash === item.revision)!;
        atomicWrite(path.join(this.itemDir(item.id), 'content.md'), current.content);
        writeWorkingFiles(path.join(this.itemDir(item.id), 'files'), current.files);
        // Imported approvals remain historical evidence; imported content enters quarantine.
        writeJson(this.itemFile(item.id), { ...item, status: 'captured' }); imported++;
      }
      for (const trial of data.trials) {
        const file = path.join(this.canonical, 'experiments', `${trial.id}.json`);
        if (!fs.existsSync(file)) writeJson(file, trial);
      }
      for (const approval of data.approvals) {
        const file = path.join(this.canonical, 'approvals', `${approval.id}.json`);
        if (!fs.existsSync(file)) writeJson(file, { ...approval, trust: 'imported' });
      }
      for (const analysis of data.analyses) {
        const file = path.join(this.canonical, 'analyses', `${analysis.id}.json`);
        if (!fs.existsSync(file) && fs.existsSync(this.itemFile(analysis.itemId))) writeJson(file, analysis);
      }
      for (const value of data.activity) {
        const event = z.object({ id: idSchema, at: z.string(), itemId: idSchema.nullable(), kind: z.string().max(100), message: z.string().max(5000), revision: hashSchema.optional() }).parse(value);
        const file = path.join(this.canonical, 'activity', `${event.id}.json`);
        if (!fs.existsSync(file)) writeJson(file, event);
      }
      const configFile = path.join(this.canonical, 'workbench.json');
      const config = readJson(configFile) as Record<string, unknown>;
      writeJson(configFile, { ...config, collections: [...new Set([...this.collections(), ...data.collections])] });
      this.record('imported', `Imported ${imported} items; ${conflicts.length} diverging items retained for explicit resolution`);
      return { imported, conflicts, approvals: 'Historical approvals are not trusted automatically. Review and approve imported revisions locally.' };
    });
    this.cleanPrivateContent();
    return result;
  }
  importFile(file: string, kind: 'file' | 'image' | 'reference') {
    noLinks(file); invariant(fs.statSync(file).isFile(), 'INVALID_FILE', 'Select a regular file.');
    if (kind === 'reference') {
      const item = this.create({ title: path.basename(file), kind, content: `Local file reference: ${path.basename(file)}` });
      writeJson(path.join(this.local, 'references', `${item.id}.json`), { path: file });
      return item;
    }
    invariant(fs.statSync(file).size <= MAX_ATTACHMENT_BYTES, 'ASSET_TOO_LARGE', 'Use a file reference for files over 25 MB.');
    const name = safeRelative(`assets/${path.basename(file)}`);
    return this.create({ title: path.basename(file), kind, content: `Imported ${path.basename(file)}`, files: { [name]: fs.readFileSync(file).toString('base64') } });
  }
  referencePath(id: string) {
    idSchema.parse(id);
    const file = path.join(this.local, 'references', `${id}.json`);
    invariant(fs.existsSync(file), 'REFERENCE_MISSING', 'This file reference is not mapped on this machine. Import a local reference to choose its file.');
    const data = z.object({ path: z.string() }).parse(readJson(file));
    invariant(path.isAbsolute(data.path) && fs.existsSync(data.path), 'REFERENCE_MISSING', 'Referenced file is missing on this machine.');
    return data.path;
  }
  addAttachment(id: string, expect: string, file: string, relative: string) {
    noLinks(file); safeRelative(relative);
    invariant(fs.statSync(file).isFile() && fs.statSync(file).size <= MAX_ATTACHMENT_BYTES, 'ASSET_TOO_LARGE', 'Choose a regular file no larger than 25 MB.');
    const revision = this.authoring(id);
    return this.update({ id, expect, summary: `Updated bundled file ${relative}`, value: { ...revision, files: { ...revision.files, [relative]: fs.readFileSync(file).toString('base64') } } });
  }
  removeAttachment(id: string, expect: string, relative: string) {
    safeRelative(relative); const revision = this.authoring(id); const files = { ...revision.files }; delete files[relative];
    return this.update({ id, expect, summary: `Removed bundled file ${relative}`, value: { ...revision, files } });
  }
  importResource(root: string, relative: string) {
    safeRelative(relative); const file = path.resolve(root, relative);
    invariant(file.startsWith(path.resolve(root) + path.sep), 'INVALID_PATH', 'Resource escapes the repository.'); noLinks(file);
    invariant(fs.statSync(file).isFile(), 'INVALID_FILE', 'Select a regular source file.');
    const basename = path.basename(file);
    if (!/\.(md|txt)$/i.test(file)) return this.importFile(file, /\.(png|jpe?g|gif|webp)$/i.test(file) ? 'image' : 'file');
    invariant(fs.statSync(file).size <= 2_000_000, 'ASSET_TOO_LARGE', 'Text resource exceeds 2 MB.');
    const kind = basename === 'SKILL.md' ? 'skill' : ['AGENTS.md', 'CLAUDE.md'].includes(basename) ? 'instruction' : 'prompt';
    const files = kind === 'skill' ? readFiles(path.dirname(file)) : {}; delete files['SKILL.md'];
    const value = authoringSchema.parse({ title: kind === 'skill' ? path.basename(path.dirname(file)) : basename, kind, content: fs.readFileSync(file, 'utf8'), files, source: `repository:${relative}`, licence: 'Unknown' });
    const exists = this.listItems().find(i => i.source === value.source && i.revision === revisionHash(value));
    return exists ?? this.create(value);
  }
}
