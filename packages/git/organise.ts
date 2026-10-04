import fs from 'node:fs';
import path from 'node:path';
import type { Workbench } from '../domain/workbench';
import { distinctSchema, itemSchema } from '../protocol/schema';
import { localPaths } from './sync';
import { catFile, git, headCommit } from './run';

/**
 * What an organisation commit (background sync) may carry: moves, order and favourites of items whose approved revision is
 * already on GitHub, the collection list, desired installs of published items, and the pairs marked as not duplicates.
 * Consolidation rides along too: a published copy merged into another published item goes to the trash on GitHub as well
 * (and comes back when restored), so other machines see one item. Everything else stays local: an item.json is only taken
 * when nothing but these fields differs from the committed one, so draft content can never ride along.
 */
const organisational = new Set(['collection', 'order', 'favourite']);
const merging = new Set([...organisational, 'deletedAt', 'mergedInto']);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Keys outside `allowed` are identical on both sides (`ignored` may differ too), and at least one key inside `allowed` differs. */
function onlyChanged(working: Record<string, unknown>, head: Record<string, unknown>, allowed: (key: string) => boolean, ignored: (key: string) => boolean = () => false) {
  const keys = new Set([...Object.keys(working), ...Object.keys(head)]);
  return [...keys].every(key => allowed(key) || ignored(key) || same(working[key], head[key])) && [...keys].some(key => allowed(key) && !same(working[key], head[key]));
}
/** An absent conflict list and an empty one mean the same; the published copy always writes it. */
const withHeads = (value: Record<string, unknown>) => ({ ...value, conflictHeads: value.conflictHeads ?? [] });
const serialise = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export type OrganisationPlan = { files: Record<string, string>; items: { id: string; title: string }[]; collections: boolean; installs: boolean; distinct?: boolean; message: string };
const libraryRelative = (wb: Workbench) => path.relative(wb.root, wb.canonical).split(path.sep).join('/');
const itemFile = (relative: string) => new RegExp(`^${relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/items/([a-f0-9-]{36})/item\\.json$`);

/**
 * The files an organisation commit compares against, as the last commit has them: every published item.json, the collection
 * list, the desired installs and the not-duplicate pairs. Read with one `git ls-tree` and one `git cat-file --batch` per HEAD, and
 * kept in memory, so deciding whether a change needs publishing starts no Git process at all.
 */
