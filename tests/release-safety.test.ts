import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService } from '../packages/deployment/service';
import { revisionHash } from '../packages/domain/content';
import { initialiseRepository } from '../packages/git/standard';
import { writeJson } from '../packages/storage/files';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-release-safety-'));
  const library = initialiseRepository({ parent: root, name: 'library' }).root;
  return { root, library, local: path.join(root, 'private') };
}
const approval = (item: { id: string; revision: string }) => ({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });

test('description edits create revisions; legacy hashes remain readable and the standalone validator supports agents and both hash versions', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const item = wb.create({ title: 'Description', kind: 'prompt', content: 'Text', description: 'Original' });
    const original = wb.getRevision(item.id), legacy = { ...original }; delete legacy.hashVersion; legacy.hash = revisionHash(legacy, 1);
    writeJson(path.join(wb.itemDir(item.id), 'revisions', `${legacy.hash}.json`), legacy);
    writeJson(path.join(wb.itemDir(item.id), 'item.json'), { ...item, revision: legacy.hash });
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getItem(item.id).revision, legacy.hash, 'opening does not invalidate legacy approvals');
    const changed = wb.update({ id: item.id, expect: legacy.hash, value: { ...legacy, description: 'Changed' } });
    assert.notEqual(changed.revision, legacy.hash); assert.equal(wb.getRevision(item.id).description, 'Changed');
    assert.equal(wb.getRevision(item.id, legacy.hash).description, 'Original');
    wb.create({ kind: 'agent', title: 'Reviewer', agent: { provider: 'claude', filename: 'reviewer.md' }, content: '---\nname: reviewer\ndescription: Review code\n---\nRead carefully.' });
    assert.match(execFileSync(process.execPath, ['.kiln/validate.mjs'], { cwd: f.library, encoding: 'utf8' }), /Validated 2 items/);
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a save interrupted before metadata commit recovers one complete revision including metadata and attachments', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  const rename = fs.renameSync;
  try {
    const item = wb.create({ title: 'Old title', kind: 'prompt', content: 'Old content', files: { 'old.txt': Buffer.from('old').toString('base64') } });
    const destination = path.join(wb.itemDir(item.id), 'item.json');
    fs.renameSync = ((from, to) => { if (String(to) === destination) throw new Error('Injected disk failure'); return rename(from, to); }) as typeof fs.renameSync;
    assert.throws(() => wb.update({ id: item.id, expect: item.revision, value: { ...wb.getRevision(item.id), title: 'New title', content: 'New content', files: { 'new.txt': Buffer.from('new').toString('base64') } } }), /Injected disk failure/);
    fs.renameSync = rename;
    wb.close(); wb = new Workbench(f.library, f.local);
    const current = wb.getRevision(item.id);
    assert.equal(wb.getItem(item.id).title, 'New title'); assert.equal(current.content, 'New content');
    assert.deepEqual(Object.keys(current.files), ['new.txt']); assert.equal(wb.getRevision(item.id, item.revision).content, 'Old content');
    assert.deepEqual(fs.readdirSync(path.join(wb.canonical, '.transactions')), []);
    assert.equal(wb.detail(item.id).revisions.length, 2, 'recovery does not invent a hybrid third revision');
  } finally { fs.renameSync = rename; wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('sync installs the approved snapshot on a fresh target and never approves the newer draft', () => {
  const f = fixture(), wb = new Workbench(f.library, f.local);
  try {
    const content = '---\nname: approved-skill\ndescription: Test skill\n---\nReviewed content';
    const item = wb.create({ title: 'Skill', kind: 'skill', content }); wb.approve(approval(item));
    const draft = wb.update({ id: item.id, expect: item.revision, value: { ...wb.getRevision(item.id), content: content + '\nUNREVIEWED' } });
    const target = path.join(f.root, 'target'); fs.mkdirSync(target);
    wb.enroll({ root: target, provider: 'codex', scope: 'personal', name: 'Fresh target' }); wb.setInstall(item.id, 'codex', true);
    const before = wb.approvals(); const report = new DeploymentService(wb).syncInstalls();
    assert.equal(report[0].result, 'installed approved revision'); assert.deepEqual(wb.approvals(), before);
    assert.equal(fs.readFileSync(path.join(target, '.agents/skills/approved-skill/SKILL.md'), 'utf8'), content);
    assert.equal(wb.getItem(item.id).revision, draft.revision); assert.equal(wb.getItem(item.id).status, 'captured');
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('legacy private sessions and paths are archived locally and excluded from decoded export histories', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const item = wb.create({ title: 'Legacy', kind: 'prompt', content: 'Public text' });
    const raw = { ...wb.getRevision(item.id), source: 'local:C:\\PRIVATE-USER\\secret\\SKILL.md', files: { 'session.jsonl': Buffer.from('PRIVATE-SESSION-SENTINEL').toString('base64') } };
    raw.hash = revisionHash(raw);
    writeJson(path.join(wb.itemDir(item.id), 'revisions', `${raw.hash}.json`), raw);
    writeJson(path.join(wb.itemDir(item.id), 'item.json'), { ...item, source: raw.source, revision: raw.hash });
    const files = path.join(wb.itemDir(item.id), 'files'); fs.writeFileSync(path.join(files, 'session.jsonl'), 'PRIVATE-SESSION-SENTINEL');
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getRevision(item.id).files['session.jsonl'], undefined);
    assert.equal(wb.getItem(item.id).source, 'local-import:SKILL.md');
    assert.equal(fs.existsSync(path.join(wb.itemDir(item.id), 'revisions', `${raw.hash}.json`)), false);
    assert.ok(wb.getRevision(item.id, raw.hash).files['session.jsonl'], 'original remains available privately');
    const output = path.join(f.root, 'export.json'); wb.exportLibrary(output);
    const exported = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.doesNotMatch(JSON.stringify(exported), /PRIVATE-USER|PRIVATE-SESSION-SENTINEL/);
    for (const entry of exported.items) for (const r of entry.revisions) {
      assert.equal(r.files['session.jsonl'], undefined); assert.equal(revisionHash(r), r.hash);
    }
    const restored = new Workbench(path.join(f.root, 'restored'), path.join(f.root, 'restore-private'));
    try { restored.importLibrary(output); assert.equal(restored.getRevision(item.id).content, 'Public text'); } finally { restored.close(); }
  } finally { wb.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
