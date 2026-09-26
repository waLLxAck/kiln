import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService, readDestination } from '../packages/deployment/service';
import { WorkbenchError } from '../packages/domain/errors';
import { resolveVariables } from '../packages/domain/content';
import { readJson, writeJson, withLock, safeRelative } from '../packages/storage/files';

const content = '---\nname: careful-review\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff. Verify claims. Record uncertainty.\n';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln ü test '));
  const wb = new Workbench(path.join(root, 'library with spaces'), path.join(root, 'private'));
  const deployment = new DeploymentService(wb);
  const environment = path.join(root, 'agent home'); fs.mkdirSync(environment);
  const target = wb.enroll({ name: 'Test Codex', root: environment, provider: 'codex', scope: 'personal', profile: 'Test' });
  return { root, wb, deployment, target, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function approved(wb: Workbench) {
  const item = wb.create({ title: 'Careful review', kind: 'skill', content });
  wb.approve({ id: item.id, revision: item.revision, reviewer: 'Test reviewer', scope: 'Isolated test environment', note: 'Inspected exact content', waivedChecks: 'Fixture tests deployment integrity, not agent performance.' });
  return wb.getItem(item.id);
}
const hasCode = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.code === code;

test('unapprove revokes deployment permission, preserves history and installed files, and permits reapproval', () => {
  const f = fixture();
  try {
    const item = approved(f.wb);
    const args = { itemId: item.id, revision: item.revision, targetId: f.target.id };
    const plan = f.deployment.plan(args);
    f.deployment.apply({ planId: plan.id, expectState: null, confirm: true });
    const pending = f.deployment.plan(args);
    assert.throws(() => f.wb.unapprove({ id: item.id, revision: '0'.repeat(64) }), hasCode('REVISION_CONFLICT'));
    f.wb.unapprove({ id: item.id, revision: item.revision });
    assert.equal(f.wb.getItem(item.id).status, 'captured');
    assert.equal(f.wb.approvals().length, 0);
    assert.ok(f.wb.approvals(true)[0].revokedAt);
    assert.throws(() => f.deployment.plan(args), hasCode('APPROVAL_REQUIRED'));
    assert.throws(() => f.deployment.apply({ planId: pending.id, expectState: pending.expectedState, confirm: true }), hasCode('APPROVAL_REQUIRED'));
    assert.equal(fs.readFileSync(path.join(plan.destination, 'SKILL.md'), 'utf8'), content);
    const exported = path.join(f.root, 'export.json');
    f.wb.exportLibrary(exported);
    assert.ok(JSON.parse(fs.readFileSync(exported, 'utf8')).approvals[0].revokedAt);
    f.wb.approve({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Approve again', waivedChecks: 'Test fixture' });
    assert.equal(f.wb.approvals().length, 1);
    assert.equal(f.wb.approvals(true).length, 2);
    assert.equal(f.deployment.plan(args).blocked, null);
  } finally { f.close(); }
});

test('capture, full-text retrieval, variables, file asset, close/reopen and trash recovery', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Unicode résumé', kind: 'prompt', content: 'First line\nUnique marmalade {{subject}}', tags: ['research'] });
    assert.equal(f.wb.search('marmalade')[0].id, item.id);
    assert.equal(f.wb.search('research')[0].id, item.id);
    const png = path.join(f.root, 'picture.png'); fs.writeFileSync(png, Buffer.from([137, 80, 78, 71]));
    const image = f.wb.importFile(png, 'image'); assert.equal(Object.keys(f.wb.getRevision(image.id).files)[0], 'assets/picture.png');
    f.wb.setMeta({ id: item.id, expect: item.revision, deleted: true }); assert.equal(f.wb.search('marmalade').length, 0);
    f.wb.setMeta({ id: item.id, expect: item.revision, deleted: false }); assert.equal(f.wb.search('marmalade').length, 1);
    const second = new Workbench(f.wb.root, path.join(f.root, 'second-private'));
    assert.equal(second.getRevision(item.id).content, 'First line\nUnique marmalade {{subject}}'); second.close();
  } finally { f.close(); }
});

test('every variable is optional: missing or blank values keep their placeholder as written', () => {
  const template = 'Review {{ subject }} for {{audience}} using {{subject}}.';
  assert.equal(resolveVariables(template, {}), template);
  assert.equal(resolveVariables(template, { subject: 'the diff', audience: '  ' }), 'Review the diff for {{audience}} using the diff.');
  assert.equal(resolveVariables(template, { audience: 'reviewers', extra: 'ignored' }), 'Review {{ subject }} for reviewers using {{subject}}.');
});

test('exact approved snapshots cannot change through later edits, including bundled scripts', () => {
  const f = fixture();
  try {
    const item = approved(f.wb);
    const plan = f.deployment.plan({ itemId: item.id, revision: item.revision, targetId: f.target.id });
    assert.equal(fs.existsSync(plan.destination), false, 'dry run must not write to destination');
    const receipt = f.deployment.apply({ planId: plan.id, expectState: null, confirm: true });
    assert.equal(fs.readFileSync(path.join(plan.destination, 'SKILL.md'), 'utf8'), content);
    const newItem = f.wb.update({ id: item.id, expect: item.revision, summary: 'Add unapproved change', value: { ...f.wb.getRevision(item.id), content: content + '\nChanged.' } });
    assert.notEqual(newItem.revision, item.revision); assert.equal(newItem.status, 'captured');
    assert.equal(fs.readFileSync(path.join(plan.destination, 'SKILL.md'), 'utf8'), content);
    assert.throws(() => f.deployment.plan({ itemId: item.id, revision: newItem.revision, targetId: f.target.id }), hasCode('APPROVAL_REQUIRED'));
    assert.deepEqual(f.deployment.apply({ planId: plan.id, expectState: null, confirm: true }), receipt, 'retry must return same receipt');
    f.deployment.rollback({ receiptId: receipt.id, expectState: receipt.hash, confirm: true });
    assert.equal(fs.existsSync(plan.destination), false);
  } finally { f.close(); }
});

test('unmanaged, drifted and stale plan destinations block without overwriting user files', () => {
  const f = fixture();
  try {
    const item = approved(f.wb);
    const first = f.deployment.plan({ itemId: item.id, revision: item.revision, targetId: f.target.id });
    fs.mkdirSync(first.destination, { recursive: true }); fs.writeFileSync(path.join(first.destination, 'owned-by-user.txt'), 'keep');
    assert.throws(() => f.deployment.apply({ planId: first.id, expectState: null, confirm: true }), hasCode('TARGET_DRIFTED'));
    const blocked = f.deployment.plan({ itemId: item.id, revision: item.revision, targetId: f.target.id });
    assert.match(blocked.blocked!, /TARGET_UNMANAGED/);
    assert.throws(() => f.deployment.apply({ planId: blocked.id, expectState: blocked.expectedState, confirm: true }), hasCode('TARGET_BLOCKED'));
    assert.equal(fs.readFileSync(path.join(first.destination, 'owned-by-user.txt'), 'utf8'), 'keep');
  } finally { f.close(); }
});

test('rollback restores an owned prior approved version and refuses drift', () => {
  const f = fixture();
  try {
    const item = approved(f.wb);
    const p1 = f.deployment.plan({ itemId: item.id, revision: item.revision, targetId: f.target.id });
    const r1 = f.deployment.apply({ planId: p1.id, expectState: null, confirm: true });
    const next = f.wb.update({ id: item.id, expect: item.revision, summary: 'Second approved revision', value: { ...f.wb.getRevision(item.id), content: content + '\nCheck edge cases.' } });
    f.wb.approve({ id: next.id, revision: next.revision, reviewer: 'Human', scope: 'Testing', note: 'Reviewed', waivedChecks: 'Deployment fixture' });
    const p2 = f.deployment.plan({ itemId: next.id, revision: next.revision, targetId: f.target.id });
    const r2 = f.deployment.apply({ planId: p2.id, expectState: r1.hash, confirm: true });
    const restored = f.deployment.rollback({ receiptId: r2.id, expectState: r2.hash, confirm: true });
    assert.equal(fs.readFileSync(path.join(p2.destination, 'SKILL.md'), 'utf8'), content);
    fs.appendFileSync(path.join(p2.destination, 'SKILL.md'), '\nUser edit');
    assert.throws(() => f.deployment.rollback({ receiptId: restored.id, expectState: restored.hash, confirm: true }), hasCode('TARGET_DRIFTED'));
    assert.equal(f.deployment.drift()[0].drifted, true);
  } finally { f.close(); }
});

test('Codex and Claude instruction scopes remain distinct', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Project rules', kind: 'instruction', content: 'Run checks before proposing changes.' });
    f.wb.approve({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Isolated project', note: 'Reviewed', waivedChecks: 'Test fixture' });
    const claude = f.wb.enroll({ name: 'Test Claude', root: f.target.root, provider: 'claude', scope: 'project', profile: 'Test' });
    const p1 = f.deployment.plan({ itemId: item.id, revision: item.revision, targetId: f.target.id });
    const p2 = f.deployment.plan({ itemId: item.id, revision: item.revision, targetId: claude.id });
    assert.equal(p1.destination, path.join(f.target.root, '.codex', 'AGENTS.md'));
    assert.equal(p2.destination, path.join(f.target.root, 'CLAUDE.md'));
    f.deployment.apply({ planId: p1.id, expectState: null, confirm: true }); f.deployment.apply({ planId: p2.id, expectState: null, confirm: true });
    assert.equal(fs.readFileSync(p1.destination, 'utf8'), fs.readFileSync(p2.destination, 'utf8'));
  } finally { f.close(); }
});

test('external edits make a new draft; stale saves and tampered snapshots fail', () => {
  const f = fixture();
  try {
    const item = approved(f.wb);
    fs.writeFileSync(path.join(f.wb.itemDir(item.id), 'content.md'), content + '\nExternal'); f.wb.refresh();
    assert.notEqual(f.wb.getItem(item.id).revision, item.revision); assert.equal(f.wb.getItem(item.id).status, 'captured');
    assert.throws(() => f.wb.update({ id: item.id, expect: item.revision, summary: 'Stale', value: { ...f.wb.getRevision(item.id), content: 'stale' } }), hasCode('REVISION_CONFLICT'));
    const file = path.join(f.wb.itemDir(item.id), 'revisions', `${item.revision}.json`);
    const record = readJson(file) as Record<string, unknown>; writeJson(file, { ...record, content: 'tampered' });
    assert.throws(() => f.wb.getRevision(item.id, item.revision), hasCode('BUNDLE_TAMPERED'));
  } finally { f.close(); }
});

test('manual trials retain exact revision, private inputs and explicit human judgement', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Trial', kind: 'prompt', content: 'Evaluate {{case}}.' });
    assert.match(f.wb.prepareTrial({ id: item.id, revision: item.revision, provider: 'codex', task: 'Task', rubric: ['Factual'], case: 'typical' }).prompt, /^Evaluate \{\{case\}\}\./, 'variables are optional; unfilled placeholders stay visible');
    const prepared = f.wb.prepareTrial({ id: item.id, revision: item.revision, provider: 'codex', variables: { case: 'PRIVATE_SECRET_INPUT' }, task: 'PRIVATE_TASK', rubric: ['Factual'], case: 'typical' });
    assert.match(prepared.prompt, /PRIVATE_SECRET_INPUT/); assert.equal(JSON.stringify(f.wb.trials()).includes('PRIVATE_SECRET_INPUT'), false);
    f.wb.finishTrial({ id: prepared.trial.id, judgement: 'pass', note: 'Meets rubric', output: 'PRIVATE_OUTPUT' });
    assert.equal(JSON.stringify(f.wb.trials()).includes('PRIVATE_OUTPUT'), false);
    assert.throws(() => f.wb.finishTrial({ id: prepared.trial.id, judgement: 'fail', note: 'Overwrite', output: 'Different' }), hasCode('TRIAL_CLOSED'));
    assert.equal(f.wb.trials()[0].revision, item.revision);
  } finally { f.close(); }
});

