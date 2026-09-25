import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { checkpoint, inventory } from '../packages/git/service';
import { conflicts, finishMerge, mergeFetched, resolveItemConflict } from '../packages/git/conflicts';
test('repository inventory and checkpoints preserve unrelated files, history and staging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln git '));
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  let wb: Workbench | undefined;
  try {
    git(['init']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Kiln test']);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Existing instructions'); git(['add', 'AGENTS.md']); git(['commit', '-m', 'Original history']);
    const head = git(['rev-parse', 'HEAD']); const status = git(['status', '--porcelain']);
    const found = inventory(root); assert.ok(found.resources.includes('AGENTS.md')); assert.equal(git(['rev-parse', 'HEAD']), head); assert.equal(git(['status', '--porcelain']), status);
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'User staging'); git(['add', 'unrelated.txt']);
    wb = new Workbench(root, path.join(os.tmpdir(), `kiln-private-${Date.now()}`)); wb.create({ title: 'Saved', kind: 'prompt', content: 'Useful text' });
    checkpoint(root, wb.canonical, 'Capture prompt');
    assert.equal(git(['rev-parse', 'HEAD^']), head); assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'Existing instructions');
    assert.match(git(['diff', '--cached', '--name-only']), /unrelated.txt/); assert.doesNotMatch(git(['show', '--name-only', '--format=', 'HEAD']), /unrelated.txt/);
  } finally { const local = wb?.local; wb?.close(); fs.rmSync(root, { recursive: true, force: true }); if (local) fs.rmSync(path.dirname(local), { recursive: true, force: true }); }
});

test('two offline revisions survive a three-way Git conflict and keep-both resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln merge '));
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln merge private '));
  let wb: Workbench | undefined;
  try {
    git(['init']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Kiln test']);
    wb = new Workbench(root, privateRoot);
    const item = wb.create({ title: 'Shared item', kind: 'prompt', content: 'Common ancestor' }); checkpoint(root, wb.canonical, 'Base');
    const baseBranch = git(['branch', '--show-current']).trim();
    git(['checkout', '-b', 'other-device']); wb.close(); wb = new Workbench(root, privateRoot);
    const incoming = wb.update({ id: item.id, expect: item.revision, summary: 'Other device', value: { ...wb.getRevision(item.id), content: 'Incoming offline edit' } }); checkpoint(root, wb.canonical, 'Incoming');
    wb.close(); git(['checkout', baseBranch]); wb = new Workbench(root, privateRoot);
    const local = wb.update({ id: item.id, expect: item.revision, summary: 'Local device', value: { ...wb.getRevision(item.id), content: 'Local offline edit' } }); checkpoint(root, wb.canonical, 'Local');
    const merged = mergeFetched(wb, 'other-device'); assert.equal(merged.items.length, 1); assert.equal(merged.items[0].baseText, 'Common ancestor');
    assert.equal(merged.items[0].oursText, 'Local offline edit'); assert.equal(merged.items[0].theirsText, 'Incoming offline edit');
    resolveItemConflict(wb, { id: item.id, choice: 'both' }); assert.equal(conflicts(wb).paths.length, 0);
    finishMerge(wb); wb.refresh();
    assert.equal(wb.getItem(item.id).revision, local.revision); assert.deepEqual(wb.getItem(item.id).conflictHeads, [local.revision, incoming.revision]);
    assert.equal(wb.getRevision(item.id, incoming.revision).content, 'Incoming offline edit');
    assert.equal(wb.detail(item.id).revisions.length, 3); assert.equal(git(['status', '--porcelain']).trim(), '');
  } finally { wb?.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(privateRoot, { recursive: true, force: true }); }
});
