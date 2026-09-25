import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findDefaultRepository, cloneGitHub } from '../packages/git/github';

function github(options: { missing?: boolean; failure?: string; manifest?: unknown; names?: string[] } = {}) {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => {
    calls.push(args);
    if (args[1] === 'user') return 'alice';
    if (options.failure) throw new Error(options.failure);
    if (options.missing) throw new Error('gh: Not Found (HTTP 404)');
    if (args[1] === 'repos/alice/my-kiln') return JSON.stringify({ full_name: 'alice/my-kiln', html_url: 'https://github.com/alice/my-kiln', private: true, description: null, updated_at: '2026-09-08' });
    if (args[1].endsWith('/kiln.json')) return Buffer.from(JSON.stringify(options.manifest ?? { format: 'kiln-library', dedicated: true })).toString('base64');
    return JSON.stringify(options.names ?? ['kiln.json', 'workbench']);
  } };
}

test('setup looks up the signed-in account exact my-kiln, including private repos', async () => {
  const fake = github();
  const result = await findDefaultRepository(fake.run);
  assert.equal(result?.repo.nameWithOwner, 'alice/my-kiln');
  assert.equal(result?.repo.isPrivate, true);
  assert.equal(result?.dedicated, true);
  assert.equal(fake.calls.length, 3);
});

test('absence is distinct from a failed GitHub check', async () => {
  assert.equal(await findDefaultRepository(github({ missing: true }).run), null);
  await assert.rejects(findDefaultRepository(github({ failure: 'HTTP 403 rate limit' }).run), /403/);
});

test('an occupied name is offered only when its contents form a Kiln library', async () => {
  assert.equal((await findDefaultRepository(github({ manifest: { format: 'other' } }).run))?.dedicated, false);
  assert.equal((await findDefaultRepository(github({ manifest: { format: 'kiln-library' } }).run))?.dedicated, true);
  assert.equal((await findDefaultRepository(github({ manifest: { format: 'kiln-library' }, names: ['kiln.json', 'src'] }).run))?.dedicated, false);
});

test('opening a matching local copy preserves edits and rejects a different origin', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-reuse-'));
  const root = path.join(parent, 'my-kiln'); fs.mkdirSync(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
  try {
    git('init'); git('remote', 'add', 'origin', 'git@github.com:alice/my-kiln.git');
    fs.writeFileSync(path.join(root, 'kiln.json'), JSON.stringify({ format: 'kiln-library', dedicated: true }));
    fs.writeFileSync(path.join(root, 'draft.txt'), 'unsaved draft');
    assert.deepEqual(await cloneGitHub({ repo: 'alice/my-kiln', parent }), { root, standard: true, dedicated: true });
    assert.equal(fs.readFileSync(path.join(root, 'draft.txt'), 'utf8'), 'unsaved draft');
    git('remote', 'set-url', 'origin', 'https://github.com/bob/my-kiln.git');
    await assert.rejects(cloneGitHub({ repo: 'alice/my-kiln', parent }), /different parent folder/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
