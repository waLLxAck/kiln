import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { revisionSchema, type Item, type Plan, type PublishJob, type Receipt, type Revision } from '../protocol/schema';
import { digest, noLinks, readJson, readRecords, writeJson } from '../storage/files';
import { revisionHash } from './content';
import { invariant } from './errors';
import { privateAttachment, shareableAuthoring } from './privacy';
import type { Workbench } from './workbench';

/** Redacting generated provenance leaves the reviewed bundle intact. Removing any attachment does not. */
export function provenanceOnly(revision: Revision) {
  return shareableAuthoring(revision).source !== revision.source && !Object.keys(revision.files).some(privateAttachment);
}

/** Avoid rewriting a durable record when migration leaves its values unchanged. */
function writeChanged(file: string, value: unknown) {
  if (!fs.existsSync(file) || digest(readJson(file)) !== digest(value)) writeJson(file, value);
}

/** Skip completed private bundles before reading their potentially large attachments. Shared originals are loaded separately. */
function pendingArchives(wb: Workbench, id: string, shared: Map<string, Revision>, completed: Set<string>) {
  const folder = path.join(wb.local, 'private-revisions', id);
  if (!fs.existsSync(folder)) return [];
  noLinks(folder);
  return fs.readdirSync(folder).filter(name => name.endsWith('.json') && !shared.has(name.slice(0, -5)) && !completed.has(`${id}:${name.slice(0, -5)}`)).flatMap(name => {
    try {
      const file = path.join(folder, name); noLinks(file);
      const revision = revisionSchema.parse(readJson(file));
      invariant(name === `${revision.hash}.json`, 'BUNDLE_TAMPERED', 'Archived revision filename does not match its hash.');
      return [revision];
    } catch (error) { wb.warnings.push(`${name}: ${String(error)}`); return []; }
  });
}

/**
 * Re-key provenance-only snapshots and their references deterministically, retaining original bytes privately.
 * Originals are archived first, and shared originals are removed last. A partial migration can therefore be retried
 * from either copy, including libraries that an older Kiln already cleaned into an unapproved draft. Completion is recorded
 * only after removal succeeds, so archived originals do not repeat the one-time approval repair on later launches.
 * The caller holds the library mutation lock and invalidates item caches afterwards.
 */
