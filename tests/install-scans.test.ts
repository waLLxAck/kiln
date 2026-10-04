import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { HomeFiles } from '../packages/home/service';
import { locationFolder, type SkillLocation } from '../packages/providers/skill-locations';
import type { Installation, Snapshot } from '../packages/protocol/schema';

// The installations list on a busy machine: copies found from folder listings, hashed only when they change, links never walked
// into a checkout, and a cheap stamp that tells the desktop when the list may have changed.
const skill = (name: string, body = 'Do it carefully.') => `---\nname: ${name}\ndescription: Does ${name} with clear evidence.\n---\n\n# Procedure\n${body}\n`;
const locations: SkillLocation[] = ['agents', 'claude', 'codex', 'copilot'];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-install-scans-'));
  const home = path.join(root, 'home'), project = path.join(root, 'work', 'shop');
  for (const folder of [home, project]) fs.mkdirSync(folder, { recursive: true });
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const router = new Router(wb, { composer: null, home: new HomeFiles({ home, privateRoot: path.join(root, 'private-home'), env: {} }) });
  const enroll = (provider: 'codex' | 'claude' | 'copilot', at: string, scope: 'personal' | 'project', skillFolder?: '.codex/skills') => wb.enroll({ name: `${provider} ${scope}`, root: at, provider, scope, profile: 'Personal', ...(skillFolder ? { skillFolder } : {}) });
  const targets = { codex: enroll('codex', home, 'personal'), claude: enroll('claude', home, 'personal'), copilot: enroll('copilot', home, 'personal'), native: enroll('codex', home, 'personal', '.codex/skills'), shop: enroll('claude', project, 'project') };
  const create = (name: string, body?: string) => { const item = wb.create({ title: name, kind: 'skill', content: skill(name, body) }); wb.approve({ id: item.id, revision: item.revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' }); return item; };
  const install = (itemId: string, targetId: string) => router.call('skills.install', { itemId, targetId, confirm: true });
  const installations = () => router.call('deploy.installations') as Installation[];
  const snapshot = () => router.call('snapshot') as Snapshot;
  return { root, home, project, wb, router, targets, create, install, installations, snapshot, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const key = (c: Installation) => `${c.itemId} ${c.destination} ${c.state} linked=${c.linked} matches=${c.matches}`;
/** Counts fs calls by name while `action` runs, and the paths they were given. */
function counting<T>(action: () => T) {
  const names = ['lstatSync', 'statSync', 'readdirSync', 'readFileSync', 'existsSync', 'realpathSync'] as const, calls: { name: string; file: string }[] = [];
  const originals = names.map(name => [name, fs[name]] as const);
  for (const [name, original] of originals) (fs as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) { calls.push({ name, file: String(args[0]) }); return (original as (...a: unknown[]) => unknown).apply(this, args); };
  try { return { result: action(), calls }; } finally { for (const [name, original] of originals) (fs as unknown as Record<string, unknown>)[name] = original; }
}
/** Sets every modification time below `folders` to `past`, so nothing counts as "just changed" (RACY_MS). */
function settle(past: Date, ...folders: string[]) {
  const visit = (file: string) => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false }); if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    fs.utimesSync(file, past, past);
  };
  for (const folder of folders) visit(folder);
}

test('installations finds every copy a probe of each path would, from one listing per folder', () => {
  const f = fixture();
  try {
    const review = f.create('careful-review'), deploy = f.create('safe-deploy'), notes = f.create('field-notes');
    f.install(review.id, f.targets.codex.id); f.install(review.id, f.targets.shop.id); f.install(deploy.id, f.targets.native.id);
    // Copies Kiln did not write: an identical one, a different one, a link to the installed one, and an unrelated folder.
    const external = path.join(f.home, '.copilot', 'skills', 'field-notes'); fs.mkdirSync(external, { recursive: true }); fs.writeFileSync(path.join(external, 'SKILL.md'), skill('field-notes'));
    const differs = path.join(f.project, '.agents', 'skills', 'safe-deploy'); fs.mkdirSync(differs, { recursive: true }); fs.writeFileSync(path.join(differs, 'SKILL.md'), skill('safe-deploy', 'Something else.'));
    fs.mkdirSync(path.join(f.home, '.claude', 'skills', 'unrelated'), { recursive: true });
    fs.symlinkSync(path.join(f.home, '.agents', 'skills', 'careful-review'), path.join(f.home, '.claude', 'skills', 'careful-review'), 'junction');

    const { result, calls } = counting(f.installations);
    // What probing every candidate path with lstat (the old way) finds: each skill under all four locations of every root.
    const expected: string[] = [];
    for (const item of [review, deploy, notes]) for (const root of [f.home, f.project]) for (const location of locations) {
      const destination = path.join(root, locationFolder(location, root === f.project ? 'project' : 'personal'), item.title);
      if (fs.lstatSync(destination, { throwIfNoEntry: false })) expected.push(`${item.id} ${destination}`);
    }
    assert.deepEqual(result.map(c => `${c.itemId} ${c.destination}`).sort(), expected.sort());
    assert.deepEqual(result.map(key).sort(), [
      `${review.id} ${path.join(f.home, '.agents', 'skills', 'careful-review')} installed linked=false matches=true`,
      `${review.id} ${path.join(f.home, '.claude', 'skills', 'careful-review')} external linked=true matches=true`,
      `${review.id} ${path.join(f.project, '.claude', 'skills', 'careful-review')} installed linked=false matches=true`,
      `${deploy.id} ${path.join(f.home, '.codex', 'skills', 'safe-deploy')} installed linked=false matches=true`,
      `${deploy.id} ${differs} external linked=false matches=false`,
      `${notes.id} ${external} external linked=false matches=true`,
    ].sort());
    // Paths that do not exist are never probed one by one; the link is asked about once, by lstat.
    const probed = calls.filter(c => c.name === 'lstatSync' && /[\\/]\.(agents|claude|codex|copilot|github)[\\/]skills[\\/][^\\/]+$/.test(c.file));
    assert.deepEqual(probed.map(c => c.file), [path.join(f.home, '.claude', 'skills', 'careful-review')]);
  } finally { f.close(); }
});

test('installed copies are read and hashed again only when their files change', () => {
  const f = fixture();
  try {
    const review = f.create('careful-review');
    f.install(review.id, f.targets.claude.id);
    const copy = path.join(f.home, '.claude', 'skills', 'careful-review');
    settle(new Date(Date.now() - 60_000), f.home);
    f.installations();
    const again = counting(f.installations);
    assert.equal(again.calls.filter(c => c.name === 'readFileSync' && c.file.startsWith(copy)).length, 0, 'an unchanged copy is not read');
    assert.equal(again.result[0].state, 'installed');
    // An edit of the same size still changes the modification time, and so the state.
    const file = path.join(copy, 'SKILL.md'), text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace('carefully', 'CAREFULLY'));
    assert.equal(f.installations()[0].state, 'drifted');
    fs.writeFileSync(file, text);
    assert.equal(f.installations()[0].state, 'installed');
    // The hashes survive a restart: a new process reads the cache, not the copy.
    settle(new Date(Date.now() - 60_000), f.home);
    f.installations();
    const wb = new Workbench(f.wb.root, path.join(f.root, 'private'));
    try {
      const fresh = new Router(wb, { composer: null });
      const cold = counting(() => fresh.call('deploy.installations') as Installation[]);
      assert.equal(cold.result[0].state, 'installed');
      assert.equal(cold.calls.filter(c => c.name === 'readFileSync' && c.file.startsWith(copy)).length, 0);
      assert.equal(cold.calls.filter(c => c.name === 'readFileSync' && c.file.includes(`${path.sep}revisions${path.sep}`)).length, 0, 'revision facts come from the cache');
    } finally { wb.close(); }
  } finally { f.close(); }
});

