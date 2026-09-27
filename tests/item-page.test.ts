import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Activity, Approval, Installation, Item, ItemDetail, PublishJob, Receipt, Revision, Trial } from '../packages/protocol/schema';
import { primaryAction, splitFrontMatter } from '../apps/desktop/src/item-page';
import { buildHistory, dayLabel, historyFilters, revisionAuthor, trialProject } from '../apps/desktop/src/history-model';

const hash = (c: string) => c.repeat(64);
const item = (extra: Partial<Item> = {}) => ({ id: 'item', kind: 'skill', title: 'review', status: 'captured', revision: hash('b'), deletedAt: null, origin: null, tags: [], collection: '', ...extra }) as Item;
const revision = (h: string, at: string, summary = 'Edited', extra: Partial<Revision> = {}) => ({ hash: h, createdAt: at, summary, author: 'ada', source: '', content: '', files: {}, ...extra }) as Revision;
const trial = (extra: Partial<Trial> = {}) => ({ id: 't1', itemId: 'item', revision: hash('b'), provider: 'claude', model: 'opus', case: 'typical', workspace: '/home/ada/projects/my-game', status: 'completed', judgement: 'pass', note: '', task: '', rubric: [], createdAt: '2026-09-25T10:00:00.000Z', completedAt: '2026-09-25T10:05:00.000Z', ...extra }) as Trial;
const approval = (revisionHash: string, at = '2026-09-25T11:00:00.000Z') => ({ schemaVersion: 1, id: `a-${revisionHash[0]}`, itemId: 'item', revision: revisionHash, reviewer: 'Local user', scope: 'Current revision', note: '', waivedChecks: '', evidence: [], createdAt: at, trust: 'local' }) as Approval;
const detail = (extra: Partial<ItemDetail> = {}): ItemDetail => ({ item: item(), revision: revision(hash('b'), '2026-09-25T09:00:00.000Z', 'Edited', { content: 'Hello' }), revisions: [], approvals: [], trials: [], observations: [], validation: [], duplicates: [], analyses: [], ...extra });
const copy = (state: Installation['state']): Installation => ({ itemId: 'item', targetId: 'claude', provider: 'claude', destination: '/home/ada/.claude/skills/review', state, linked: false, matches: state === 'installed', receiptId: null, location: 'claude', scope: 'personal' });

test('front-matter becomes ordered properties and the body follows it', () => {
  const parsed = splitFrontMatter('---\nname: review\ndescription: Review a change\n  before merging.\nallowed-tools: Read, Grep\n---\n\n# Review\nRead the diff.');
  assert.deepEqual(parsed.properties, [['name', 'review'], ['description', 'Review a change before merging.'], ['allowed-tools', 'Read, Grep']]);
  assert.equal(parsed.body, '\n# Review\nRead the diff.');
  assert.deepEqual(splitFrontMatter('No front-matter\n---\nhere'), { properties: [], body: 'No front-matter\n---\nhere' });
  assert.equal(splitFrontMatter('---\r\nname: x\r\n---\r\nBody').body, 'Body', 'Windows line endings are read too');
});

test('the header offers one next step chosen from the item state', () => {
  assert.equal(primaryAction({ detail: detail(), installations: [], locations: 2 }), 'test', 'an untested skill draft is tested first');
  assert.equal(primaryAction({ detail: detail({ trials: [trial()] }), installations: [], locations: 2 }), 'approve-install', 'a passing skill nobody installed is approved and installed');
  assert.equal(primaryAction({ detail: detail({ trials: [trial()] }), installations: [copy('installed')], locations: 2 }), 'approve', 'a passing draft of an installed skill is approved');
  assert.equal(primaryAction({ detail: detail({ trials: [trial({ judgement: 'fail' })] }), installations: [], locations: 2 }), 'test', 'a failed draft is tested again');
  assert.equal(primaryAction({ detail: detail({ approvals: [approval(hash('b'))] }), installations: [], locations: 2 }), 'install');
  assert.equal(primaryAction({ detail: detail({ approvals: [approval(hash('b'))] }), installations: [copy('installed')], locations: 2 }), 'copy');
  assert.equal(primaryAction({ detail: detail({ approvals: [approval(hash('b'))] }), installations: [copy('drifted')], locations: 2 }), 'resolve', 'changed copies come before everything else');
  assert.equal(primaryAction({ detail: detail({ item: item({ kind: 'prompt' }) }), installations: [], locations: 2 }), 'copy', 'an untested prompt is copied');
  assert.equal(primaryAction({ detail: detail({ item: item({ kind: 'prompt' }), trials: [trial()] }), installations: [], locations: 2 }), 'approve');
  assert.equal(primaryAction({ detail: detail({ item: item({ kind: 'link' }) }), installations: [], locations: 2 }), 'open-link');
  assert.equal(primaryAction({ detail: detail({ item: item({ kind: 'source' }), revision: revision(hash('b'), '', '', { content: 'https://youtu.be/x' }) }), installations: [], locations: 0 }), 'open-original');
  assert.equal(primaryAction({ detail: detail({ item: item({ kind: 'source' }) }), installations: [], locations: 0 }), 'analyze');
  assert.equal(primaryAction({ detail: detail({ item: item({ deletedAt: '2026-09-26T00:00:00.000Z' }) }), installations: [], locations: 2 }), 'restore');
});

