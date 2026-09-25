import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiagnostics } from '../apps/desktop/diagnostics';
test('performance logs remain valid JSONL and retain only one rotated file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-logs-'));
  const logger = createDiagnostics(root, 200);
  for (let n = 0; n < 30; n++) logger.log('test', { n });
  await logger.flush();
  assert.deepEqual(fs.readdirSync(root).sort(), ['performance.jsonl', 'performance.jsonl.1']);
  for (const name of fs.readdirSync(root)) for (const line of fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n')) assert.equal(JSON.parse(line).event, 'test');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'performance.jsonl'), 'utf8').trim().split('\n').at(-1)!).n, 29);
});
