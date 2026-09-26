import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../packages/domain/workbench';
import { AgentService } from '../packages/agent/service';
import { writeJson } from '../packages/storage/files';

const content = '---\nname: careful-review\ndescription: Review changes carefully.\n---\nRead the diff and verify claims.\n';
const longName = 'Research and development '.repeat(12).trim();
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-long-collections-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  return { root, wb, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('existing skills with long collection metadata load on another machine without altering approval or revisions', () => {
  const f = fixture();
  let other: Workbench | undefined;
  try {
    const skill = f.wb.create({ title: 'Careful review', kind: 'skill', content });
    f.wb.approve({ id: skill.id, revision: skill.revision, reviewer: 'Test', scope: 'Fixture', note: 'Reviewed', waivedChecks: 'Fixture' });
    // Older collection moves could write a path that the item reader then rejected.
    const itemFile = path.join(f.wb.canonical, 'items', skill.id, 'item.json');
    writeJson(itemFile, { ...f.wb.getItem(skill.id), collection: longName + '/Skills' });
    const before = fs.readFileSync(itemFile, 'utf8');
    other = new Workbench(f.wb.root, path.join(f.root, 'other-machine'));
    const snapshot = other.snapshot();
    assert.deepEqual(snapshot.warnings, []);
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].collection, longName + '/Skills');
    assert.equal(snapshot.items[0].status, 'approved');
    assert.equal(snapshot.items[0].revision, skill.revision);
    assert.equal(other.getRevision(skill.id).content, content);
    assert.equal(other.approvals()[0].revision, skill.revision);
    assert.equal(fs.readFileSync(itemFile, 'utf8'), before, 'loading must not rewrite or truncate collection metadata');
  } finally { other?.close(); f.close(); }
});

test('long collections support authoring, branch moves, reopening and export/import including analysis records', () => {
  const f = fixture();
  let clone: Workbench | undefined;
  try {
    const original = longName + '/Skills';
    const skill = f.wb.create({ title: 'Careful review', kind: 'skill', content, collection: original });
    assert.equal(f.wb.getRevision(skill.id).collection, original);
    f.wb.createCollection({ name: longName + ' empty' });
    f.wb.renameCollection({ from: longName, to: longName + ' renamed' });
    const renamed = longName + ' renamed/Skills';
    assert.equal(f.wb.getItem(skill.id).collection, renamed);
    f.wb.createCollection({ name: 'Parent' });
    f.wb.moveCollection({ name: longName + ' renamed', parent: 'Parent' });
    assert.equal(f.wb.getItem(skill.id).collection, 'Parent/' + renamed);
    f.wb.moveItems({ ids: [skill.id], collection: original });
    const edited = f.wb.update({ id: skill.id, expect: skill.revision, value: { ...f.wb.authoring(skill.id), content: content + '\nKeep evidence.\n' } });
    assert.equal(f.wb.getRevision(skill.id).collection, original);
    const record = { schemaVersion: 1 as const, id: randomUUID(), itemId: skill.id, revision: edited.revision, provider: 'codex' as const, model: 'test', effort: 'low', startedAt: '2026-09-26T10:00:00Z', finishedAt: '2026-09-26T10:01:00Z', summary: 'Reviewed', takeaway: 'Keep evidence', skipped: '', counts: {}, created: [], collection: original };
    f.wb.recordAnalysis(record);
    const exported = path.join(f.root, 'export.json');
    f.wb.exportLibrary(exported);
    clone = new Workbench(path.join(f.root, 'clone'), path.join(f.root, 'clone-private'));
    assert.equal(clone.importLibrary(exported).imported, 1);
    assert.equal(clone.getItem(skill.id).collection, original);
    assert.equal(clone.getRevision(skill.id).hash, edited.revision);
    assert.ok(clone.collections().includes(longName + ' empty'));
    assert.equal(clone.analyses(skill.id)[0].collection, original);
    clone.close();
    clone = new Workbench(path.join(f.root, 'clone'), path.join(f.root, 'clone-private'));
    assert.equal(clone.snapshot().items.length, 1);
    assert.deepEqual(clone.snapshot().warnings, []);
  } finally { clone?.close(); f.close(); }
});

test('distillation preserves long collection names and adds collision suffixes without truncation', async () => {
  const f = fixture();
  try {
    f.wb.createCollection({ name: longName });
    const service = new AgentService(f.wb, () => {}, async () => ({ collection: longName, summary: 'Reviewed material.', takeaway: 'Keep evidence.', skipped: '', entries: [{ type: 'technique', title: 'Review', description: 'Check changes.', content: 'Read the diff.', tags: [], url: '', timestamp: '' }] }), async () => []);
    const { item } = service.capture({ text: 'Review the changes and keep evidence.', files: {} });
    for (let i = 0; i < 100 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.running, 0);
    const done = service.list()[0];
    assert.equal(done.status, 'completed', done.error);
    const expected = longName + ' · ' + item.id.slice(0, 8);
    assert.equal(f.wb.getItem(item.id).collection, expected);
    assert.equal(f.wb.getItem(done.createdItemIds![0]).collection, expected);
    assert.equal(f.wb.analyses(item.id)[0].collection, expected);
  } finally { f.close(); }
});
