import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionScore, matchRanges, matchScore, mostUsed, parsePaletteQuery, preferredRow } from '../apps/desktop/src/palette-match';
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

test('with nothing typed the most used lead, ties keeping the backend order', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const usage = { d: { copied: 4, used: 9 }, c: { copied: 0, used: 2 } };
  assert.deepEqual(mostUsed(items, usage).map(i => i.id), ['d', 'c', 'a', 'b']);
});

test('> lists actions only; actions match their label first, then label and keywords together', () => {
  assert.deepEqual(parsePaletteQuery('> sett '), { actionsOnly: true, text: 'sett' });
  assert.deepEqual(parsePaletteQuery(' review'), { actionsOnly: false, text: 'review' });
  const capture = { label: 'Capture…', keywords: 'new add paste' };
  assert.equal(actionScore(capture, 'capt'), 0);
  assert.equal(actionScore(capture, 'new capture'), 500);
  assert.equal(actionScore(capture, 'updates'), -1);
  assert.equal(actionScore({ label: 'Ask the agent about “Deploy”', match: 'Ask the agent about' }, 'deploy'), -1);
});

test('Enter prefers the top item unless only an action names what was typed', () => {
  const settings = { label: 'Go to Settings' };
  assert.equal(preferredRow(['Weekly notes', 'Deploy'], settings, 'go sett'), 2);
  assert.equal(preferredRow(['Settings sync notes'], settings, 'sett'), 0);
  assert.equal(preferredRow([], settings, 'sett'), 0);
  assert.equal(preferredRow(['Weekly notes'], settings, ''), 0);
});

test('the preview fills variables exactly as the copy does: blanks stay as {{name}}', () => {
  const template = 'Review {{ subject }} for {{audience}}.';
  assert.equal(resolveVariables(template, { subject: 'the diff', audience: '  ' }), 'Review the diff for {{audience}}.');
});
