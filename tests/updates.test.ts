import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstallerUpdates, newerVersion } from '../packages/updates/service';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-update-'));
  const cache = path.join(root, 'updates'), installer = path.join(root, 'Kiln Setup 2.0.0.exe');
  fs.writeFileSync(installer, Buffer.alloc(1024 * 1024, 42));
  return { root, cache, installer, candidate: { version: '2.0.0', path: installer }, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('prepare stays open, survives source removal and app reopening, then explicit restart launches before quitting', async () => {
  const f = fixture();
  try {
    let updates = new InstallerUpdates(f.cache, '1.0.0');
    const events: string[] = [];
    await assert.rejects(updates.restart(async () => { events.push('launch'); }, () => events.push('quit')), /Prepare the update/);
    assert.equal(updates.prepare(f.candidate).state, 'preparing');
    updates.prepare(f.candidate);
    await updates.settled();
    assert.deepEqual(updates.status(), { state: 'ready', version: '2.0.0' });
    assert.equal(events.length, 0);
    const marker = JSON.parse(fs.readFileSync(path.join(f.cache, 'ready.json'), 'utf8'));
    const cached = path.join(f.cache, marker.folder, 'Kiln Setup 2.0.0.exe');
    assert.deepEqual(fs.readFileSync(cached), fs.readFileSync(f.installer));
    fs.unlinkSync(f.installer);
    updates = new InstallerUpdates(f.cache, '1.0.0');
    assert.equal(updates.status().state, 'ready');
    await updates.restart(async file => { assert.equal(file, cached); events.push('launch'); }, () => events.push('quit'));
    assert.deepEqual(events, ['launch', 'quit']);
    await assert.rejects(updates.restart(async () => {}, () => {}), /already restarting/);
    assert.equal(new InstallerUpdates(f.cache, '2.0.0').status().state, 'idle');
  } finally { f.close(); }
});

test('failed preparation and launch leave Kiln running and allow retry', async () => {
  const f = fixture();
  try {
    const updates = new InstallerUpdates(f.cache, '1.0.0');
    updates.prepare({ ...f.candidate, path: path.join(f.root, 'missing', path.basename(f.installer)) });
    await updates.settled(); assert.equal(updates.status().state, 'failed');
    updates.prepare(f.candidate); await updates.settled();
    let quit = false;
    await assert.rejects(updates.restart(async () => { throw new Error('Launch failed'); }, () => { quit = true; }), /Launch failed/);
    assert.equal(quit, false); assert.equal(updates.status().state, 'failed');
    assert.equal(new InstallerUpdates(f.cache, '1.0.0').status().state, 'idle');
    updates.prepare(f.candidate); await updates.settled(); assert.equal(updates.status().state, 'ready');
  } finally { f.close(); }
});

test('restart refuses a changed staged installer even when its size is unchanged', async () => {
  const f = fixture();
  try {
    const updates = new InstallerUpdates(f.cache, '1.0.0');
    updates.prepare(f.candidate); await updates.settled();
    const marker = JSON.parse(fs.readFileSync(path.join(f.cache, 'ready.json'), 'utf8'));
    fs.writeFileSync(path.join(f.cache, marker.folder, 'Kiln Setup 2.0.0.exe'), Buffer.alloc(marker.size, 43));
    let launched = false, quit = false;
    await assert.rejects(updates.restart(async () => { launched = true; }, () => { quit = true; }), /changed/);
    assert.equal(launched, false); assert.equal(quit, false);
    assert.equal(fs.existsSync(path.join(f.cache, 'ready.json')), false);
  } finally { f.close(); }
});

test('only newer Kiln installers may be prepared and cached paths cannot escape the update folder', () => {
  const f = fixture();
  try {
    const updates = new InstallerUpdates(f.cache, '2.0.0');
    assert.throws(() => updates.prepare(f.candidate), /newer Kiln/);
    assert.throws(() => updates.prepare({ version: '3.0.0', path: f.installer }), /newer Kiln/);
    assert.equal(newerVersion('1.10.0', '1.9.9'), true);
    fs.mkdirSync(f.cache);
    fs.writeFileSync(path.join(f.cache, 'ready.json'), JSON.stringify({ version: '3.0.0', folder: '../elsewhere', size: 1, sha256: 'a'.repeat(64) }));
    assert.equal(new InstallerUpdates(f.cache, '1.0.0').status().state, 'failed');
  } finally { f.close(); }
});
