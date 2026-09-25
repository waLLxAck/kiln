import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiff, detectLineEnding, markWords } from '../apps/desktop/src/diffModel';

const doc = (body: string) => `---\nname: review\ndescription: Review a change.\n---\n\n# Procedure\n${body}\n`;

test('a CRLF copy of an LF file is not a wall of removed and added lines', () => {
  const lf = doc('Read the diff. Verify claims.'), crlf = lf.replace(/\n/g, '\r\n');
  const model = buildDiff(crlf, lf);
  assert.equal(model.identical, true); assert.equal(model.lineEndingsOnly, true);
  assert.deepEqual(model.endings, { before: 'CRLF', after: 'LF' });
  assert.ok(model.rows.every(r => r.kind === 'context'), 'nothing is marked as changed');
  assert.equal(detectLineEnding('a\r\nb\nc'), 'mixed'); assert.equal(detectLineEnding('one line'), 'none');
});

test('a real change inside a CRLF file shows only the changed lines, with the differing words marked', () => {
  const lf = doc('Read the diff. Verify claims.'), crlf = doc('Read the diff twice. Verify claims.').replace(/\n/g, '\r\n');
  const model = buildDiff(crlf, lf);
  assert.equal(model.identical, false); assert.equal(model.lineEndingsOnly, false);
  const changed = model.rows.filter(r => r.kind !== 'context' && r.kind !== 'collapsed');
  assert.deepEqual(changed.map(r => [r.kind, (r as { text: string }).text]), [['removed', 'Read the diff twice. Verify claims.'], ['added', 'Read the diff. Verify claims.']]);
  const removed = changed[0] as { segments?: { text: string; changed: boolean }[] };
  assert.deepEqual(removed.segments?.filter(s => s.changed).map(s => s.text), [' twice']);
  assert.equal(model.rows.filter(r => r.kind === 'context').length, 6, 'every unchanged line stays visible in a short file');
});

test('long unchanged runs collapse to context lines around each change and the hidden lines stay recoverable', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const before = lines.join('\n'), after = lines.map(l => l === 'line 20' ? 'line twenty' : l).join('\n');
  const model = buildDiff(before, after);
  const kinds = model.rows.map(r => r.kind);
  assert.deepEqual(kinds, ['collapsed', 'context', 'context', 'context', 'removed', 'added', 'context', 'context', 'context', 'collapsed']);
  const [first, last] = model.rows.filter(r => r.kind === 'collapsed') as { lines: string[] }[];
  assert.equal(first.lines.length, 16); assert.equal(first.lines[0], 'line 1');
  assert.equal(last.lines.length, 17); assert.equal(last.lines[0], 'line 24');
  // The leading run keeps its tail only and the trailing run its head only; a middle run keeps both ends.
  assert.deepEqual(model.rows.slice(1, 4).map(r => (r as { text: string }).text), ['line 17', 'line 18', 'line 19']);
  const middle = buildDiff(before, lines.map(l => l === 'line 5' || l === 'line 35' ? l + '!' : l).join('\n')).rows.map(r => r.kind);
  assert.deepEqual(middle, ['context', 'context', 'context', 'context', 'removed', 'added', 'context', 'context', 'context', 'collapsed', 'context', 'context', 'context', 'removed', 'added', 'context', 'context', 'context', 'context', 'context']);
});

test('word marks are skipped when the replaced text is unrelated, and a missing final newline is not a change', () => {
  assert.equal(markWords('alpha beta gamma\n', 'completely different words here\n'), null);
  const marks = markWords('keep this word\nand this line\n', 'keep that word\nand this line\n');
  assert.deepEqual(marks?.removed.map(l => l.filter(s => s.changed).map(s => s.text)), [['this'], []]);
  assert.deepEqual(marks?.added.map(l => l.filter(s => s.changed).map(s => s.text)), [['that'], []]);
  const rows = buildDiff('a\nb', 'a\nb\n').rows;
  assert.ok(rows.every(r => r.kind === 'context'));
  assert.deepEqual(buildDiff('', '').rows, []);
  assert.deepEqual(buildDiff('', 'new\n').rows, [{ kind: 'added', text: 'new' }]);
});
