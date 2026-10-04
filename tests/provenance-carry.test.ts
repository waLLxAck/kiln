import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { DeploymentService } from '../packages/deployment/service';
import { revisionHash } from '../packages/domain/content';
import { machinePath, portableMessage, portableSource, provenanceOnlyChange } from '../packages/domain/privacy';
import { initialiseRepository } from '../packages/git/standard';
import { applyMigration, migrationPlan } from '../packages/git/migration';
import { writeJson } from '../packages/storage/files';
import type { Approval, Item, Revision } from '../packages/protocol/schema';

/**
 * Libraries shared by a Linux and a Windows machine hold approved revisions an older Kiln wrote with machine paths in `source`.
 * Opening them must make the paths portable without losing the approval, and every machine must arrive at the same files.
 */
const LINUX = 'local:/home/PRIVATE-LINUX/Projects/kiln-skills/vendor/mattpocock/skills/engineering/research';
const WINDOWS = 'C:\\Users\\PRIVATE-WIN\\Kiln\\sources\\skills:mine/tune-skill/SKILL.md';
const skill = (name: string) => `---\nname: ${name}\ndescription: Investigate a question against primary sources.\n---\n\n# Procedure\nRead the sources. Cite them.\n`;
/** Files in HEAD containing `text`; `git grep` exits 1 when there are none. */
const grepHead = (cwd: string, text: string) => { try { return git(cwd, 'grep', '-l', '-F', text, 'HEAD', '--', '.'); } catch (error) { if ((error as { status?: number }).status === 1) return ''; throw error; } };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-provenance-'));
  const created = initialiseRepository({ parent: root, name: 'library' }); assert.ok(created.committed, created.message);
  return { root, library: created.root, local: path.join(root, 'private'), close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
/** What an older Kiln left behind: the current revision names a machine path and a person approved exactly that revision. */
function legacyApproved(wb: Workbench, title: string, source: string, collection = 'Engineering') {
  const created = wb.create({ title, kind: 'skill', content: skill(title), collection });
  const base = wb.getRevision(created.id);
  const raw: Revision = { ...base, source, parent: null, createdAt: '2026-09-19T12:00:00.000Z', author: 'old-kiln', summary: 'Captured into library', hash: '' };
  raw.hash = revisionHash(raw);
  fs.rmSync(path.join(wb.itemDir(created.id), 'revisions', `${base.hash}.json`));
  writeJson(path.join(wb.itemDir(created.id), 'revisions', `${raw.hash}.json`), raw);
  writeJson(path.join(wb.itemDir(created.id), 'item.json'), { ...wb.getItem(created.id), source, revision: raw.hash, status: 'approved' });
  const approval: Approval = { schemaVersion: 1, id: randomUUID(), itemId: created.id, revision: raw.hash, reviewer: 'Svilen', scope: 'Personal use', note: 'Reviewed', evidence: [], waivedChecks: 'Imported from a trusted repository', createdAt: '2026-09-19T12:34:13.000Z', trust: 'local' };
  writeJson(path.join(wb.canonical, 'approvals', `${approval.id}.json`), approval);
  return { id: created.id, raw, approval };
}
/** Every shared file, by path relative to the repository, for byte comparisons and path searches. */
function sharedFiles(library: string) {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === '.git' || entry.name === '.transactions') continue;
      if (entry.isDirectory()) walk(full); else files[path.relative(library, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(library);
  return files;
}
const leaks = (library: string) => Object.entries(sharedFiles(library)).filter(([, text]) => /PRIVATE-LINUX|PRIVATE-WIN/.test(text)).map(([name]) => name);

test('machine paths are recognised the same way on every OS and give the same portable label', () => {
  for (const source of [LINUX, WINDOWS, '/home/x/skills/a', '~/skills/a', '~', 'C:/Users/x/a', 'c:\\x\\a', '\\\\server\\share\\a', 'file:///home/x/a', 'FILE:///C:/x/a', 'home:/home/x/.claude/CLAUDE.md'])
    assert.ok(machinePath(source), source);
  for (const source of ['', 'https://github.com/o/r', 'repository:mine/a/SKILL.md', 'local-import:research', 'kiln:00000000-0000-0000-0000-000000000000@abc', 'Pasted', 'docs/notes.md'])
    assert.equal(portableSource(source), source, source);
  assert.equal(portableSource(LINUX), 'local-import:research');
  assert.equal(portableSource(WINDOWS), 'local-import:SKILL.md');
  assert.equal(portableSource('C:\\Users\\x\\skills\\research\\'), 'local-import:research');
  assert.equal(portableSource('\\\\server\\share\\research'), 'local-import:research');
  assert.equal(portableMessage('Imported “research” from /home/x/skills/research'), 'Imported “research” from research');
  assert.equal(portableMessage('Imported “a: b” from C:\\Users\\x\\skills\\tune'), 'Imported “a: b” from tune');
  assert.equal(portableMessage('Bulk removal: /home/x/.claude/skills/review'), 'Bulk removal: review');
  for (const message of ['Approved by Svilen: Personal use', 'Imported “x” from Claude Code', 'Imported 3 and updated 0 from o/r at abc1234'])
    assert.equal(portableMessage(message), message);
});

test('opening a library keeps the approval of a revision whose only change is a portable source (Linux and Windows paths)', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const linux = legacyApproved(wb, 'research', LINUX), windows = legacyApproved(wb, 'tune-skill', WINDOWS);
    const target = path.join(f.root, 'target'); fs.mkdirSync(target);
    wb.enroll({ root: target, provider: 'claude', scope: 'personal', name: 'Claude' }); wb.setInstall(linux.id, 'claude', true);
    assert.equal(new DeploymentService(wb).syncInstalls()[0].result, 'installed approved revision', 'installed from the path-bearing approval');
    wb.close(); wb = new Workbench(f.library, f.local);
    for (const { id, raw, approval } of [linux, windows]) {
      const item = wb.getItem(id), current = wb.getRevision(id);
      assert.notEqual(item.revision, raw.hash);
      assert.equal(item.status, 'approved', `${item.title} stays approved`);
      assert.match(item.source, /^local-import:/); assert.equal(current.source, item.source);
      assert.equal(current.content, raw.content); assert.deepEqual(current.files, raw.files);
      assert.equal(current.createdAt, raw.createdAt, 'derived from the original, not the clock');
      const carried = wb.approvals().find(a => a.itemId === id && a.revision === item.revision);
      assert.ok(carried, 'a carried approval names the portable revision');
      assert.equal(carried.reviewer, 'Kiln'); assert.equal(carried.carriedFrom, raw.hash); assert.equal(carried.trust, 'local');
      assert.equal(carried.scope, approval.scope); assert.equal(carried.waivedChecks, approval.waivedChecks);
      assert.ok(wb.approvals().some(a => a.id === approval.id), 'the original approval stays as history');
      assert.equal(fs.existsSync(path.join(wb.itemDir(id), 'revisions', `${raw.hash}.json`)), false, 'the path-bearing revision left the shared folder');
      assert.equal(wb.getRevision(id, raw.hash).source, raw.source, 'and stays readable on this machine');
    }
    assert.equal(wb.getItem(linux.id).source, 'local-import:research');
    assert.deepEqual(leaks(f.library), [], 'no machine path anywhere in the shared library');
    const deployments = new DeploymentService(wb);
    assert.equal(deployments.syncInstalls()[0].result, 'already installed', 'the installed copy is still the approved one');
    assert.ok(!deployments.installations(linux.id).some(c => c.outdated), 'and is not reported as outdated');
    // A second open changes nothing.
    const before = sharedFiles(f.library); wb.close(); wb = new Workbench(f.library, f.local);
    assert.deepEqual(sharedFiles(f.library), before);
  } finally { wb.close(); f.close(); }
});

