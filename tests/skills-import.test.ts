import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../packages/domain/workbench';
import { importLocalSkills, readSkillFolder, scanLocalSkills } from '../packages/domain/skills-import';
import { migrationPlan, applyMigration } from '../packages/git/migration';
import { inspectRepositoryFolder, initialiseRepository } from '../packages/git/standard';

const skill = (name: string) => `---\nname: ${name}\ndescription: Review a change for correctness and clear evidence.\n---\n\n# Procedure\nRead the diff. Verify claims.\n`;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln local skills '));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const home = path.join(root, 'home'); const claude = path.join(home, '.claude', 'skills'), agents = path.join(home, '.agents', 'skills');
  fs.mkdirSync(claude, { recursive: true }); fs.mkdirSync(agents, { recursive: true });
  return { root, wb, home, claude, agents, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const writeSkill = (folder: string, name: string, extra: Record<string, string> = {}) => { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'SKILL.md'), skill(name)); for (const [file, text] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true }); fs.writeFileSync(path.join(folder, file), text); } };

test('reading a skill folder follows junctions so linked shared files arrive, and stops on cycles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln linked '));
  try {
    const shared = path.join(root, 'shared'); fs.mkdirSync(shared); fs.writeFileSync(path.join(shared, 'guide.md'), 'Shared guidance');
    const folder = path.join(root, 'review'); writeSkill(folder, 'review', { 'scripts/check.py': 'print(1)' });
    fs.symlinkSync(shared, path.join(folder, 'references'), 'junction');
    fs.symlinkSync(folder, path.join(shared, 'loop'), 'junction');
    const files = readSkillFolder(folder);
    assert.deepEqual(Object.keys(files).sort(), ['SKILL.md', 'references/guide.md', 'scripts/check.py']);
    assert.equal(Buffer.from(files['references/guide.md'], 'base64').toString(), 'Shared guidance');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local scan lists each installed skill once across agent folders, marks what the library already has, and import creates drafts', () => {
  const f = fixture();
  try {
    writeSkill(path.join(f.claude, 'review'), 'review', { 'references/notes.md': 'notes' });
    writeSkill(path.join(f.agents, 'deploy'), 'deploy');
    fs.symlinkSync(path.join(f.claude, 'review'), path.join(f.agents, 'review'), 'junction');
    fs.mkdirSync(path.join(f.claude, 'not-a-skill'));
    fs.symlinkSync(path.join(f.root, 'gone'), path.join(f.claude, 'dangling'), 'junction');
    let scan = scanLocalSkills(f.wb, [f.claude, f.agents]);
    assert.deepEqual(scan.entries.map(e => e.name), ['dangling', 'deploy', 'not-a-skill', 'review'], 'the junction to review is not listed twice');
    assert.equal(scan.entries.find(e => e.name === 'dangling')!.error, 'The link points at a folder that no longer exists.');
    assert.equal(scan.entries.find(e => e.name === 'not-a-skill')!.hasSkillFile, false);
    assert.equal(scan.entries.find(e => e.name === 'review')!.fileCount, 2);
    assert.ok(scan.entries.every(e => !e.imported));
    const result = importLocalSkills(f.wb, { paths: [path.join(f.claude, 'review'), path.join(f.agents, 'deploy')], confirm: true });
    assert.equal(result.imported.length, 2); assert.equal(result.failed.length, 0);
    const items = f.wb.listItems(); assert.deepEqual(items.map(i => i.title).sort(), ['deploy', 'review']);
    assert.ok(items.every(i => i.status === 'captured' && i.kind === 'skill'), 'imports are drafts');
    assert.equal(f.wb.getRevision(items.find(i => i.title === 'review')!.id).files['references/notes.md'], Buffer.from('notes').toString('base64'));
    scan = scanLocalSkills(f.wb, [f.claude, f.agents]);
    assert.ok(scan.entries.filter(e => e.hasSkillFile).every(e => e.imported), 'a second scan shows both as already in the library');
    const again = importLocalSkills(f.wb, { paths: [path.join(f.agents, 'review')], confirm: true });
    assert.equal(again.unchanged.length, 1); assert.equal(f.wb.listItems().length, 2, 'identical content through another path is not duplicated');
  } finally { f.close(); }
});

test('repository import finds skills anywhere in the tree and brings linked files along', () => {
  const f = fixture();
  try {
    const source = path.join(f.root, 'skills-repo');
    writeSkill(path.join(source, 'mine', 'acme', 'review'), 'review');
    writeSkill(path.join(source, 'mine', 'notes'), 'notes');
    writeSkill(path.join(source, 'vendor', 'x', 'deploy'), 'deploy');
    fs.mkdirSync(path.join(source, 'shared')); fs.writeFileSync(path.join(source, 'shared', 'style.md'), 'style');
    fs.symlinkSync(path.join(source, 'shared'), path.join(source, 'mine', 'acme', 'review', 'shared'), 'junction');
    const plan = migrationPlan(f.wb.root, source);
    assert.equal(plan.count, 3); assert.equal(plan.importable, 3, plan.entries.map(e => e.error).join(', '));
    assert.equal(plan.entries.find(e => e.title === 'review')!.fileCount, 2);
    applyMigration(f.wb, plan.hash, source);
    const review = f.wb.listItems().find(i => i.title === 'review')!;
    assert.equal(f.wb.getRevision(review.id).files['shared/style.md'], Buffer.from('style').toString('base64'));
    assert.equal(review.collection, 'My skills · Acme');
    assert.equal(f.wb.listItems().find(i => i.title === 'notes')!.collection, 'My skills');
    assert.equal(f.wb.listItems().find(i => i.title === 'deploy')!.collection, 'Vendor · x');
  } finally { f.close(); }
});

test('inspecting a folder before creating tells apart nothing, a reusable Kiln repository and something else', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln inspect '));
  try {
    assert.equal(inspectRepositoryFolder({ parent: root, name: 'fresh' }).exists, false);
    initialiseRepository({ parent: root, name: 'prepared' });
    const prepared = inspectRepositoryFolder({ parent: root, name: 'prepared' });
    assert.deepEqual({ exists: prepared.exists, kiln: prepared.kiln, git: prepared.git, remote: prepared.remote, items: prepared.items }, { exists: true, kiln: true, git: true, remote: '', items: 0 });
    fs.mkdirSync(path.join(root, 'other')); fs.writeFileSync(path.join(root, 'other', 'notes.txt'), 'x');
    const other = inspectRepositoryFolder({ parent: root, name: 'other' });
    assert.equal(other.exists, true); assert.equal(other.kiln, false);
    const created = initialiseRepository({ parent: path.join(root, 'new parent'), name: 'lib' });
    assert.ok(created.committed, 'a missing parent folder is created');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
