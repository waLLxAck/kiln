import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entrySeconds, markerColumns, minuteTicks, readTranscript, skippedRanges } from '../apps/desktop/src/source-timeline';
import { transcriptMarkdown } from '../packages/agent/youtube';

test('an entry’s minute comes from the timestamped link distillation stores on it', () => {
  assert.equal(entrySeconds('https://www.youtube.com/watch?v=kilnDemo001&t=252s'), 252);
  assert.equal(entrySeconds('https://youtu.be/kilnDemo001?t=1m5s'), 65);
  assert.equal(entrySeconds('https://www.youtube.com/watch?v=kilnDemo001'), null);
  assert.equal(entrySeconds('https://example.com/page?t=30s'), null);
  assert.equal(entrySeconds(''), null);
});

test('the transcript attachment gives back its metadata, chapters and timestamped blocks', () => {
  const markdown = transcriptMarkdown({ id: 'kilnDemo001', url: 'https://www.youtube.com/watch?v=kilnDemo001', title: 'A video', channel: 'Pixel & Pine', durationSeconds: 1104, uploadDate: '20260612', description: '', chapters: [{ title: 'Intro', start: 0 }, { title: 'The prompt', start: 252 }], transcript: '[0:00]\nSo this week\nI tried something.\n[4:12]\nHere’s the prompt.', language: 'en' });
  const video = readTranscript(markdown);
  assert.equal(video.channel, 'Pixel & Pine');
  assert.equal(video.duration, 1104);
  assert.equal(video.published, '2026-06-12');
  assert.deepEqual(video.chapters, [{ start: 0, title: 'Intro' }, { start: 252, title: 'The prompt' }]);
  assert.deepEqual(video.lines, [{ at: 0, text: 'So this week I tried something.' }, { at: 252, text: 'Here’s the prompt.' }]);
});

test('skipped time ranges are read from the analysis note when it names them', () => {
  assert.deepEqual(skippedRanges('Sponsor segment (2:05 to 3:10) and the channel updates at the end.', 1104), [{ from: 125, to: 190, label: 'Sponsor segment' }]);
  assert.deepEqual(skippedRanges('The intro, 0:00–0:40; the outro from 17:42 to the end.', 1104), [{ from: 0, to: 40, label: 'Skipped' }, { from: 1062, to: 1104, label: 'Outro' }]);
  assert.deepEqual(skippedRanges('Nothing with times here.', 1104), []);
  assert.deepEqual(skippedRanges('Backwards 3:10 to 2:05, past the end 30:00 to 31:00.', 1104), []);
});

test('ticks stay readable on long videos and markers that would overlap share a column', () => {
  assert.equal(minuteTicks(1104).filter(t => t.label).length, 10);
  assert.equal(minuteTicks(1104).length, 19);
  assert.ok(minuteTicks(3 * 3600).filter(t => t.label).length <= 10);
  const columns = markerColumns([{ at: 252 }, { at: 260 }, { at: 665 }], 1104);
  assert.deepEqual(columns.map(c => [c.at, c.entries.length]), [[252, 2], [665, 1]]);
});