test('two machines cleaning the same library independently write byte-identical files', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    legacyApproved(wb, 'research', LINUX); legacyApproved(wb, 'tune-skill', WINDOWS); wb.close();
    const other = path.join(f.root, 'other machine'); fs.cpSync(f.library, other, { recursive: true });
    wb = new Workbench(f.library, path.join(f.root, 'linux-private'));
    const second = new Workbench(other, path.join(f.root, 'windows-private')); second.close();
    assert.deepEqual(sharedFiles(other), sharedFiles(f.library));
  } finally { wb.close(); f.close(); }
});

test('an item an older Kiln already cleaned into an unapproved draft gets its approval back', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const { id, raw } = legacyApproved(wb, 'research', LINUX);
    // The older cleanup: a sanitised revision saved at its own time with the original as parent, status captured, original archived.
    const item = wb.getItem(id), cleaned = { ...raw, source: portableSource(raw.source), parent: raw.hash, createdAt: '2026-10-04T08:00:00.000Z', author: 'wallxack', summary: 'Moved private session data and machine provenance out of shared content', hash: '' };
    cleaned.hash = revisionHash({ ...cleaned, hashVersion: 2 }, 2); (cleaned as Revision).hashVersion = 2;
    writeJson(path.join(wb.local, 'private-revisions', id, `${raw.hash}.json`), raw);
    fs.rmSync(path.join(wb.itemDir(id), 'revisions', `${raw.hash}.json`));
    writeJson(path.join(wb.itemDir(id), 'revisions', `${cleaned.hash}.json`), cleaned);
    writeJson(path.join(wb.itemDir(id), 'item.json'), { ...item, source: cleaned.source, revision: cleaned.hash, status: 'captured' });
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getItem(id).revision, cleaned.hash, 'the existing clean revision is kept');
    assert.equal(wb.getItem(id).status, 'approved');
    assert.equal(wb.approvals().find(a => a.revision === cleaned.hash)?.carriedFrom, raw.hash);
  } finally { wb.close(); f.close(); }
});

