import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { AgentService } from '../packages/agent/service';

test('the chat agent gets a Kiln CLI wrapper its shell can run, with awkward paths quoted', { skip: process.platform === 'win32' && 'Windows keeps the kiln.cmd batch wrapper' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiln wrapper 'quoted' "));
  const wb = new Workbench(path.join(root, 'lib $HOME'), path.join(root, 'private'));
  try {
    const script = path.join(root, 'echo "args".cjs');
    fs.writeFileSync(script, 'console.log(JSON.stringify({ run: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(2) }));');
    const service = new AgentService(wb, () => {}, undefined, undefined, undefined, { node: process.execPath, script });
    const folder = path.join(root, 'chat folder'); fs.mkdirSync(folder);
    const cli = (service as unknown as { writeCli(folder: string): string }).writeCli(folder);
    assert.equal(path.basename(cli), 'kiln');
    assert.ok(fs.statSync(cli).mode & 0o100, 'the wrapper is executable');
    const out = JSON.parse(execFileSync(cli, ['items', 'read', "it's"], { encoding: 'utf8' }));
    assert.equal(out.run, '1');
    assert.deepEqual(out.args, ['--library', wb.root, '--local', path.join(folder, 'local'), 'items', 'read', "it's"]);
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
