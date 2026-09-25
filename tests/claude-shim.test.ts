import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shimCommandLine } from '../packages/agent/claude';

const args = ['-p', '--output-format', 'stream-json', '--json-schema', JSON.stringify({ type: 'object', properties: { note: { type: 'string', description: 'say "hi" (x & y)' } } }), '--add-dir', 'C:\\Users\\dev\\my project\\'];

test('an npm .cmd shim command line is wrapped in the extra quotes cmd /s strips', () => {
  const line = shimCommandLine('C:\\Program Files\\nodejs\\claude.cmd', ['-p', 'a "quoted" word']);
  assert.equal(line, '""C:\\Program Files\\nodejs\\claude.cmd" "-p" "a \\"quoted\\" word""');
});

test('a real .cmd shim in a folder with spaces receives every argument intact', { skip: process.platform !== 'win32' && 'cmd.exe only exists on Windows' }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln shim '));
  try {
    fs.writeFileSync(path.join(folder, 'echo-args.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const shim = path.join(folder, 'claude.cmd');
    fs.writeFileSync(shim, `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`);
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', shimCommandLine(shim, args)], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