test('approval still needs a person for real changes, withdrawn decisions, imported approvals and session attachments', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const edited = legacyApproved(wb, 'edited', LINUX.replace('research', 'edited'));
    const withdrawn = legacyApproved(wb, 'withdrawn', LINUX.replace('research', 'withdrawn'));
    const imported = legacyApproved(wb, 'imported', LINUX.replace('research', 'imported'));
    writeJson(path.join(wb.canonical, 'approvals', `${imported.approval.id}.json`), { ...imported.approval, trust: 'imported' });
    const session = legacyApproved(wb, 'session', LINUX.replace('research', 'session'));
    const withSession: Revision = { ...session.raw, files: { 'session.jsonl': Buffer.from('PRIVATE-SESSION').toString('base64') }, hash: '' };
    withSession.hash = revisionHash(withSession);
    fs.rmSync(path.join(wb.itemDir(session.id), 'revisions', `${session.raw.hash}.json`));
    writeJson(path.join(wb.itemDir(session.id), 'revisions', `${withSession.hash}.json`), withSession);
    writeJson(path.join(wb.itemDir(session.id), 'item.json'), { ...wb.getItem(session.id), revision: withSession.hash });
    writeJson(path.join(wb.canonical, 'approvals', `${session.approval.id}.json`), { ...session.approval, revision: withSession.hash });
    wb.close(); wb = new Workbench(f.library, f.local);
    // A person withdrew the carried approval; reopening must not grant it again.
    const carried = wb.getItem(withdrawn.id); assert.equal(carried.status, 'approved');
    wb.unapprove({ id: withdrawn.id, revision: carried.revision });
    // The edited item's portable revision gets a content change: that is a new draft, never carried.
    const draft = wb.update({ id: edited.id, expect: wb.getItem(edited.id).revision, value: { ...wb.authoring(edited.id), content: skill('edited') + '\nUNREVIEWED' } });
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.equal(wb.getItem(withdrawn.id).status, 'captured');
    assert.ok(!wb.approvals().some(a => a.itemId === withdrawn.id && a.revision === carried.revision), 'no live approval for the withdrawn revision');
    assert.equal(wb.getItem(edited.id).revision, draft.revision); assert.equal(wb.getItem(edited.id).status, 'captured');
    assert.ok(!wb.approvals().some(a => a.revision === draft.revision));
    assert.equal(wb.getItem(imported.id).status, 'captured', 'imported approvals are history, not authority');
    assert.ok(!wb.approvals().some(a => a.itemId === imported.id && a.reviewer === 'Kiln'));
    assert.equal(wb.getItem(session.id).status, 'captured', 'dropping a session attachment changes the bundle');
    assert.equal(wb.getRevision(session.id).files['session.jsonl'], undefined);
    assert.ok(wb.getRevision(session.id, withSession.hash).files['session.jsonl'], 'the session stays readable privately');
    assert.equal(provenanceOnlyChange(withSession, wb.getRevision(session.id)), false);
    assert.deepEqual(leaks(f.library), []);
  } finally { wb.close(); f.close(); }
});