test('approval requires valid skill schema, exact trial evidence and explicit waivers', () => {
  const f = fixture();
  try {
    const invalid = f.wb.create({ title: 'Bad', kind: 'skill', content: '# No frontmatter' });
    assert.throws(() => f.wb.approve({ id: invalid.id, revision: invalid.revision, reviewer: 'Human', scope: 'Test', note: 'Reason', waivedChecks: 'waived' }), hasCode('VALIDATION_FAILED'));
    const item = f.wb.create({ title: 'Valid', kind: 'skill', content });
    assert.throws(() => f.wb.approve({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reason' }), hasCode('CHECKS_REQUIRED'));
    const evidence = ['typical', 'boundary'].map(c => { const t = f.wb.prepareTrial({ id: item.id, revision: item.revision, provider: 'manual', task: 'Test', rubric: ['Criterion'], case: c }); f.wb.finishTrial({ id: t.trial.id, judgement: 'pass', note: 'Observed', outputReference: 'local transcript' }); return t.trial.id; });
    const approval = f.wb.approve({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', evidence });
    assert.equal(approval.evidence.length, 2);
  } finally { f.close(); }
});

test('hostile paths, case collisions, symlinks, oversized and malicious bundles are rejected', () => {
  const f = fixture();
  try {
    for (const name of ['../escape', 'C:/escape', '/escape', 'a\\b', 'a/../b', 'CON.txt', 'trailing.', 'a?b', 'a*b', 'a|b', 'a\nb']) assert.throws(() => safeRelative(name));
    assert.throws(() => f.wb.create({ title: 'Attack', kind: 'skill', content, files: { '../evil': 'YQ==' } }), hasCode('INVALID_PATH'));
    assert.throws(() => f.wb.create({ title: 'Attack', kind: 'skill', content, files: { 'A.txt': 'YQ==', 'a.txt': 'Yg==' } }), hasCode('INVALID_PATH'));
    assert.throws(() => f.wb.create({ title: 'Attack', kind: 'skill', content, files: { 'SKILL.md': 'YQ==' } }), hasCode('INVALID_PATH'));
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const linked = path.join(f.target.root, '.agents'); fs.symlinkSync(outside, linked, 'junction');
    const item = approved(f.wb);
    assert.throws(() => f.deployment.plan({ itemId: item.id, revision: item.revision, targetId: f.target.id }), hasCode('SYMLINK_REJECTED'));
  } finally { f.close(); }
});

test('observations are deduplicated and copy does not become invocation', () => {
  const f = fixture();
  try {
    const item = approved(f.wb);
    const observation = { schemaVersion: 1, eventId: 'event-1', itemId: item.id, revision: item.revision, kind: 'copied', source: 'kiln', confidence: 'observed', occurredAt: new Date().toISOString() };
    assert.equal(f.wb.observe(observation).duplicate, false); assert.equal(f.wb.observe(observation).duplicate, true);
    assert.equal(f.wb.observations().length, 1); assert.equal(f.wb.observations()[0].kind, 'copied');
  } finally { f.close(); }
});

test('export restores authored bundles and divergent revisions without overwriting local drafts', () => {
  const f = fixture();
  try {
    f.wb.saveCollections({ names: ['Empty custom collection'] });
    const item = approved(f.wb); const file = path.join(f.root, 'export.json'); f.wb.exportLibrary(file);
    const clone = new Workbench(path.join(f.root, 'clone'), path.join(f.root, 'clone-private'));
    assert.equal(clone.importLibrary(file).imported, 1); assert.equal(clone.importLibrary(file).imported, 0);
    assert.ok(clone.collections().includes('Empty custom collection'));
    assert.equal(clone.getRevision(item.id).content, content); assert.equal(clone.getItem(item.id).status, 'captured');
    const changed = clone.update({ id: item.id, expect: item.revision, summary: 'Offline change', value: { ...clone.getRevision(item.id), content: content + '\nOffline.' } });
    const result = clone.importLibrary(file); assert.deepEqual(result.conflicts, [item.id]); assert.equal(clone.getItem(item.id).revision, changed.revision);
    assert.equal(clone.detail(item.id).revisions.length, 2); clone.close();
  } finally { f.close(); }
});

test('deleting a collection with trash-items trashes its items and subfolders; restoring an item brings the collection back', () => {
  const f = fixture();
  try {
    f.wb.saveCollections({ names: ['Personal', 'Scratch', 'Scratch/Deeper', 'Empty'] });
    const kept = f.wb.create({ title: 'Kept', kind: 'prompt', content: 'Stays', collection: 'Personal' });
    const gone = f.wb.create({ title: 'Gone', kind: 'prompt', content: 'Goes', collection: 'Scratch' });
    const deeper = f.wb.create({ title: 'Deeper', kind: 'prompt', content: 'Goes too', collection: 'Scratch/Deeper' });
    assert.throws(() => f.wb.deleteCollection({ name: 'Scratch', confirm: true }), 'what happens to the items is never a default');
    const result = f.wb.deleteCollection({ name: 'Scratch', confirm: true, items: 'trash' });
    assert.deepEqual(new Set(result.trashed), new Set([gone.id, deeper.id])); assert.deepEqual(result.moved, []);
    assert.deepEqual(f.wb.collections(), ['Personal', 'Empty']);
    assert.ok(f.wb.getItem(gone.id).deletedAt); assert.equal(f.wb.getItem(gone.id).revision, gone.revision, 'trashing does not create a revision');
    assert.equal(f.wb.getItem(gone.id).collection, 'Scratch', 'trashed items keep the name');
    assert.equal(f.wb.getItem(kept.id).deletedAt, null);
    assert.deepEqual(f.wb.deleteCollection({ name: 'Empty', confirm: true, items: 'keep' }).moved, []);
    assert.ok(!f.wb.collections().includes('Empty'));
    assert.throws(() => f.wb.deleteCollection({ name: 'Personal', items: 'trash' }), 'deleting needs an explicit confirm');
    assert.throws(() => f.wb.deleteCollection({ name: 'Missing', confirm: true, items: 'trash' }), hasCode('COLLECTION_NOT_FOUND'));
    f.wb.setMeta({ id: gone.id, expect: gone.revision, deleted: false });
    assert.ok(f.wb.collections().includes('Scratch'), 'a restored item brings its collection back');
  } finally { f.close(); }
});

test('deleting a collection with keep-items moves items and subfolders up one level without touching revisions or approval', () => {
  const f = fixture();
  try {
    f.wb.saveCollections({ names: ['Skills', 'Skills/Review', 'Skills/Review/Deep', 'Other', 'Review'] });
    const skill = approved(f.wb); f.wb.moveItems({ ids: [skill.id], collection: 'Skills/Review' });
    const deep = f.wb.create({ title: 'Deep', kind: 'prompt', content: 'Deep one', collection: 'Skills/Review/Deep' });
    const top = f.wb.create({ title: 'Top', kind: 'prompt', content: 'Top one', collection: 'Skills' });
    const trashed = f.wb.create({ title: 'Trashed', kind: 'prompt', content: 'In the trash', collection: 'Skills/Review' });
    f.wb.setMeta({ id: trashed.id, expect: trashed.revision, deleted: true });

    // A subfolder: its items join the parent and its own subfolders become the parent's.
    const result = f.wb.deleteCollection({ name: 'Skills/Review', confirm: true, items: 'keep' });
    assert.equal(result.to, 'Skills'); assert.deepEqual(result.trashed, []);
    assert.equal(f.wb.getItem(skill.id).collection, 'Skills');
    assert.equal(f.wb.getItem(skill.id).revision, skill.revision); assert.equal(f.wb.getItem(skill.id).status, 'approved', 'organising keeps approval');
    assert.equal(f.wb.getItem(deep.id).collection, 'Skills/Deep');
    assert.equal(f.wb.getItem(trashed.id).collection, 'Skills', 'trashed items move too, so restoring one cannot bring the collection back');
    assert.deepEqual(f.wb.collections(), ['Skills', 'Skills/Deep', 'Other', 'Review']);

    // A top-level collection: its own items become unfiled, subfolders go to the top level.
    f.wb.deleteCollection({ name: 'Skills', confirm: true, items: 'keep' });
    assert.equal(f.wb.getItem(skill.id).collection, ''); assert.equal(f.wb.getItem(top.id).collection, '');
    assert.equal(f.wb.getItem(skill.id).status, 'approved');
    assert.equal(f.wb.getItem(deep.id).collection, 'Deep');
    assert.deepEqual(f.wb.collections(), ['Deep', 'Other', 'Review'], 'unfiled is not a collection');
    assert.equal(f.wb.getItem(skill.id).deletedAt, null);

    // Nothing reads the moved items as externally edited.
    f.wb.refresh(); assert.equal(f.wb.getItem(skill.id).revision, skill.revision); assert.equal(f.wb.getItem(skill.id).status, 'approved');
    assert.equal(f.wb.detail(skill.id).revisions.length, 1);
  } finally { f.close(); }
});

test('moving items files them without a new revision; later edits, attachments and restores keep the new collection', () => {
  const f = fixture();
  try {
    f.wb.saveCollections({ names: ['Game Design'] });
    const skill = approved(f.wb);
    assert.deepEqual(f.wb.moveItems({ ids: [skill.id], collection: ' game design / Puzzles ' }), { collection: 'Game Design/Puzzles', moved: [skill.id] }, 'paths are trimmed and join the existing spelling');
    assert.equal(f.wb.getItem(skill.id).revision, skill.revision); assert.equal(f.wb.getItem(skill.id).status, 'approved');
    assert.equal(f.wb.getRevision(skill.id).collection, 'Personal', 'the revision keeps the collection it was saved in');
    assert.equal(f.wb.authoring(skill.id).collection, 'Game Design/Puzzles');
    assert.deepEqual(f.wb.moveItems({ ids: [skill.id], collection: 'Game Design/Puzzles' }).moved, [], 'already there');
    assert.ok(f.wb.activity().some(a => a.itemId === skill.id && a.kind === 'organised' && a.message === 'Moved from “Personal” to “Game Design/Puzzles”'));

    // An update that changes only the collection is a move too.
    const moved = f.wb.update({ id: skill.id, expect: skill.revision, value: { ...f.wb.authoring(skill.id), collection: 'Game Design' } });
    assert.equal(moved.revision, skill.revision); assert.equal(moved.status, 'approved'); assert.equal(f.wb.getItem(skill.id).collection, 'Game Design');

    // Saving unchanged values is not an edit, even though the revision names another collection.
    assert.equal(f.wb.update({ id: skill.id, expect: skill.revision, value: f.wb.authoring(skill.id) }).revision, skill.revision);

    const edited = f.wb.update({ id: skill.id, expect: skill.revision, summary: 'Edit', value: { ...f.wb.authoring(skill.id), content: content + '\nMore.' } });
    assert.notEqual(edited.revision, skill.revision); assert.equal(edited.collection, 'Game Design'); assert.equal(f.wb.getRevision(skill.id).collection, 'Game Design');
    f.wb.moveItems({ ids: [skill.id], collection: '' });
    const restored = f.wb.restore({ id: skill.id, expect: edited.revision, revision: skill.revision });
    assert.equal(restored.collection, '', 'restoring brings back the content, not the old folder');

    // External edits made after a move keep the item where it is.
    fs.writeFileSync(path.join(f.wb.itemDir(skill.id), 'content.md'), content + '\nEdited outside.');
    f.wb.refresh(); assert.equal(f.wb.getItem(skill.id).collection, '');

    assert.throws(() => f.wb.moveItems({ ids: [skill.id], collection: 'A//B' }), hasCode('INVALID_COLLECTION'));
  } finally { f.close(); }
});

test('collections form a tree: subfolders follow their parent, parents are implied, and renaming moves a whole branch', () => {
  const f = fixture();
  try {
    f.wb.saveCollections({ names: ['B', 'A'] });
    f.wb.create({ title: 'Deep', kind: 'prompt', content: 'One', collection: 'A/X/Y' });
    assert.deepEqual(f.wb.collections(), ['B', 'A', 'A/X', 'A/X/Y']);
    assert.deepEqual(f.wb.createCollection({ name: 'b/Sub' }).name, 'B/Sub', 'a subfolder joins its parent’s spelling');
    assert.deepEqual(f.wb.collections(), ['B', 'B/Sub', 'A', 'A/X', 'A/X/Y']);
    assert.throws(() => f.wb.createCollection({ name: 'a/x' }), hasCode('DUPLICATE_COLLECTION'));
    assert.throws(() => f.wb.createCollection({ name: ' / ' }), hasCode('INVALID_COLLECTION'));

    // Renaming to a path nests the collection; its subfolders and items travel with it.
    const result = f.wb.renameCollection({ from: 'A/X', to: 'B/X' });
    assert.equal(result.to, 'B/X');
    assert.deepEqual(f.wb.collections(), ['B', 'B/Sub', 'B/X', 'B/X/Y', 'A']);
    assert.equal(f.wb.listItems()[0].collection, 'B/X/Y');
    assert.throws(() => f.wb.renameCollection({ from: 'A', to: 'b/sub' }), hasCode('DUPLICATE_COLLECTION'));
    assert.throws(() => f.wb.renameCollection({ from: 'Missing', to: 'Other' }), hasCode('COLLECTION_NOT_FOUND'));
  } finally { f.close(); }
});

test('process lock prevents concurrent GUI/CLI mutation', () => {
  const f = fixture();
  try { withLock(f.wb.canonical, () => assert.throws(() => f.wb.create({ title: 'Locked', kind: 'prompt', content: 'No write' }), hasCode('LIBRARY_BUSY'))); assert.equal(f.wb.listItems().length, 0); }
  finally { f.close(); }
});

test('file reference paths stay private while authored labels survive export', () => {
  const f = fixture();
  let clone: Workbench | undefined;
  try {
    const source = path.join(f.root, 'private file.txt'); fs.writeFileSync(source, 'Private contents');
    const item = f.wb.importFile(source, 'reference');
    assert.equal(f.wb.referencePath(item.id), source);
    const exported = path.join(f.root, 'references.json'); f.wb.exportLibrary(exported);
    const text = fs.readFileSync(exported, 'utf8');
    assert.equal(text.includes(JSON.stringify(source).slice(1, -1)), false);
    assert.equal(text.includes('Private contents'), false);
    clone = new Workbench(path.join(f.root, 'clone'), path.join(f.root, 'clone-private'));
    clone.importLibrary(exported);
    assert.match(clone.getRevision(item.id).content, /private file.txt/);
    assert.throws(() => clone!.referencePath(item.id), hasCode('REFERENCE_MISSING'));
  } finally { clone?.close(); f.close(); }
});

test('legacy inbox status reads as captured and is rewritten on the next save', () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'Older capture', kind: 'prompt', content: 'Legacy item' });
    const file = path.join(f.wb.itemDir(item.id), 'item.json');
    const stored = () => (readJson(file) as { status: string }).status;
    writeJson(file, { ...(readJson(file) as Record<string, unknown>), status: 'inbox' });
    assert.equal(stored(), 'inbox');
    assert.equal(f.wb.getItem(item.id).status, 'captured');
    assert.equal(f.wb.listItems().find(i => i.id === item.id)?.status, 'captured');
    f.wb.setMeta({ id: item.id, expect: item.revision, favourite: true });
    assert.equal(stored(), 'captured');
  } finally { f.close(); }
});

test('archiving and undoing keeps an approved item approved, but metadata alone cannot grant approval', () => {
  const f = fixture();
  try {
    const item = approved(f.wb);
    assert.equal(f.wb.setMeta({ id: item.id, expect: item.revision, status: 'archived' }).status, 'archived');
    assert.equal(f.wb.setMeta({ id: item.id, expect: item.revision, status: 'approved' }).status, 'approved');
    const plain = f.wb.create({ title: 'Never approved', kind: 'prompt', content: 'Just text' });
    assert.throws(() => f.wb.setMeta({ id: plain.id, expect: plain.revision, status: 'approved' }), hasCode('APPROVAL_REQUIRED'));
    assert.equal(f.wb.setMeta({ id: plain.id, expect: plain.revision, status: 'archived' }).status, 'archived');
    assert.equal(f.wb.setMeta({ id: plain.id, expect: plain.revision, status: 'captured' }).status, 'captured');
  } finally { f.close(); }
});

test('renaming a collection moves every item, trashed ones included, without new revisions and keeps the sidebar order', () => {
  const f = fixture();
  try {
    f.wb.saveCollections({ names: ['Personal', 'Vendor · acme', 'Empty'] });
    const a = approved(f.wb); f.wb.moveItems({ ids: [a.id], collection: 'Vendor · acme' });
    const b = f.wb.create({ title: 'B', kind: 'prompt', content: 'Two', collection: 'Vendor · acme' });
    const kept = f.wb.create({ title: 'C', kind: 'prompt', content: 'Three', collection: 'Personal' });
    f.wb.setMeta({ id: b.id, expect: b.revision, deleted: true });
    const result = f.wb.renameCollection({ from: 'Vendor · acme', to: 'Acme skills' });
    assert.deepEqual(new Set(result.moved), new Set([a.id, b.id]));
    assert.equal(f.wb.getItem(a.id).collection, 'Acme skills');
    assert.equal(f.wb.getItem(a.id).revision, a.revision, 'the collection is organisation, not content');
    assert.equal(f.wb.getItem(a.id).status, 'approved');
    assert.ok(f.wb.activity().some(e => e.itemId === a.id && e.message === 'Moved from “Vendor · acme” to “Acme skills”'));
    assert.equal(f.wb.getItem(b.id).collection, 'Acme skills', 'trashed items move too');
    assert.equal(f.wb.getItem(kept.id).collection, 'Personal');
    assert.deepEqual(f.wb.collections(), ['Personal', 'Acme skills', 'Empty']);
    assert.throws(() => f.wb.renameCollection({ from: 'Personal', to: 'acme SKILLS' }), /already exists/);
    assert.throws(() => f.wb.renameCollection({ from: 'Empty', to: 'Empty' }), /different name/);
  } finally { f.close(); }
});

test('material distilled before sources existed becomes a source when the library opens; approved and plain items stay as they are', () => {
  const f = fixture();
  try {
    const pasted = f.wb.create({ title: 'Turn my interaction with AI into a prompt:', kind: 'prompt', content: 'A long chat transcript', collection: 'Ideas' });
    const entry = f.wb.createFrom({ id: pasted.id, revision: pasted.revision, author: 'Codex', item: { title: 'Design review', kind: 'technique', description: 'Compare options', content: '1. Compare.', files: {}, tags: [], collection: 'Design', source: '', licence: 'Unknown' } });
    const distilled = f.wb.update({ id: pasted.id, expect: pasted.revision, value: { ...f.wb.authoring(pasted.id), collection: 'Design', description: 'A chat about designs.' }, summary: 'Codex distilled 1 entries into “Design”' });
    f.wb.moveItems({ ids: [pasted.id], collection: 'Kept here' });
    const video = f.wb.create({ title: 'Talk', kind: 'link', content: 'https://www.youtube.com/watch?v=abc', tags: ['video', 'youtube'], files: { 'transcript.md': Buffer.from('Words').toString('base64') } });
    const approvedVideo = f.wb.create({ title: 'Approved talk', kind: 'link', content: 'https://www.youtube.com/watch?v=def', tags: ['youtube'], files: { 'transcript.md': Buffer.from('More words').toString('base64') } });
    f.wb.approve({ id: approvedVideo.id, revision: approvedVideo.revision, reviewer: 'Me', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });
    const plain = f.wb.create({ title: 'Plain prompt', kind: 'prompt', content: 'Review {{thing}}', description: 'Has a description but was never analysed' });
    const reopened = new Workbench(f.wb.root, path.join(f.root, 'private'));
    try {
      const source = reopened.getItem(pasted.id);
      assert.equal(source.kind, 'source'); assert.equal(reopened.getRevision(pasted.id).summary, 'Filed as source');
      assert.notEqual(source.revision, distilled.revision); assert.equal(source.collection, 'Kept here', 'filing as a source keeps where it was moved');
      assert.equal(reopened.getItem(entry.id).origin?.itemId, pasted.id); assert.deepEqual(reopened.madeFrom(pasted.id).map(i => i.id), [entry.id]);
      assert.equal(reopened.getItem(video.id).kind, 'source');
      assert.equal(reopened.getItem(approvedVideo.id).kind, 'link'); assert.equal(reopened.getItem(approvedVideo.id).status, 'approved', 'approval is never dropped by the tidy-up');
      assert.ok(reopened.warnings.some(w => w.includes('Approved talk')));
      assert.equal(reopened.getItem(plain.id).kind, 'prompt'); assert.equal(reopened.getItem(plain.id).revision, plain.revision);
      const checked = JSON.parse(fs.readFileSync(path.join(reopened.local, 'sources-checked.json'), 'utf8')) as string[];
      assert.ok(checked.includes(`${plain.id}:${plain.revision}`), 'a plain item is not scanned again on the next start');
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('analysis records travel with export and import and go with a purged source', () => {
  const f = fixture();
  try {
    const source = f.wb.create({ title: 'Pasted chat', kind: 'source', content: 'Chat text' });
    const record = { schemaVersion: 1 as const, id: randomUUID(), itemId: source.id, revision: source.revision, provider: 'codex' as const, model: 'gpt-test', effort: 'low', startedAt: '2026-09-26T10:00:00.000Z', finishedAt: '2026-09-26T10:01:00.000Z', summary: 'About designs.', takeaway: 'Compare.', skipped: '', counts: { technique: 1 }, created: [], collection: 'Design' };
    f.wb.recordAnalysis(record); f.wb.recordAnalysis({ ...record, summary: 'Changed' });
    assert.equal(f.wb.analyses(source.id)[0].summary, 'About designs.', 'a record is written once and never changes');
    assert.throws(() => f.wb.recordAnalysis({ ...record, id: randomUUID(), itemId: randomUUID() }), hasCode('ITEM_NOT_FOUND'));
    const file = path.join(f.root, 'export.json'); f.wb.exportLibrary(file);
    const clone = new Workbench(path.join(f.root, 'clone'), path.join(f.root, 'clone-private'));
    try { clone.importLibrary(file); assert.deepEqual(clone.analyses(source.id).map(a => a.summary), ['About designs.']); } finally { clone.close(); }
    f.wb.setMeta({ id: source.id, expect: source.revision, deleted: true }); f.wb.purge({ id: source.id, confirm: true });
    assert.deepEqual(f.wb.analyses(), []);
  } finally { f.close(); }
});

test('entries distilled before kinds existed are re-filed under their type when the library opens', () => {
  const f = fixture();
  try {
    const video = f.wb.create({ title: 'Video', kind: 'link', content: 'https://www.youtube.com/watch?v=abc', collection: 'Talks', tags: ['video', 'youtube'] });
    const entry = f.wb.createFrom({ id: video.id, revision: video.revision, author: 'Codex', item: { title: 'ccusage', kind: 'link', description: 'Usage CLI', content: 'https://example.com\n\nDetails', files: {}, tags: ['tool', 'usage'], collection: 'Talks', source: video.source, licence: 'Unknown' } });
    const prompt = f.wb.createFrom({ id: video.id, revision: video.revision, author: 'Codex', item: { title: 'Ask', kind: 'prompt', description: 'A prompt', content: 'Do {{x}}', files: {}, tags: ['prompt', 'usage'], collection: 'Talks', source: video.source, licence: 'Unknown' } });
    const plain = f.wb.create({ title: 'Hand-written tool note', kind: 'prompt', content: 'Not distilled', tags: ['tool'] });
    const reopened = new Workbench(f.wb.root, path.join(f.root, 'private'));
    try {
      assert.equal(reopened.getItem(entry.id).kind, 'tool'); assert.deepEqual(reopened.getItem(entry.id).tags, ['usage']);
      assert.equal(reopened.getRevision(entry.id).summary, 'Filed as tool');
      assert.equal(reopened.getItem(prompt.id).kind, 'prompt'); assert.equal(reopened.getItem(prompt.id).revision, prompt.revision, 'prompt entries are untouched');
      assert.equal(reopened.getItem(plain.id).kind, 'prompt', 'only items derived from another item are re-filed');
    } finally { reopened.close(); }
  } finally { f.close(); }
});
