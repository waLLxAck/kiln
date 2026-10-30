import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../packages/domain/workbench';
import { LocalDiscovery } from '../apps/desktop/local-discovery';
import { DeploymentService } from '../packages/deployment/service';

const skill = (name: string) => `---\nname: ${name}\ndescription: Check changes carefully.\n---\nRead the diff.\n`;
function writeSkill(folder: string, name: string) {
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'SKILL.md'), skill(name));
  fs.writeFileSync(path.join(folder, 'reference.txt'), `Supporting files for ${name}`);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-discovery-')), home = path.join(root, 'home');
  fs.mkdirSync(home);
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  return { root, home, wb, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('discovery imports only enrolled locations, with full bundles, content deduplication and no approvals', () => {
  const f = fixture();
  const discovery = new LocalDiscovery(f.wb, () => {}, { watch: false });
  try {
    writeSkill(path.join(f.home, '.agents/skills/.system/review'), 'review');
    writeSkill(path.join(f.home, '.claude/skills/review'), 'review');
    writeSkill(path.join(f.home, '.copilot/skills/disabled'), 'disabled');
    fs.mkdirSync(path.join(f.home, '.claude/agents'), { recursive: true });
    fs.writeFileSync(path.join(f.home, '.claude/agents/helper.md'), '---\nname: helper\ndescription: Help review\n---\nRead.');
    assert.deepEqual(discovery.scan(true).imported, []);
    f.wb.enroll({ name: 'Agents', provider: 'codex', root: f.home, scope: 'personal' });
    const claude = f.wb.enroll({ name: 'Claude', provider: 'claude', root: f.home, scope: 'personal' });
    assert.equal(discovery.scan(true).imported.length, 2);
    const items = f.wb.listItems();
    assert.deepEqual(items.map(i => i.title).sort(), ['helper', 'review']);
    assert.ok(items.every(i => i.status === 'captured'));
    assert.deepEqual(f.wb.approvals(), []);
    const revision = f.wb.getRevision(items.find(i => i.kind === 'skill')!.id);
    assert.equal(Buffer.from(revision.files['reference.txt'], 'base64').toString(), 'Supporting files for review');
    assert.equal(fs.readFileSync(path.join(f.home, '.claude/skills/review/SKILL.md'), 'utf8'), skill('review'));
    assert.deepEqual(discovery.scan(true).imported, []);
    f.wb.removeTarget({ id: claude.id, confirm: true });
    writeSkill(path.join(f.home, '.claude/skills/after-disable'), 'after-disable');
    assert.deepEqual(discovery.scan(true).imported, []);
  } finally { discovery.close(); f.close(); }
});

test('handled paths are not reread or reimported after edits, purge, or restart', t => {
  const f = fixture(); let discovery = new LocalDiscovery(f.wb, () => {}, { watch: false });
  try {
    const folder = path.join(f.home, '.agents/skills/review'); writeSkill(folder, 'review');
    f.wb.enroll({ name: 'Agents', provider: 'codex', root: f.home, scope: 'personal' });
    const [id] = discovery.scan(true).imported;
    const revision = f.wb.getItem(id).revision;
    fs.appendFileSync(path.join(folder, 'SKILL.md'), '\nExternal edit');
    const original = fs.readFileSync;
    const reads: string[] = [];
    const probe = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
      reads.push(String(args[0])); return original(...args);
    });
    assert.deepEqual(discovery.scan(true).imported, []);
    probe.mock.restore();
    assert.equal(reads.some(file => file.startsWith(folder)), false, 'idle scans read no known skill bodies or supporting files');
    assert.equal(f.wb.getItem(id).revision, revision, 'external edits never overwrite the library');
    f.wb.setMeta({ id, expect: revision, deleted: true });
    f.wb.purge({ id, confirm: true });
    discovery.close(); discovery = new LocalDiscovery(f.wb, () => {}, { watch: false });
    assert.deepEqual(discovery.scan(true).imported, []);
    assert.deepEqual(f.wb.listItems(), []);
  } finally { discovery.close(); f.close(); }
});