test('the carried approval is published once and a second machine merges the same result cleanly', async () => {
  const f = fixture();
  const origin = path.join(f.root, 'origin.git'); execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true });
  git(f.library, 'remote', 'add', 'origin', origin); git(f.library, 'push', '-q', '-u', 'origin', 'main');
  let linux = new Workbench(f.library, path.join(f.root, 'linux-private')), windows: Workbench | undefined;
  try {
    // An older Kiln committed and pushed the path-bearing approved revisions with everything else.
    const research = legacyApproved(linux, 'research', LINUX), tune = legacyApproved(linux, 'tune-skill', WINDOWS); linux.close();
    git(f.library, 'add', '-A'); git(f.library, 'commit', '-q', '-m', 'Preserve local Kiln work'); git(f.library, 'push', '-q');
    const other = path.join(f.root, 'windows'); execFileSync('git', ['clone', '-q', origin, other], { windowsHide: true });
    // Both machines open the new Kiln before either has seen the other's cleanup.
    linux = new Workbench(f.library, path.join(f.root, 'linux-private')); windows = new Workbench(other, path.join(f.root, 'windows-private'));
    const linuxRouter = new Router(linux, { composer: null }), windowsRouter = new Router(windows, { composer: null });
    assert.equal(linuxRouter.publishCarriedApprovals().length, 2); await linuxRouter.publisher.idle();
    assert.ok(linuxRouter.publisher.list().every(j => j.status === 'done'), JSON.stringify(linuxRouter.publisher.list()));
    const pushed = git(f.library, 'show', '--no-renames', '--name-status', '--format=', 'HEAD~1', 'HEAD');
    assert.match(pushed, new RegExp(`D\\s+workbench/items/${research.id}/revisions/${research.raw.hash}\\.json`), 'the path-bearing revision leaves GitHub');
    assert.equal(grepHead(f.library, 'PRIVATE-'), '', 'GitHub has no machine path');
    for (const { id } of [research, tune]) assert.equal(JSON.parse(git(f.library, 'show', `HEAD:workbench/items/${id}/item.json`)).status, 'approved');
    assert.equal(linuxRouter.publishCarriedApprovals().length, 0, 'published once');
    const committed = (cwd: string) => git(cwd, 'status', '--porcelain', '--', 'workbench/approvals', ...[research, tune].map(i => `workbench/items/${i.id}/revisions`));
    assert.equal(committed(f.library), '', 'nothing about the cleanup is left uncommitted');
    // The Windows machine pushes too late; its own identical commit merges without conflicts.
    windowsRouter.publishCarriedApprovals(); await windowsRouter.publisher.idle();
    git(other, 'fetch', '-q', 'origin');
    git(other, 'merge', '-q', '--no-edit', 'origin/main');
    for (const { id } of [research, tune]) {
      assert.equal(git(other, 'rev-parse', `HEAD:workbench/items/${id}/revisions`), git(f.library, 'rev-parse', `HEAD:workbench/items/${id}/revisions`));
      assert.equal(windows.getItem(id).revision, linux.getItem(id).revision); assert.equal(windows.getItem(id).status, 'approved');
    }
    assert.equal(git(other, 'rev-parse', 'HEAD:workbench/approvals'), git(f.library, 'rev-parse', 'HEAD:workbench/approvals'), 'the same approval files on both machines');
    windows.close(); windows = new Workbench(other, path.join(f.root, 'windows-private'));
    assert.equal(new Router(windows, { composer: null }).publishCarriedApprovals().length, 0, 'nothing more to publish after the merge');
    assert.equal(committed(other), '');
  } finally { linux.close(); windows?.close(); f.close(); }
});

