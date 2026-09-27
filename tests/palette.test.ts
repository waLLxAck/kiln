import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRanges, matchScore, rankItems } from '../apps/desktop/src/palette-match';
import { resolveVariables } from '../packages/domain/text';

test('a substring ranks by position; word starts match across words; scattered letters do not match', () => {
  assert.equal(matchScore('Go to Library', ''), 0);
  assert.equal(matchScore('Go to Library', 'lib'), 6);
  assert.equal(matchScore('Go to Library', 'go lib'), 102);
  assert.equal(matchScore('Go to Config files', 'config'), 6);
  assert.equal(matchScore('New collection', 'clear'), -1);
  assert.equal(matchScore('Toggle theme', 'tgl'), -1);
});

test('highlight ranges cover the substring or each word start, and nothing for a non-title match', () => {
  assert.deepEqual(matchRanges('Go to Library', 'LIB'), [[6, 9]]);
  assert.deepEqual(matchRanges('Go to Library', 'lib go'), [[0, 2], [6, 9]]);
  assert.deepEqual(matchRanges('Review a pull request', 'diff'), []);
  assert.deepEqual(matchRanges('Anything', '  '), []);
});

test('title hits lead, then usage, then the backend order; with no query the most used lead', () => {
  const items = [{ id: 'a', title: 'Notes on review' }, { id: 'b', title: 'Review code' }, { id: 'c', title: 'Tagged review elsewhere' }, { id: 'd', title: 'Content match only' }];
  const usage = { d: { copied: 4, used: 9 }, c: { copied: 0, used: 2 } };
  assert.deepEqual(rankItems(items, 'review', usage).map(i => i.id), ['b', 'c', 'a', 'd']);
  assert.deepEqual(rankItems(items, '', usage).map(i => i.id), ['d', 'c', 'a', 'b']);
});

test('the preview fills variables exactly as the copy does: blanks stay as {{name}}', () => {
  const template = 'Review {{ subject }} for {{audience}}.';
  assert.equal(resolveVariables(template, { subject: 'the diff', audience: '  ' }), 'Review the diff for {{audience}}.');
});