export function migrateProvenance(wb: Workbench) {
  const marker = path.join(wb.local, 'provenance-migrated.json');
  noLinks(marker);
  const completed = new Set<string>(fs.existsSync(marker) ? z.array(z.string()).parse(readJson(marker)) : []);
  const mapped = new Map<string, string>(), snapshots = new Map<string, Revision[]>(), items = wb.listItems(true);
  const checkedArchives = new Set<string>(), repairable = new Set<string>(), destinations = new Set<string>();
  const key = (id: string, hash: string) => `${id}:${hash}`;
  const removals: string[] = [];
  for (const item of items) {
    const shared = path.join(wb.itemDir(item.id), 'revisions');
    const originals = new Map<string, Revision>();
    // Shared copies take precedence so an existing clean snapshot keeps its original history metadata.
    try {
      for (const revision of readRecords(shared, value => revisionSchema.parse(value), wb.warnings)) originals.set(revision.hash, revision);
      const archived = pendingArchives(wb, item.id, originals, completed);
      for (const revision of archived) originals.set(revision.hash, revision);
      for (const revision of originals.values()) {
        invariant(revision.itemId === item.id && revisionHash(revision) === revision.hash, 'BUNDLE_TAMPERED', 'Cannot migrate a modified revision.');
      }
      for (const revision of archived) checkedArchives.add(key(item.id, revision.hash));
    } catch (error) { wb.warnings.push(`${item.title}: ${String(error)}`); continue; }
    const clean = new Map<string, Revision>();
    for (const revision of originals.values()) {
      if (provenanceOnly(revision)) {
        const safe = shareableAuthoring(revision), hash = revisionHash(safe, 2);
        mapped.set(key(item.id, revision.hash), hash);
        destinations.add(key(item.id, hash));
        if (!completed.has(key(item.id, revision.hash)) && !completed.has(key(item.id, hash))) repairable.add(key(item.id, hash));
        writeChanged(path.join(wb.local, 'private-revisions', item.id, `${revision.hash}.json`), revision);
        writeChanged(path.join(wb.local, 'private-sources', item.id, `${revision.hash}.json`), { source: revision.source, description: revision.description, files: {} });
        if (!clean.has(hash)) clean.set(hash, { ...safe, hashVersion: 2, hash });
        const file = path.join(shared, `${revision.hash}.json`);
        if (fs.existsSync(file)) removals.push(file);
      } else if (fs.existsSync(path.join(shared, `${revision.hash}.json`)) && !Object.keys(revision.files).some(privateAttachment)) {
        clean.set(revision.hash, revision);
      }
    }
    snapshots.set(item.id, [...clean.values()]);
  }
  if (!mapped.size) {
    if (checkedArchives.size) writeChanged(marker, [...new Set([...completed, ...checkedArchives])].sort());
    return [];
  }
  const remap = (id: string, hash: string) => mapped.get(key(id, hash)) ?? hash;
  // Make every destination readable before moving any decision or item pointer to it.
  for (const [id, revisions] of snapshots) for (const revision of revisions) {
    const parent = revision.parent ? remap(id, revision.parent) : null;
    writeChanged(path.join(wb.itemDir(id), 'revisions', `${revision.hash}.json`), { ...revision, parent: parent === revision.hash ? null : parent });
  }
  const previousApprovals = wb.approvals(true);
  const reviewed = new Set(previousApprovals.filter(a => a.trust === 'local' && !a.revokedAt).map(a => key(a.itemId, a.revision)));
  const approvals = previousApprovals.map(approval => ({ ...approval, revision: remap(approval.itemId, approval.revision),
    ...(approval.carriedFrom ? { carriedFrom: remap(approval.itemId, approval.carriedFrom) } : {}) }));
  const changed: string[] = [];
  // Preserve an explicit draft already covered by an approval. Write repairs before moving approval pointers so a failed
  // item write remains distinguishable from that draft on retry, including when the private completion marker is absent.
  for (const item of items) {
    const revision = remap(item.id, item.revision);
    const safe = revision !== item.revision ? shareableAuthoring({ ...item, content: '', files: {} }) : item;
    const updated: Item = { ...item, revision, source: safe.source, description: safe.description,
      ...(item.origin ? { origin: { ...item.origin, revision: remap(item.origin.itemId, item.origin.revision) } } : {}),
      ...(item.conflictHeads ? { conflictHeads: [...new Set(item.conflictHeads.map(hash => remap(item.id, hash)))] } : {}) };
    if (item.status === 'captured' && !reviewed.has(key(item.id, item.revision)) && repairable.has(key(item.id, revision)) && approvals.some(a => a.itemId === item.id && a.revision === revision && a.trust === 'local' && !a.revokedAt)) updated.status = 'approved';
    if (digest(item) !== digest(updated)) {
      writeChanged(path.join(wb.itemDir(item.id), 'item.json'), updated); changed.push(item.id);
    }
  }
  for (const approval of approvals) writeChanged(path.join(wb.canonical, 'approvals', `${approval.id}.json`), approval);
  for (const [folder, records] of [
    ['experiments', wb.trials(true)], ['analyses', wb.analyses()], ['scores', wb.scores()],
  ] as const) for (const record of records) writeChanged(path.join(wb.canonical, folder, `${record.id}.json`), { ...record, revision: remap(record.itemId, record.revision) });
  for (const event of wb.activity()) if (event.itemId && event.revision) {
    writeChanged(path.join(wb.canonical, 'activity', `${event.id}.json`), { ...event, revision: remap(event.itemId, event.revision) });
  }
  // Provenance is absent from installed bytes, so existing ownership and rollback still describe the same bundles.
  for (const receipt of readRecords(path.join(wb.local, 'receipts'), value => value as Receipt, wb.warnings)) {
    writeChanged(path.join(wb.local, 'receipts', `${receipt.id}.json`), { ...receipt, revision: remap(receipt.itemId, receipt.revision),
      previousRevision: receipt.previousRevision ? remap(receipt.itemId, receipt.previousRevision) : null });
  }
  for (const plan of readRecords(path.join(wb.local, 'plans'), value => value as Plan, wb.warnings)) {
    writeChanged(path.join(wb.local, 'plans', `${plan.id}.json`), { ...plan, revision: remap(plan.itemId, plan.revision) });
  }
  for (const journal of readRecords(path.join(wb.local, 'journals'), value => value as { id: string; receipt: Receipt }, wb.warnings)) {
    const receipt = journal.receipt;
    writeChanged(path.join(wb.local, 'journals', `${journal.id}.json`), { ...journal, receipt: { ...receipt,
      revision: remap(receipt.itemId, receipt.revision), previousRevision: receipt.previousRevision ? remap(receipt.itemId, receipt.previousRevision) : null } });
  }
  for (const job of readRecords(path.join(wb.local, 'publish', 'jobs'), value => value as PublishJob, wb.warnings)) {
    if (job.status === 'done' || !job.itemId || !job.revision) continue;
    const revision = remap(job.itemId, job.revision);
    if (revision === job.revision) continue;
    // A retry must rebuild the captured files; an old snapshot can still contain a machine-specific path.
    fs.rmSync(path.join(wb.local, 'publish', 'snapshots', `${job.id}.json`), { force: true });
    writeChanged(path.join(wb.local, 'publish', 'jobs', `${job.id}.json`), { ...job, revision, message: '', composer: '', commit: '' });
  }
  for (const file of removals) fs.unlinkSync(file);
  writeChanged(marker, [...new Set([...completed, ...checkedArchives, ...mapped.keys(), ...destinations])].sort());
  return changed;
}