test('a copy linked to a checkout is listed as linked without walking its node_modules', () => {
  const f = fixture();
  try {
    const review = f.create('careful-review'), notes = f.create('field-notes');
    const checkout = path.join(f.root, 'checkout');
    fs.mkdirSync(path.join(checkout, 'node_modules', 'left-pad', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'SKILL.md'), skill('careful-review'));
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(checkout, 'node_modules', 'left-pad', 'lib', `f${i}.js`), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(f.home, '.agents', 'skills'), { recursive: true });
    fs.symlinkSync(checkout, path.join(f.home, '.agents', 'skills', 'careful-review'), 'junction');
    // A link to a plain copy of the same revision still compares as identical.
    const shared = path.join(f.root, 'shared', 'field-notes'); fs.mkdirSync(shared, { recursive: true }); fs.writeFileSync(path.join(shared, 'SKILL.md'), skill('field-notes'));
    fs.symlinkSync(shared, path.join(f.home, '.agents', 'skills', 'field-notes'), 'junction');

    const { result, calls } = counting(f.installations);
    assert.deepEqual(result.map(c => [c.itemId, c.state, c.linked, c.matches]).sort(), [[review.id, 'external', true, false], [notes.id, 'external', true, true]].sort());
    assert.deepEqual(calls.filter(c => c.file.includes('node_modules')), [], 'nothing inside node_modules is touched');
  } finally { f.close(); }
});

