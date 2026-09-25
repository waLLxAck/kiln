import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService, readDestination } from '../packages/deployment/service';
import { WorkbenchError } from '../packages/domain/errors';
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
    assert.throws(() => f.wb.prepareTrial({ id: item.id, revision: item.revision, provider: 'codex', task: 'Task', rubric: ['Factual'], case: 'typical' }), hasCode('MISSING_VARIABLES'));
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

test('deleting a collection trashes its items and drops the name; restoring an item brings the collection back', () => {
  const f = fixture();
  try {
    f.wb.saveCollections({ names: ['Personal', 'Scratch', 'Empty'] });
    const kept = f.wb.create({ title: 'Kept', kind: 'prompt', content: 'Stays', collection: 'Personal' });
    const gone = f.wb.create({ title: 'Gone', kind: 'prompt', content: 'Goes', collection: 'Scratch' });
    assert.deepEqual(f.wb.deleteCollection({ name: 'Scratch', confirm: true }), { name: 'Scratch', trashed: [gone.id] });
    assert.ok(!f.wb.collections().includes('Scratch')); assert.ok(f.wb.collections().includes('Empty'));
    assert.ok(f.wb.getItem(gone.id).deletedAt); assert.equal(f.wb.getItem(gone.id).revision, gone.revision, 'trashing does not create a revision');
    assert.equal(f.wb.getItem(kept.id).deletedAt, null);
    assert.deepEqual(f.wb.deleteCollection({ name: 'Empty', confirm: true }), { name: 'Empty', trashed: [] });
    assert.ok(!f.wb.collections().includes('Empty'));
    assert.throws(() => f.wb.deleteCollection({ name: 'Personal' }), 'deleting needs an explicit confirm');
    f.wb.setMeta({ id: gone.id, expect: gone.revision, deleted: false });
    assert.ok(f.wb.collections().includes('Scratch'), 'a restored item brings its collection back');
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

test('renaming a collection moves every item, trashed ones included, as new revisions and keeps the sidebar order', () => {
  const f = fixture();
  try {
    f.wb.saveCollections({ names: ['Personal', 'Vendor · acme', 'Empty'] });
    const a = f.wb.create({ title: 'A', kind: 'prompt', content: 'One', collection: 'Vendor · acme' });
    const b = f.wb.create({ title: 'B', kind: 'prompt', content: 'Two', collection: 'Vendor · acme' });
    const kept = f.wb.create({ title: 'C', kind: 'prompt', content: 'Three', collection: 'Personal' });
    f.wb.setMeta({ id: b.id, expect: b.revision, deleted: true });
    const result = f.wb.renameCollection({ from: 'Vendor · acme', to: 'Acme skills' });
    assert.deepEqual(new Set(result.moved), new Set([a.id, b.id]));
    assert.equal(f.wb.getItem(a.id).collection, 'Acme skills'); assert.notEqual(f.wb.getItem(a.id).revision, a.revision, 'the collection is part of the revision');
    assert.equal(f.wb.getRevision(a.id).summary, 'Moved from “Vendor · acme” to “Acme skills”');
    assert.equal(f.wb.getItem(b.id).collection, 'Acme skills', 'trashed items move too');
    assert.equal(f.wb.getItem(kept.id).collection, 'Personal');
    assert.deepEqual(f.wb.collections(), ['Personal', 'Acme skills', 'Empty']);
    assert.throws(() => f.wb.renameCollection({ from: 'Personal', to: 'acme SKILLS' }), /already exists/);
    assert.throws(() => f.wb.renameCollection({ from: 'Empty', to: 'Empty' }), /different name/);
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