test('exports with machine paths and skill imports from other folders leave no path in the shared library', () => {
  const f = fixture(); let wb = new Workbench(f.library, f.local);
  try {
    const source = path.join(f.root, 'PRIVATE-LINUX skills'); fs.mkdirSync(path.join(source, 'review'), { recursive: true });
    fs.writeFileSync(path.join(source, 'review', 'SKILL.md'), skill('review'));
    applyMigration(wb, migrationPlan(f.library, source).hash, source);
    assert.equal(migrationPlan(f.library, source).unchanged, 1, 'the import is still recognised');
    // A manifest entry as Kiln 0.25 wrote it is recognised and rewritten without the path.
    const manifestFile = path.join(f.library, '.kiln', 'migration.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    writeJson(manifestFile, { ...manifest, entries: manifest.entries.map((e: { path: string }) => ({ ...e, path: `${path.resolve(source)}::review/SKILL.md` })) });
    assert.equal(migrationPlan(f.library, source).unchanged, 1);
    const event = { id: randomUUID(), at: '2026-09-19T12:34:06.443Z', itemId: null, kind: 'imported', message: `Imported “review” from ${path.join(source, 'review')}` };
    writeJson(path.join(wb.canonical, 'activity', `${event.id}.json`), event);
    assert.notDeepEqual(leaks(f.library), []);
    wb.close(); wb = new Workbench(f.library, f.local);
    assert.deepEqual(leaks(f.library), [], 'opening rewrites the manifest key and the activity message');
    assert.equal(migrationPlan(f.library, source).unchanged, 1, 'and the import is still recognised');
    fs.writeFileSync(path.join(source, 'review', 'SKILL.md'), skill('review') + '\nUpdated upstream.\n');
    assert.equal(applyMigration(wb, migrationPlan(f.library, source).hash, source).updated, 1);
    // A hand-made export: an item whose only revision names a Windows path.
    const exported = path.join(f.root, 'export.json'), id = randomUUID();
    const revision: Revision = { schemaVersion: 1, hashVersion: 2, itemId: id, hash: '', parent: null, createdAt: '2026-09-01T00:00:00.000Z', author: 'x', summary: 'Captured', title: 'tune-skill', kind: 'skill', description: '', tags: [], collection: 'Imported', source: WINDOWS, licence: 'Unknown', content: skill('tune-skill'), files: {} };
    revision.hash = revisionHash(revision);
    const item: Item = { schemaVersion: 1, id, title: 'tune-skill', kind: 'skill', description: '', tags: [], collection: 'Imported', source: WINDOWS, licence: 'Unknown', status: 'approved', revision: revision.hash, favourite: false, order: 1, createdAt: revision.createdAt, updatedAt: revision.createdAt, deletedAt: null, origin: null };
    writeJson(exported, { schemaVersion: 1, items: [{ item, revisions: [revision] }], approvals: [], trials: [] });
    wb.importLibrary(exported);
    assert.equal(wb.getItem(id).source, 'local-import:SKILL.md'); assert.equal(wb.getItem(id).status, 'captured');
    assert.deepEqual(leaks(f.library), []);
  } finally { wb.close(); f.close(); }
});