test('the snapshot stamp for installations changes with installs, removals and folders changed outside Kiln, and only then', () => {
  const f = fixture();
  try {
    const review = f.create('careful-review');
    // Every modification time is set to one moment an hour ago, so a change only shows through what the stamp watches (and
    // nothing counts as "just changed", which would change the stamp on every call).
    const past = new Date(Date.now() - 3_600_000), folders = [f.home, f.project, path.join(f.root, 'private'), f.wb.canonical];
    const stamp = () => { settle(past, ...folders); return f.snapshot().stamps!.installations; };
    const start = stamp();
    assert.match(start, /^[0-9a-f]{32}$/);
    assert.equal(stamp(), start, 'unchanged when nothing changed');

    f.install(review.id, f.targets.claude.id);
    const installed = stamp();
    assert.notEqual(installed, start, 'an install');
    assert.equal(stamp(), installed);

    // Another program adds a skill folder: in a skills folder that did not exist, then beside the installed copy.
    fs.mkdirSync(path.join(f.home, '.agents', 'skills', 'careful-review'), { recursive: true });
    fs.writeFileSync(path.join(f.home, '.agents', 'skills', 'careful-review', 'SKILL.md'), skill('careful-review'));
    const external = stamp();
    assert.notEqual(external, installed, 'an external copy appearing');
    fs.mkdirSync(path.join(f.home, '.claude', 'skills', 'other-skill'));
    const later = new Date(past.getTime() + 10_000);
    fs.utimesSync(path.join(f.home, '.claude', 'skills'), later, later);
    const beside = f.snapshot().stamps!.installations;
    assert.notEqual(beside, external, 'a folder added beside a copy changes its parent folder');

    // Someone edits the installed SKILL.md.
    fs.appendFileSync(path.join(f.home, '.claude', 'skills', 'careful-review', 'SKILL.md'), '\nLocal note.\n');
    const edited = stamp();
    assert.notEqual(edited, beside, 'an edit to a Kiln copy');

    f.router.call('skills.remove', { itemId: review.id, targetId: f.targets.claude.id, force: true, confirm: true });
    const removed = stamp();
    assert.notEqual(removed, edited, 'a removal');

    // A new revision changes what the copies are compared with.
    f.wb.update({ id: review.id, expect: f.wb.getItem(review.id).revision, summary: 'Edited', value: { ...f.wb.authoring(review.id), content: skill('careful-review', 'Version two.') } });
    assert.notEqual(stamp(), removed, 'a new revision');
  } finally { f.close(); }
});
