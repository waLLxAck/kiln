import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../packages/domain/workbench';
import { revisionHash } from '../packages/domain/content';
import { initialiseRepository } from '../packages/git/standard';
import { readJson, writeJson } from '../packages/storage/files';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-provenance-once-'));
  const library = initialiseRepository({ parent: root, name: 'library' }).root;
  const local = path.join(root, 'private');
  const wb = new Workbench(library, local);
  const item = wb.create({ title: 'Reviewed prompt', kind: 'prompt', content: 'Reviewed content' });
  const original = { ...wb.getRevision(item.id), source: 'local:/home/private-user/prompts/review.md' };
  original.hash = revisionHash(original);
  writeJson(path.join(wb.itemDir(item.id), 'revisions', `${original.hash}.json`), original);
  writeJson(path.join(wb.itemDir(item.id), 'item.json'), { ...item, source: original.source, revision: original.hash });
  const approval = wb.approve({ id: item.id, revision: original.hash, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });
  return { root, library, local, wb, item, original, approval };
}

test('restoring a previously migrated revision keeps the normal unapproved draft state after reopening', () => {
  const f = fixture(); let wb = f.wb;
  try {
    wb.close(); wb = new Workbench(f.library, f.local);
    const approved = wb.getItem(f.item.id);
    assert.equal(approved.status, 'approved');
    const draft = wb.update({ id: approved.id, expect: approved.revision, value: { ...wb.authoring(approved.id), content: 'An edit' } });
    const restored = wb.restore({ id: approved.id, expect: draft.revision, revision: approved.revision });
    assert.equal(restored.revision, approved.revision);
    assert.equal(restored.status, 'captured', 'a normal restore creates a draft even when an older approval has the same hash');
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getItem(approved.id).status, 'captured', 'completed cleanup must not run the one-time approval repair again');
    assert.equal(wb.getRevision(approved.id).content, 'Reviewed content');
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('reopening a completed migration does not read archived revision bundles', () => {
  const f = fixture(); let wb = f.wb;
  const read = fs.readFileSync;
  try {
    wb.close(); wb = new Workbench(f.library, f.local);
    const archived = path.join(wb.local, 'private-revisions', f.item.id, `${f.original.hash}.json`);
    assert.ok(fs.existsSync(archived));
    wb.close();
    let reads = 0;
    fs.readFileSync = ((file, ...args) => {
      if (String(file) === archived) reads++;
      return Reflect.apply(read, fs, [file, ...args]);
    }) as typeof fs.readFileSync;
    wb = new Workbench(f.library, f.local);
    assert.equal(reads, 0, 'completed private bundles must be skipped before their content is read or parsed');
    assert.deepEqual(wb.warnings, []);
    assert.equal(wb.getItem(f.item.id).status, 'approved');
  } finally { fs.readFileSync = read; wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a completed migration still cleans a shared original reintroduced by another machine', () => {
  const f = fixture(); let wb = f.wb;
  try {
    wb.close(); wb = new Workbench(f.library, f.local);
    const portable = wb.getItem(f.item.id);
    writeJson(path.join(wb.itemDir(f.item.id), 'revisions', `${f.original.hash}.json`), f.original);
    writeJson(path.join(wb.itemDir(f.item.id), 'item.json'), { ...portable, source: f.original.source, revision: f.original.hash });
    writeJson(path.join(wb.canonical, 'approvals', `${f.approval.id}.json`), f.approval);
    wb.close(); wb = new Workbench(f.library, f.local);
    const current = wb.getItem(f.item.id);
    assert.equal(current.revision, portable.revision);
    assert.equal(current.source, 'local-import:review.md');
    assert.equal(current.status, 'approved');
    assert.equal(wb.approvals().find(a => a.id === f.approval.id)!.revision, current.revision);
    assert.equal(fs.existsSync(path.join(wb.itemDir(current.id), 'revisions', `${f.original.hash}.json`)), false);
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const source of ['local:/home/private-user/prompts/review.md', 'local:C:\\Users\\other-machine\\prompts\\review.md']) test(`reintroduced historical provenance from ${source} does not approve an intentionally restored draft again`, () => {
  const f = fixture(); let wb = f.wb;
  try {
    wb.close(); wb = new Workbench(f.library, f.local);
    const approved = wb.getItem(f.item.id);
    const draft = wb.update({ id: approved.id, expect: approved.revision, value: { ...wb.authoring(approved.id), content: 'An edit' } });
    wb.restore({ id: approved.id, expect: draft.revision, revision: approved.revision });
    const original = { ...f.original, source };
    original.hash = revisionHash(original);
    writeJson(path.join(wb.itemDir(approved.id), 'revisions', `${original.hash}.json`), original);
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getItem(approved.id).status, 'captured');
    assert.equal(wb.getItem(approved.id).revision, approved.revision);
    assert.equal(fs.existsSync(path.join(wb.itemDir(approved.id), 'revisions', `${original.hash}.json`)), false, 'shared history is cleaned even when approval repair has already finished');
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a fresh machine preserves a restored draft when a legacy historical source is present', () => {
  const f = fixture(); let wb = f.wb;
  try {
    wb.close(); wb = new Workbench(f.library, f.local);
    const approved = wb.getItem(f.item.id);
    const draft = wb.update({ id: approved.id, expect: approved.revision, value: { ...wb.authoring(approved.id), content: 'An edit' } });
    wb.restore({ id: approved.id, expect: draft.revision, revision: approved.revision });
    const original = { ...f.original, source: 'local:C:\\Users\\other-machine\\prompts\\review.md' };
    original.hash = revisionHash(original);
    writeJson(path.join(wb.itemDir(approved.id), 'revisions', `${original.hash}.json`), original);
    wb.close(); wb = new Workbench(f.library, path.join(f.root, 'fresh-machine'));
    assert.equal(wb.getItem(approved.id).status, 'captured', 'a private marker on another machine is not required to preserve an explicit draft');
    assert.equal(wb.getItem(approved.id).revision, approved.revision);
    assert.equal(wb.approvals().find(a => a.id === f.approval.id)!.revision, approved.revision);
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('migrating another item with the same bundle cannot approve a restored draft', () => {
  const f = fixture(); let wb = f.wb;
  try {
    wb.close(); wb = new Workbench(f.library, f.local);
    const approved = wb.getItem(f.item.id);
    const draft = wb.update({ id: approved.id, expect: approved.revision, value: { ...wb.authoring(approved.id), content: 'An edit' } });
    wb.restore({ id: approved.id, expect: draft.revision, revision: approved.revision });
    const copy = wb.create({ title: f.original.title, kind: f.original.kind, content: f.original.content });
    const original = { ...f.original, itemId: copy.id };
    writeJson(path.join(wb.itemDir(copy.id), 'revisions', `${original.hash}.json`), original);
    writeJson(path.join(wb.itemDir(copy.id), 'item.json'), { ...copy, source: original.source, revision: original.hash });
    wb.approve({ id: copy.id, revision: original.hash, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getItem(approved.id).status, 'captured');
    assert.equal(wb.getItem(copy.id).status, 'approved');
    assert.equal(wb.getItem(copy.id).revision, approved.revision, 'both items intentionally share the same content hash');
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a failure recording completion retries after all shared originals have been archived', () => {
  const f = fixture(); let wb = f.wb;
  const rename = fs.renameSync;
  try {
    const marker = path.join(wb.local, 'provenance-migrated.json');
    wb.close();
    let failed = false;
    fs.renameSync = ((from, to) => {
      if (String(to) === marker && !failed) { failed = true; throw new Error('Interrupted completion marker'); }
      return rename(from, to);
    }) as typeof fs.renameSync;
    wb = new Workbench(f.library, f.local);
    assert.ok(failed);
    assert.ok(wb.warnings.some(warning => warning.includes('Interrupted completion marker')));
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(path.join(wb.itemDir(f.item.id), 'revisions', `${f.original.hash}.json`)), false);
    fs.renameSync = rename;
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getItem(f.item.id).status, 'approved');
    assert.equal(wb.approvals().find(a => a.id === f.approval.id)!.revision, wb.getItem(f.item.id).revision);
    assert.deepEqual(readJson(marker), [`${f.item.id}:${f.original.hash}`, `${f.item.id}:${wb.getItem(f.item.id).revision}`].sort());
    assert.deepEqual(wb.warnings, []);
  } finally { fs.renameSync = rename; wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