export class CommittedFiles {
  private texts = new Map<string, string>();
  private current?: { head: string; blobs: Map<string, string>; ids: Set<string> };
  private applied = 0;
  private started = 0;
  /** True when this reflects the commit HEAD points at now, judged from the repository's files without starting Git. */
  fresh(root: string) { const head = headCommit(root); return Boolean(head && this.current?.head === head); }
  /** Reads what HEAD has, unless that is already known. */
  async load(wb: Workbench) {
    const run = ++this.started;
    const head = (await git(wb.root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim();
    if (this.current?.head === head) return;
    const relative = libraryRelative(wb), pattern = itemFile(relative);
    const wanted = new Set([`${relative}/workbench.json`, `${relative}/installs.json`, `${relative}/distinct.json`]);
    const listing = await git(wb.root, ['ls-tree', '-r', '-z', head, '--', `${relative}/items/`, ...wanted], { maxBuffer: 256_000_000 });
    const blobs = new Map<string, string>(), ids = new Set<string>();
    for (const entry of listing.split('\0')) {
      const tab = entry.indexOf('\t'); if (tab < 0) continue;
      const [, type, sha] = entry.slice(0, tab).split(' '), file = entry.slice(tab + 1);
      const id = file.startsWith(`${relative}/items/`) ? file.slice(relative.length + 7).split('/')[0] : '';
      if (id) ids.add(id);
      if (type === 'blob' && (wanted.has(file) || pattern.test(file))) blobs.set(file, sha);
    }
    const missing = [...new Set(blobs.values())].filter(sha => !this.texts.has(sha));
    const read = await catFile(wb.root, missing);
    // Only the newest load counts; an older one finishing late must not replace it.
    if (run < this.applied) return;
    this.applied = run;
    for (const [sha, bytes] of read) if (bytes) this.texts.set(sha, bytes.toString('utf8'));
    const live = new Set(blobs.values());
    for (const sha of this.texts.keys()) if (!live.has(sha)) this.texts.delete(sha);
    this.current = { head, blobs, ids };
  }
  /** Items with a folder in the last commit. */
  published(): Set<string> { return this.current?.ids ?? new Set(); }
  /** item.json files of every published item. */
  itemFiles() { return [...this.current?.blobs.keys() ?? []].filter(file => file.endsWith('/item.json')); }
  text(file: string): string | null { const sha = this.current?.blobs.get(file); return sha ? this.texts.get(sha) ?? null : null; }
  json(file: string): Record<string, unknown> | null {
    const text = this.text(file); if (text === null) return null;
    try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
  }
}

/**
 * The plan for the files in `changed` (repository-relative paths). The job passes every path `git status` lists; the decision
 * whether to queue a job passes only the files of items the user just organised. `committed` must be loaded for HEAD.
 *
 * `installIds`: items whose desired installs changed on this machine since they were last published.
 */
export function planFor(wb: Workbench, changed: Set<string>, committed: CommittedFiles, installIds: Iterable<string> = []): OrganisationPlan {
  const relative = libraryRelative(wb), pattern = itemFile(relative);
  const files: Record<string, string> = {}, items: OrganisationPlan['items'] = [];
  let trustedRevisions: Set<string> | undefined;
  const trusted = () => trustedRevisions ??= new Set(wb.approvals().filter(a => a.trust === 'local').map(a => `${a.itemId}:${a.revision}`));
  const published = committed.published();
  for (const file of changed) {
    const id = file.match(pattern)?.[1];
    if (!id) continue;
    // Never published (a local draft, or untracked): nothing to compare with, and nothing is read.
    const head = committed.json(file); if (!head) continue;
    let text: string; try { text = fs.readFileSync(path.join(wb.root, file), 'utf8'); } catch { continue; }
    let working: unknown; try { working = JSON.parse(text); } catch { continue; }
    const parsed = itemSchema.safeParse(working), before = itemSchema.safeParse(head);
    if (!parsed.success || !before.success) continue;
    const item = parsed.data;
    // A merge (or its undoing) of a published copy into a published item; the trash on its own stays on this machine.
    const merge = Boolean(item.mergedInto || before.data.mergedInto) && (!item.mergedInto || (Boolean(item.deletedAt) && published.has(item.mergedInto)));
    // The approved revision GitHub already has, still approved here and not in the trash: only then is the change organisation.
    if (item.revision !== before.data.revision || item.status !== 'approved' || before.data.status !== 'approved' || (!merge && (item.deletedAt || before.data.deletedAt))) continue;
    // updatedAt may differ but is not a reason to commit on its own; approving rewrites it.
    if (!onlyChanged(withHeads(working as Record<string, unknown>), withHeads(head), key => (merge ? merging : organisational).has(key), key => key === 'updatedAt')) continue;
    if (!trusted().has(`${id}:${item.revision}`)) continue;
    files[file] = Buffer.from(text).toString('base64'); items.push({ id, title: item.title });
  }
  const config = `${relative}/workbench.json`;
  let collections = false;
  if (changed.has(config)) {
    const head = committed.json(config);
    try {
      const text = fs.readFileSync(path.join(wb.root, config), 'utf8'), working = JSON.parse(text);
      if (head && onlyChanged(working, head, key => key === 'collections')) { files[config] = Buffer.from(text).toString('base64'); collections = true; }
    } catch { /* Unreadable: leave it for the user. */ }
  }
  const pairs = `${relative}/distinct.json`;
  let distinct = false;
  if (changed.has(pairs)) {
    try { const text = fs.readFileSync(path.join(wb.root, pairs), 'utf8'); distinctSchema.parse(JSON.parse(text)); files[pairs] = Buffer.from(text).toString('base64'); distinct = true; }
    catch { /* Unreadable or removed: leave it for the user. */ }
  }
  const manifest = `${relative}/installs.json`;
  let installs = false;
  const wanted = [...new Set(installIds)];
  if (wanted.length) {
    // Only items whose install intent changed here: approval commits never write installs.json into this folder, so an entry
    // missing from it may simply never have been known here, not removed. Items still waiting for their approval commit get
    // their intent with that commit.
    const head = committed.json(manifest) ?? {}, working = wb.installs() as Record<string, unknown>, next: Record<string, unknown> = { ...head };
    for (const id of wanted) {
      if (!published.has(id)) continue;
      if (working[id]) next[id] = working[id]; else delete next[id];
    }
    if (!same(next, head)) {
      let text = serialise(next); try { const raw = fs.readFileSync(path.join(wb.root, manifest), 'utf8'); if (same(JSON.parse(raw), next)) text = raw; } catch { /* Written fresh below. */ }
      files[manifest] = Buffer.from(text).toString('base64'); installs = true;
    }
  }
  const parts = [items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '', collections ? 'collections' : '', installs ? 'desired installs' : '', distinct ? 'items that are not duplicates' : ''].filter(Boolean);
  const subject = items.length === 1 && !collections && !installs && !distinct ? `Organise "${items[0].title.replace(/\s+/g, ' ').trim().slice(0, 50)}"` : `Organise library: ${parts.join(', ')}`;
  const body = items.length > 1 ? items.slice(0, 10).map(i => `- ${i.title.replace(/\s+/g, ' ').trim().slice(0, 80)}`).join('\n') + (items.length > 10 ? `\n- and ${items.length - 10} more` : '') : '';
  return { files, items, collections, installs, distinct, message: body ? `${subject}\n\n${body}` : subject };
}

/**
 * What the user just did that may need publishing: item ids, or every published item (collections were renamed or moved),
 * and whether the collection list or the not-duplicate pairs may have changed.
 */
export type OrganiseHint = { ids?: Iterable<string>; all?: boolean; collections?: boolean; distinct?: boolean };
/** The files a hint points at whose working copy may differ from the committed one; nothing here starts Git. */
export function hintedFiles(wb: Workbench, hint: OrganiseHint, committed: CommittedFiles) {
  const relative = libraryRelative(wb), changed = new Set<string>();
  if (hint.all) for (const file of committed.itemFiles()) changed.add(file);
  for (const id of hint.ids ?? []) if (/^[a-f0-9-]{36}$/.test(id)) changed.add(`${relative}/items/${id}/item.json`);
  if (hint.collections || hint.all) changed.add(`${relative}/workbench.json`);
  if (hint.distinct) {
    const pairs = `${relative}/distinct.json`;
    let text: string | null = null; try { text = fs.readFileSync(path.join(wb.root, pairs), 'utf8'); } catch { /* Removed or never written. */ }
    if (text !== null && text !== committed.text(pairs)) changed.add(pairs);
  }
  return changed;
}

/** The plan for everything changed on this machine, read with three Git processes however large the library is. */
export async function organisationPlan(wb: Workbench, installIds: Iterable<string> = [], committed = new CommittedFiles()): Promise<OrganisationPlan> {
  await committed.load(wb);
  // Untracked files cannot be in the last commit; leaving them out keeps hundreds of local drafts from being looked at.
  const tracked = await localPaths(wb.root, { tracked: true });
  const relative = libraryRelative(wb), changed = new Set(tracked);
  // A not-duplicate list written for the first time is untracked, and still goes to GitHub.
  if (fs.existsSync(path.join(wb.root, relative, 'distinct.json')) && committed.text(`${relative}/distinct.json`) === null) changed.add(`${relative}/distinct.json`);
  return planFor(wb, changed, committed, installIds);
}
