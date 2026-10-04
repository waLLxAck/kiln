import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { DeploymentService } from '../packages/deployment/service';
import { WorkbenchError } from '../packages/domain/errors';
import { defaultTags, duplicateGroups, nameKey, signature, similarity, sketch } from '../packages/domain/duplicates';
import { initialiseRepository } from '../packages/git/standard';
import type { Item } from '../packages/protocol/schema';

process.env.KILN_ORGANISE_DELAY_MS = '20';
const body = 'Spin up a background agent to do the research, so you keep working while it reads. Investigate the question against primary sources: official docs, source code, specs and first-party APIs. Write the findings to a single Markdown file, citing each claim\'s source. Save it where the repo already keeps such notes.';
const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: Investigate a question against high-trust primary sources.\n---\n\n${body}${extra}\n`;
const hasCode = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.code === code;
const approveArgs = (item: { id: string; revision: string }) => ({ id: item.id, revision: item.revision, reviewer: 'Human', scope: 'Test', note: 'Reviewed', waivedChecks: 'Fixture' });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln consolidate '));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const router = new Router(wb, { composer: null, describer: null });
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const target = wb.enroll({ name: 'Claude skills', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
  return { root, wb, router, target, deployment: new DeploymentService(wb), close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const group = (wb: Workbench, id: string) => wb.snapshot().duplicates.find(g => g.ids.includes(id));

test('names compare without case, punctuation or the "(1)" and "copy" of duplicated folders', () => {
  assert.equal(nameKey('Code Review'), 'code-review');
  assert.equal(nameKey('code-review (1)'), 'code-review');
  assert.equal(nameKey('code_review copy 2'), 'code-review');
  assert.equal(nameKey('Research - Copy'), 'research');
  assert.notEqual(nameKey('research-notes'), nameKey('research'));
});

test('text similarity is 1 for the same text, high for a small edit and low for unrelated text', () => {
  assert.equal(similarity(sketch(body), sketch(body)), 1);
  assert.ok(similarity(sketch(body), sketch(`${body} Say where you saved it.`)) > 0.7);
  assert.ok(similarity(sketch(body), sketch('Summarise the pull request in three bullet points for the release notes, then list risks.')) < 0.2);
});

test('detection groups identical copies, the same text with other files, and same-named near copies; not different skills', () => {
  const f = fixture();
  try {
    const a = f.wb.create({ title: 'research', kind: 'skill', content: skill('research'), collection: 'Development' });
    const b = f.wb.create({ title: 'research', kind: 'skill', content: skill('research'), files: { 'agents/openai.yaml': Buffer.from('model: x').toString('base64') }, collection: '' });
    const c = f.wb.create({ title: 'research (1)', kind: 'skill', content: skill('research', ' Say where you saved it.') });
    const other = f.wb.create({ title: 'research', kind: 'prompt', content: skill('research') });
    const unrelated = f.wb.create({ title: 'research', kind: 'skill', content: '---\nname: research\ndescription: Something else.\n---\n\nPlan a birthday party with a budget, a guest list and a playlist for the evening.\n' });
    const shelved = f.wb.create({ title: 'research', kind: 'skill', content: skill('research') });
    f.wb.setMeta({ id: shelved.id, expect: shelved.revision, status: 'archived' });
    const groups = f.wb.snapshot().duplicates;
    assert.equal(groups.length, 1, JSON.stringify(groups));
    assert.deepEqual([...groups[0].ids].sort(), [a.id, b.id, c.id].sort());
    assert.equal(groups[0].match, 'similar', 'the loosest link names the group');
    assert.ok(groups[0].similarity >= 0.5 && groups[0].similarity < 1);
    for (const id of [other.id, unrelated.id, shelved.id]) assert.ok(!groups[0].ids.includes(id), 'other kinds, other text and archived items stay out');
    assert.deepEqual(f.wb.detail(a.id).duplicates.map(i => i.id).sort(), [b.id, c.id].sort(), 'the item page lists the other copies');
    // Short placeholder texts (imported files) are only copies when their files match too.
    const x = f.wb.create({ title: 'photo.png', kind: 'image', content: 'Imported photo.png', files: { 'assets/photo.png': 'AAAA' } });
    const y = f.wb.create({ title: 'photo.png', kind: 'image', content: 'Imported photo.png', files: { 'assets/photo.png': 'BBBB' } });
    const z = f.wb.create({ title: 'another.png', kind: 'image', content: 'Imported photo.png', files: { 'assets/photo.png': 'AAAA' } });
    const images = f.wb.snapshot().duplicates.find(g => g.ids.includes(x.id));
    assert.deepEqual(images?.ids.sort(), [x.id, z.id].sort(), 'the same file under another title is a copy; another file under the same title is not');
    assert.equal(images?.match, 'identical');
    assert.ok(!f.wb.snapshot().duplicates.some(g => g.ids.includes(y.id)));
  } finally { f.close(); }
});

test('pure grouping links copies through a shared member and skips pairs marked distinct', () => {
  const at = (n: number) => `2026-09-2${n}T10:00:00.000Z`;
  const item = (id: string, n: number) => ({ id, kind: 'skill', status: 'captured', deletedAt: null, createdAt: at(n) }) as Item;
  const items = [item('a', 1), item('b', 2), item('c', 3)];
  const sig = (text: string, title: string) => signature({ content: text, files: {}, title, kind: 'skill' });
  const signatures = new Map([['a', sig(body, 'alpha')], ['b', sig(body, 'research')], ['c', sig(`${body} Extra.`, 'research')]]);
  assert.deepEqual(duplicateGroups(items, signatures)[0].ids, ['a', 'b', 'c'], 'a and c are linked through b, oldest first');
  assert.deepEqual(duplicateGroups(items, signatures, new Set(['a:b']))[0].ids, ['b', 'c']);
  assert.equal(duplicateGroups(items, signatures, new Set(['a:b', 'b:c'])).length, 0);
  assert.deepEqual(defaultTags({ tags: ['x'] }, [{ tags: ['y', 'x'] }], false), ['x', 'y'], 'every tag together');
  assert.deepEqual(defaultTags({ tags: ['x'] }, [{ tags: ['y'] }], true), ['x'], 'an approved kept item keeps its own tags');
});

test('consolidating keeps one copy, takes the chosen text, unions tags and moves the others to Trash as merged', () => {
  const f = fixture();
  try {
    const kept = f.wb.create({ title: 'research', kind: 'skill', content: skill('research'), tags: ['research'], collection: 'Development' });
    const newer = f.wb.create({ title: 'research', kind: 'skill', content: skill('research', ' Say where you saved it.'), files: { 'agents/openai.yaml': Buffer.from('model: x').toString('base64') }, tags: ['agents'], collection: 'Imported skills' });
    f.wb.setMeta({ id: newer.id, expect: newer.revision, favourite: true });
    f.wb.observe({ schemaVersion: 1, eventId: 'copy-1', itemId: newer.id, revision: newer.revision, kind: 'copied', source: 'kiln', confidence: 'observed', occurredAt: new Date().toISOString() });
    f.wb.setInstall(newer.id, 'claude', true); f.wb.setInstall(kept.id, 'codex', true);
    const result = f.router.call('items.consolidate', { keep: kept.id, expect: kept.revision, merge: [{ id: newer.id, expect: newer.revision }], content: newer.id }) as { kept: Item; revised: boolean; undo: unknown };
    assert.equal(result.revised, true);
    const item = f.wb.getItem(kept.id), revision = f.wb.getRevision(kept.id);
    assert.equal(revision.content, skill('research', ' Say where you saved it.'), 'the chosen copy’s text');
    assert.deepEqual(Object.keys(revision.files), ['agents/openai.yaml'], 'with its bundled files');
    assert.deepEqual(item.tags, ['research', 'agents'], 'tags of both copies');
    assert.equal(item.collection, 'Development', 'the kept item’s collection by default');
    assert.equal(item.status, 'captured', 'a new draft revision');
    assert.match(revision.summary, /^Consolidated from “research”/);
    assert.equal(item.favourite, true, 'the favourite is absorbed');
    const merged = f.wb.getItem(newer.id);
    assert.ok(merged.deletedAt); assert.equal(merged.mergedInto, kept.id);
    const snapshot = f.wb.snapshot();
    assert.equal(snapshot.usage[kept.id]?.copied, 1, 'use of the merged copy counts for the kept one');
    assert.equal(snapshot.usage[kept.id]?.lastUsed, snapshot.usage[newer.id]?.lastUsed, 'the merged copy carries its latest use into the kept item');
    assert.deepEqual(snapshot.installs[kept.id], ['claude', 'codex'], 'desired installs move to the kept item');
    assert.equal(snapshot.installs[newer.id], undefined);
    assert.equal(snapshot.duplicates.length, 0, 'the group is gone');
    assert.equal(f.wb.approvals().length, 0, 'nothing was approved');
    assert.equal(f.wb.detail(kept.id).observations.length, 1, 'the item page counts the merged copy’s use too');
    // Restoring a merged copy makes it its own item again.
    f.wb.setMeta({ id: newer.id, expect: merged.revision, deleted: false });
    assert.equal(f.wb.getItem(newer.id).mergedInto, undefined);
  } finally { f.close(); }
});

test('an approved kept item keeps its approval, tags and revision unless its text is replaced', () => {
  const f = fixture();
  try {
    const kept = f.wb.create({ title: 'research', kind: 'skill', content: skill('research'), tags: ['research'] });
    f.wb.approve(approveArgs(kept));
    const copy = f.wb.create({ title: 'research', kind: 'skill', content: skill('research'), tags: ['imported'], collection: 'Imported skills' });
    const trial = f.wb.prepareTrial({ id: copy.id, revision: copy.revision, provider: 'manual', task: 'Try it', rubric: ['Works'], case: 'typical' }).trial;
    const result = f.wb.consolidate({ keep: kept.id, expect: kept.revision, merge: [{ id: copy.id, expect: f.wb.getItem(copy.id).revision }] });
    assert.equal(result.revised, false, 'same text and the kept tags: no new revision');
    assert.equal(f.wb.getItem(kept.id).status, 'approved');
    assert.deepEqual(f.wb.getItem(kept.id).tags, ['research']);
    assert.equal(f.wb.approvals().length, 1, 'no approval created');
    assert.equal(f.wb.trials().find(t => t.id === trial.id)?.itemId, copy.id, 'tests stay with their own item');
  } finally { f.close(); }
});

test('consolidation refuses a copy that changed since, other kinds, and items already in the trash', () => {
  const f = fixture();
  try {
    const a = f.wb.create({ title: 'research', kind: 'skill', content: skill('research') });
    const b = f.wb.create({ title: 'research', kind: 'skill', content: skill('research', ' More.') });
    const stale = b.revision;
    f.wb.update({ id: b.id, expect: b.revision, summary: 'Edited', value: { ...f.wb.authoring(b.id), content: skill('research', ' Changed.') } });
    assert.throws(() => f.wb.consolidate({ keep: a.id, expect: a.revision, merge: [{ id: b.id, expect: stale }] }), hasCode('REVISION_CONFLICT'));
    const prompt = f.wb.create({ title: 'research', kind: 'prompt', content: skill('research') });
    assert.throws(() => f.wb.consolidate({ keep: a.id, expect: a.revision, merge: [{ id: prompt.id, expect: prompt.revision }] }), hasCode('NOT_DUPLICATES'));
    assert.throws(() => f.wb.consolidate({ keep: a.id, expect: a.revision, merge: [{ id: a.id, expect: a.revision }] }), hasCode('INVALID_INPUT'));
    const current = f.wb.getItem(b.id);
    f.wb.setMeta({ id: b.id, expect: current.revision, deleted: true });
    assert.throws(() => f.wb.consolidate({ keep: a.id, expect: a.revision, merge: [{ id: b.id, expect: current.revision }] }), hasCode('ITEM_DELETED'));
    assert.equal(f.wb.getItem(a.id).revision, a.revision, 'nothing changed');
  } finally { f.close(); }
});

test('undo puts the kept item back on its approved revision and restores the merged copies with their installs', () => {
  const f = fixture();
  try {
    const kept = f.wb.create({ title: 'research', kind: 'skill', content: skill('research'), tags: ['research'] });
    f.wb.approve(approveArgs(kept));
    const copy = f.wb.create({ title: 'research', kind: 'skill', content: skill('research', ' Newer.'), tags: ['agents'] });
    f.wb.setInstall(copy.id, 'claude', true);
    const result = f.router.call('items.consolidate', { keep: kept.id, expect: kept.revision, merge: [{ id: copy.id, expect: copy.revision }], content: copy.id, tags: ['research', 'agents'] }) as { undo: Record<string, unknown> };
    assert.notEqual(f.wb.getItem(kept.id).revision, kept.revision);
    const undone = f.router.call('items.unconsolidate', result.undo) as { restored: string[] };
    assert.deepEqual(undone.restored, [copy.id]);
    const back = f.wb.getItem(kept.id);
    assert.equal(back.revision, kept.revision, 'the same revision hash as before');
    assert.equal(back.status, 'approved', 'so its approval applies again');
    assert.deepEqual(back.tags, ['research']);
    const restored = f.wb.getItem(copy.id);
    assert.equal(restored.deletedAt, null); assert.equal(restored.mergedInto, undefined);
    assert.deepEqual(f.wb.installs(), { [copy.id]: ['claude'] });
    assert.throws(() => f.router.call('items.unconsolidate', result.undo), hasCode('REVISION_CONFLICT'), 'only once, while nothing changed since');
  } finally { f.close(); }
});

test('not duplicates: marked pairs drop out of detection and can be marked again', () => {
  const f = fixture();
  try {
    const a = f.wb.create({ title: 'research', kind: 'skill', content: skill('research') });
    const b = f.wb.create({ title: 'research', kind: 'skill', content: skill('research', ' Different enough? No, similar.') });
    assert.ok(group(f.wb, a.id));
    f.router.call('items.distinct', { ids: [a.id, b.id] });
    assert.equal(group(f.wb, a.id), undefined);
    assert.equal(f.wb.detail(a.id).duplicates.length, 0, 'the banner goes too');
    const stored = JSON.parse(fs.readFileSync(path.join(f.wb.canonical, 'distinct.json'), 'utf8'));
    assert.deepEqual(stored.pairs, [[a.id, b.id].sort()]);
    f.router.call('items.distinct', { ids: [a.id, b.id], distinct: false });
    assert.ok(group(f.wb, a.id));
    assert.throws(() => f.router.call('items.distinct', { ids: [a.id, a.id] }), hasCode('INVALID_INPUT'));
  } finally { f.close(); }
});

test('a copy Kiln installed for a merged item becomes the kept item’s, so the usual update replaces it safely', () => {
  const f = fixture();
  try {
    const old = f.wb.create({ title: 'research', kind: 'skill', content: skill('research') });
    f.wb.approve(approveArgs(old));
    f.deployment.installSkill({ itemId: old.id, targetId: f.target.id, confirm: true });
    const kept = f.wb.create({ title: 'research', kind: 'skill', content: skill('research', ' Newer.') });
    f.wb.approve(approveArgs(kept));
    assert.equal(f.deployment.installations(kept.id)[0].state, 'external', 'before: another item’s copy');
    f.wb.consolidate({ keep: kept.id, expect: kept.revision, merge: [{ id: old.id, expect: f.wb.getItem(old.id).revision }] });
    const copy = f.deployment.installations(kept.id).find(c => c.targetId === f.target.id)!;
    assert.equal(copy.state, 'installed'); assert.equal(copy.outdated, true, 'an older version the kept item can update');
    const result = f.deployment.updateInstalls({ itemId: kept.id });
    assert.equal(result.updated.length, 1, JSON.stringify(result.skipped));
    assert.equal(fs.readFileSync(path.join(copy.destination, 'SKILL.md'), 'utf8'), skill('research', ' Newer.'));
    // A copy edited outside Kiln is never replaced by the update.
    fs.appendFileSync(path.join(copy.destination, 'SKILL.md'), 'hand edit\n');
    assert.equal(f.deployment.installations(kept.id)[0].state, 'drifted');
  } finally { f.close(); }
});

const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
test('a merge of published copies and the not-duplicates list reach the other machine with the background sync', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln consolidate sync '));
  const created = initialiseRepository({ parent: root, name: 'library' }); assert.ok(created.committed, created.message);
  const origin = path.join(root, 'origin.git'); execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  run(created.root, 'config', 'core.autocrlf', 'false'); run(created.root, 'remote', 'add', 'origin', origin); run(created.root, 'push', '-u', 'origin', 'HEAD');
  const wb = new Workbench(created.root, path.join(root, 'private-a')), router = new Router(wb, { composer: null, describer: null });
  const other = path.join(root, 'other');
  let second: Workbench | undefined;
  try {
    const publish = async (content: string) => { const item = wb.create({ title: 'research', kind: 'skill', content }); router.approve(approveArgs(item)); await router.publisher.idle(); return wb.getItem(item.id); };
    const kept = await publish(skill('research')), copy = await publish(skill('research', ' Newer.')), third = await publish(skill('research', ' Other.'));
    router.call('items.distinct', { ids: [kept.id, third.id] });
    router.call('items.distinct', { ids: [copy.id, third.id] });
    router.call('items.consolidate', { keep: kept.id, expect: kept.revision, merge: [{ id: copy.id, expect: copy.revision }] });
    router.flushOrganisation(); await router.publisher.idle();
    const job = router.publisher.list().find(j => j.action === 'organise'); assert.equal(job?.status, 'done', job?.error);
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, other], { windowsHide: true });
    second = new Workbench(other, path.join(root, 'private-b'));
    const merged = second.getItem(copy.id);
    assert.ok(merged.deletedAt); assert.equal(merged.mergedInto, kept.id);
    assert.equal(second.snapshot().duplicates.length, 0, 'the third copy stays apart on the other machine too');
  } finally { second?.close(); wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
