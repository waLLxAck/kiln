import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService } from '../packages/deployment/service';
import { readJson, writeJson } from '../packages/storage/files';

test('interrupted directory switch is recovered to previous contents without guessing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln recovery '));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const deploy = new DeploymentService(wb);
  const targetRoot = path.join(root, 'target'); fs.mkdirSync(targetRoot);
  try {
    const target = wb.enroll({ name: 'Claude', provider: 'claude', scope: 'project', profile: 'Test', root: targetRoot });
    let item = wb.create({ title: 'Recoverable', kind: 'skill', content: '---\nname: recoverable\ndescription: Test recovery.\n---\nOriginal.' });
    const approve = () => wb.approve({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Test fixture', waivedChecks: 'No agent task in this test' });
    approve(); const p1 = deploy.plan({ itemId: item.id, revision: item.revision, targetId: target.id }); const r1 = deploy.apply({ planId: p1.id, expectState: null, confirm: true });
    item = wb.update({ id: item.id, expect: item.revision, summary: 'Updated', value: { ...wb.getRevision(item.id), content: '---\nname: recoverable\ndescription: Test recovery.\n---\nUpdated.' } }); approve();
    const p2 = deploy.plan({ itemId: item.id, revision: item.revision, targetId: target.id });
    const originalRename = fs.renameSync;
    fs.renameSync = ((from, to) => { if (String(from).includes('.kiln-stage-')) throw new Error('Simulated occupied destination / interrupted switch'); return originalRename(from, to); }) as typeof fs.renameSync;
    try { assert.throws(() => deploy.apply({ planId: p2.id, expectState: r1.hash, confirm: true }), /interrupted switch/); }
    finally { fs.renameSync = originalRename; }
    assert.equal(fs.existsSync(p2.destination), false);
    const recovered = deploy.recover(); assert.equal(recovered[0].status, 'restored previous state');
    assert.match(fs.readFileSync(path.join(p2.destination, 'SKILL.md'), 'utf8'), /Original/);
    assert.equal(deploy.recover().length, 0);
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('external bundled script edits invalidate approval without touching deployed files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln scripts '));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  try {
    const item = wb.create({ title: 'Script', kind: 'skill', content: '---\nname: script-test\ndescription: Test bundle integrity.\n---\nReview scripts before execution.', files: { 'scripts/check.py': Buffer.from('print("original")').toString('base64') } });
    wb.approve({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed bundle', waivedChecks: 'Integrity fixture' });
    fs.writeFileSync(path.join(wb.itemDir(item.id), 'files', 'scripts', 'check.py'), 'print("edited")'); wb.refresh();
    assert.notEqual(wb.getItem(item.id).revision, item.revision); assert.equal(wb.getItem(item.id).status, 'captured');
    assert.equal(Buffer.from(wb.getRevision(item.id, item.revision).files['scripts/check.py'], 'base64').toString(), 'print("original")');
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('restored approvals and provenance survive export but cannot silently authorize installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln restored trust '));
  const wb = new Workbench(path.join(root, 'source'), path.join(root, 'private'));
  const clone = new Workbench(path.join(root, 'clone'), path.join(root, 'private'));
  try {
    const item = wb.create({ title: 'Restored', kind: 'skill', content: '---\nname: restored\ndescription: Import trust check.\n---\nSafe fixture.' });
    wb.approve({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Test' });
    const exported = path.join(root, 'export.json'); wb.exportLibrary(exported); clone.importLibrary(exported);
    assert.equal(clone.approvals()[0].trust, 'imported'); assert.ok(clone.activity().some(e => e.kind === 'captured'));
    const targetRoot = path.join(root, 'target'); fs.mkdirSync(targetRoot);
    const target = clone.enroll({ name: 'Codex', provider: 'codex', scope: 'personal', profile: 'Test', root: targetRoot });
    assert.throws(() => new DeploymentService(clone).plan({ itemId: item.id, revision: item.revision, targetId: target.id }), /Imported approval records/);
  } finally { wb.close(); clone.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