test('history is one newest-first timeline of revisions, tests, approvals, publishes, installs and drift', () => {
  const b = hash('b'), a = hash('a');
  const receipt = { id: 'r1', itemId: 'item', revision: b, targetId: 'claude', destination: '/x', status: 'applied', createdAt: '2026-09-25T11:00:00.000Z' } as Receipt;
  const publish = { id: 'p1', itemId: 'item', revision: b, action: 'approve', status: 'done', commit: 'c0ffee', message: 'Approve review', startedAt: '2026-09-25T11:00:01.000Z', finishedAt: '2026-09-25T11:00:05.000Z' } as PublishJob;
  const activity: Activity[] = [
    { id: 'x1', at: '2026-09-26T08:00:00.000Z', itemId: 'item', kind: 'uninstalled', message: 'Uninstalled', revision: b },
    { id: 'x2', at: '2026-09-26T09:00:00.000Z', itemId: 'other', kind: 'uninstalled', message: 'Not this item' },
    { id: 'x3', at: '2026-09-24T00:00:00.000Z', itemId: 'item', kind: 'revised', message: 'Already a revision event' },
  ];
  const events = buildHistory(detail({
    revisions: [revision(b, '2026-09-25T09:00:00.000Z'), revision(a, '2026-09-20T09:00:00.000Z', 'Imported from ~/.claude/skills')],
    trials: [trial(), trial({ id: 't2', deletedAt: '2026-09-26T00:00:00.000Z' })],
    approvals: [approval(b, '2026-09-25T11:00:00.000Z')],
  }), { receipts: [receipt, { ...receipt, id: 'r2', itemId: 'other' }], publish: [publish], activity }, [copy('drifted'), { ...copy('drifted'), itemId: 'other' }]);
  assert.deepEqual(events.map(e => e.type), ['drift', 'removed', 'published', 'installed', 'approved', 'test', 'revision', 'revision']);
  const revisions = events.filter(e => e.type === 'revision');
  assert.deepEqual(revisions.map(e => e.type === 'revision' && [e.current, e.approved, e.author]), [[true, true, 'person'], [false, false, 'import']]);
  for (const filter of historyFilters.slice(1)) assert.ok(events.some(e => filter.types.includes(e.type)), `${filter.label} matches something`);
});

test('revision authors, day separators and trial projects read plainly', () => {
  assert.equal(revisionAuthor(revision(hash('a'), '', 'External file edit'), false, false), 'outside');
  assert.equal(revisionAuthor(revision(hash('a'), '', 'Captured into library'), true, true), 'agent');
  assert.equal(revisionAuthor(revision(hash('a'), '', 'Captured into library', { source: 'local:/home/ada/.claude/skills/x' }), true, false), 'import');
  assert.equal(revisionAuthor(revision(hash('a'), '', 'Filed as insight'), false, false), 'kiln');
  const now = new Date(2026, 8, 27, 15, 0);
  assert.equal(dayLabel(new Date(2026, 8, 27, 1, 0).toISOString(), now), 'Today');
  assert.equal(dayLabel(new Date(2026, 8, 26, 23, 0).toISOString(), now), 'Yesterday');
  assert.match(dayLabel(new Date(2024, 8, 20).toISOString(), now), /2024/);
  assert.equal(dayLabel('', now), 'Now');
  assert.equal(trialProject(trial({ workspace: 'C:\\Users\\ada\\game\\' })), 'game');
  assert.equal(trialProject(trial({ workspace: '' })), 'Isolated example');
});