test('previous manual imports are recognised through private provenance even after their content changes', () => {
  const f = fixture(), discovery = new LocalDiscovery(f.wb, () => {}, { watch: false });
  try {
    const folder = path.join(f.home, '.agents/skills/review'); writeSkill(folder, 'review');
    const item = f.wb.create({ kind: 'skill', title: 'My version', content: skill('edited-in-kiln'), source: `local:${folder}` });
    assert.equal(item.source, 'local-import:review', 'shared provenance contains no absolute source path');
    f.wb.enroll({ name: 'Agents', provider: 'codex', root: f.home, scope: 'personal' });
    assert.deepEqual(discovery.scan(true).imported, []);
    assert.equal(f.wb.listItems().length, 1);
    assert.equal(f.wb.getRevision(item.id).content, skill('edited-in-kiln'));
  } finally { discovery.close(); f.close(); }
});

test('installed copies edited before the first discovery scan remain attached to their existing item', () => {
  const f = fixture(), discovery = new LocalDiscovery(f.wb, () => {}, { watch: false });
  try {
    const target = f.wb.enroll({ name: 'Agents', provider: 'codex', root: f.home, scope: 'personal' });
    const item = f.wb.create({ kind: 'skill', title: 'Review', content: skill('review') });
    const deployment = new DeploymentService(f.wb);
    const result = deployment.installSkill({ itemId: item.id, targetId: target.id, confirm: true });
    fs.appendFileSync(path.join(result.destination, 'SKILL.md'), '\nEdited outside Kiln before discovery.');
    assert.deepEqual(discovery.scan(true).imported, []);
    assert.equal(f.wb.listItems().length, 1);
    assert.equal(f.wb.getRevision(item.id).content, skill('review'));
    assert.equal(deployment.installations(item.id)[0].state, 'drifted');
  } finally { discovery.close(); f.close(); }
});

test('watchers discover newly created roots and linked skills after writes settle', async () => {
  const f = fixture();
  let notify!: () => void;
  const found = new Promise<void>(resolve => { notify = resolve; });
  const discovery = new LocalDiscovery(f.wb, () => notify(), { debounceMs: 40, intervalMs: 60_000 });
  try {
    f.wb.enroll({ name: 'Agents', provider: 'codex', root: f.home, scope: 'personal' });
    discovery.scan(true); // No .agents folder exists yet; its ancestor must be watched.
    const shared = path.join(f.root, 'shared'); writeSkill(shared, 'linked');
    fs.mkdirSync(path.join(f.home, '.agents/skills'), { recursive: true });
    fs.symlinkSync(shared, path.join(f.home, '.agents/skills/linked'), 'junction');
    await found;
    assert.equal(f.wb.listItems()[0].title, 'linked');
    assert.deepEqual(discovery.scan(true).imported, []);
  } finally { discovery.close(); f.close(); }
});

test('fallback scans discover project agents when native watchers are unavailable', async () => {
  const f = fixture();
  let notify!: () => void;
  const found = new Promise<void>(resolve => { notify = resolve; });
  const discovery = new LocalDiscovery(f.wb, () => notify(), { watch: false, debounceMs: 10, intervalMs: 30 });
  try {
    f.wb.enroll({ name: 'Project', provider: 'copilot', root: f.home, scope: 'project' });
    discovery.scan(true);
    fs.mkdirSync(path.join(f.home, '.github/agents/nested'), { recursive: true });
    fs.writeFileSync(path.join(f.home, '.github/agents/nested/reviewer.agent.md'), '---\ndescription: Review carefully\n---\nCheck changes.');
    await found;
    assert.equal(f.wb.listItems()[0].agent?.provider, 'copilot');
  } finally { discovery.close(); f.close(); }
});

test('an unreadable candidate or dangling link does not block other skills; repaired candidates retry', () => {
  const f = fixture(), discovery = new LocalDiscovery(f.wb, () => {}, { watch: false });
  try {
    f.wb.enroll({ name: 'Claude', provider: 'claude', root: f.home, scope: 'personal' });
    const folder = path.join(f.home, '.claude/agents'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'large.md'), 'x'.repeat(2_000_001));
    writeSkill(path.join(f.home, '.claude/skills/good'), 'good');
    fs.symlinkSync(path.join(f.root, 'missing'), path.join(f.home, '.claude/skills/broken'), 'junction');
    assert.equal(discovery.scan(true).imported.length, 1);
    fs.writeFileSync(path.join(folder, 'large.md'), '---\nname: repaired\ndescription: Now readable\n---\nRead.');
    assert.equal(discovery.scan(true).imported.length, 1);
    assert.equal(f.wb.listItems().length, 2);
  } finally { discovery.close(); f.close(); }
});
