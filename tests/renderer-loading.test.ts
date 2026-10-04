import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Snapshot } from '../packages/protocol/schema';
import { busyLine, coalesce, detailReducer, errorText, focusReloads, idleDetail, isTimeout, itemStamp, jobsSignature, pendingPublish, publishSignature, searchState, type DetailState } from '../apps/desktop/src/load-state';
import { date } from '../apps/desktop/src/dates';
import { railCounts } from '../apps/desktop/src/library-filters';

type Detail = { item: { id: string }; n: number };
const reduce = detailReducer<Detail>;

test('opening an item loads it; a failure without anything shown is an error, not an endless spinner', () => {
  let state = reduce(idleDetail as DetailState<Detail>, { type: 'open', id: 'a', at: 100 });
  assert.equal(state.status, 'loading'); assert.equal(state.since, 100); assert.equal(state.data, null);
  state = reduce(state, { type: 'failed', id: 'a', error: 'TIMEOUT: Kiln did not answer' });
  assert.equal(state.status, 'error'); assert.equal(state.error, 'TIMEOUT: Kiln did not answer');
  // Retry starts loading again, then the reply shows the item.
  state = reduce(state, { type: 'open', id: 'a', at: 200 });
  assert.equal(state.status, 'loading'); assert.equal(state.since, 200);
  state = reduce(state, { type: 'loaded', id: 'a', data: { item: { id: 'a' }, n: 1 } });
  assert.equal(state.status, 'ready'); assert.equal(state.data?.n, 1);
});

test('reading the shown item again keeps it on screen, even when that read fails', () => {
  let state = reduce(reduce(idleDetail as DetailState<Detail>, { type: 'open', id: 'a', at: 1 }), { type: 'loaded', id: 'a', data: { item: { id: 'a' }, n: 1 } });
  const again = reduce(state, { type: 'open', id: 'a', at: 2 });
  assert.equal(again, state, 'same state object: nothing re-renders');
  state = reduce(again, { type: 'failed', id: 'a', error: 'busy' });
  assert.equal(state.status, 'ready'); assert.equal(state.data?.n, 1);
});

test('replies for an item that is no longer open are ignored; another item starts empty', () => {
  let state = reduce(idleDetail as DetailState<Detail>, { type: 'open', id: 'a', at: 1 });
  state = reduce(state, { type: 'open', id: 'b', at: 2 });
  assert.equal(reduce(state, { type: 'loaded', id: 'a', data: { item: { id: 'a' }, n: 1 } }), state);
  assert.equal(reduce(state, { type: 'failed', id: 'a', error: 'x' }), state);
  assert.equal(reduce(state, { type: 'clear' }).status, 'idle');
});

test('the library loader runs once at a time and once more for everyone who asked meanwhile', async () => {
  let runs = 0; const gates: (() => void)[] = [];
  const load = coalesce(() => { runs++; return new Promise<void>(resolve => gates.push(resolve)); });
  const first = load(), second = load(), third = load();
  assert.equal(runs, 1);
  assert.equal(second, third, 'callers during a run share the next one');
  gates[0](); await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 2, 'the follow-up starts after the first finishes');
  gates[1](); await second;
  assert.equal(runs, 2);
  const later = load(); assert.equal(runs, 3); gates[2](); await later;
});

test('a failed load still lets the follow-up run, and the next call starts fresh', async () => {
  let runs = 0;
  const load = coalesce(async () => { runs++; if (runs === 1) throw new Error('boom'); });
  const first = load(), second = load();
  await assert.rejects(first, /boom/); await second;
  assert.equal(runs, 2);
  await load(); assert.equal(runs, 3);
});

test('focus reloads only when shown and not within a few seconds of the last load', () => {
  assert.equal(focusReloads(10_000, 6_000, false), false);
  assert.equal(focusReloads(11_000, 6_000, false), true);
  assert.equal(focusReloads(60_000, 0, true), false);
});

test('the jobs signature ignores a poll that changed nothing on screen, and sees steps, phases and Tune state', () => {
  const job = { id: 'j', status: 'running' as const, phase: 'Reading', steps: [{}, {}] as never[], lastActivityAt: 't1' };
  assert.equal(jobsSignature([job]), jobsSignature([{ ...job, steps: [{}, {}] as never[] }]));
  assert.notEqual(jobsSignature([job]), jobsSignature([{ ...job, phase: 'Writing' }]));
  assert.notEqual(jobsSignature([job]), jobsSignature([{ ...job, lastActivityAt: 't2' }]));
  // Summaries without steps count by stepCount.
  assert.equal(jobsSignature([{ id: 'j', status: 'running', phase: 'Reading', stepCount: 2, lastActivityAt: 't1' }]), jobsSignature([job]));
  assert.notEqual(jobsSignature([{ ...job, status: 'completed', tune: { state: 'ready' } as never }]), jobsSignature([{ ...job, status: 'completed', tune: { state: 'accepted' } as never }]));
});

test('publish helpers: pending jobs and a signature of statuses', () => {
  const jobs = [{ id: 'a', status: 'pushing' as const }, { id: 'b', status: 'done' as const }, { id: 'c', status: 'failed' as const }];
  assert.deepEqual(pendingPublish(jobs).map(j => j.id), ['a']);
  assert.equal(publishSignature(jobs), 'a:pushing|b:done|c:failed');
});

test('the item stamp changes with the item, its approvals and finished runs, not with other items', () => {
  const item = (id: string, extra: Partial<Item> = {}) => ({ id, revision: 'r1', updatedAt: 't1', title: id, ...extra }) as Item;
  const snapshot = (items: Item[], extra: Partial<Snapshot> = {}) => ({ items, approvals: [], trials: [], scores: {}, duplicates: [], usage: {}, ...extra }) as unknown as Snapshot;
  const base = itemStamp(snapshot([item('a'), item('b')]), 'a');
  assert.equal(itemStamp(snapshot([item('a'), item('b', { title: 'renamed' })]), 'a'), base);
  assert.notEqual(itemStamp(snapshot([item('a', { revision: 'r2' }), item('b')]), 'a'), base);
  assert.notEqual(itemStamp(snapshot([item('a')], { approvals: [{ itemId: 'a', revision: 'r1' }] as never }), 'a'), itemStamp(snapshot([item('a')]), 'a'));
  const running = [{ id: 'j', itemId: 'a', status: 'running' as const }];
  assert.equal(itemStamp(snapshot([item('a')]), 'a', running), itemStamp(snapshot([item('a')]), 'a'));
  assert.notEqual(itemStamp(snapshot([item('a')]), 'a', [{ ...running[0], status: 'completed' }]), itemStamp(snapshot([item('a')]), 'a'));
  assert.equal(itemStamp(snapshot([item('a')]), 'missing'), '');
});

test('the waiting line names what the backend is busy with', () => {
  assert.equal(busyLine(null), '');
  assert.equal(busyLine({ pending: 1 }), '');
  assert.equal(busyLine({ pending: 3, running: { method: 'items.update', ms: 12_400 } }), 'busy with items.update for 12 s · 3 requests waiting');
  assert.equal(busyLine({ pending: 1, running: { method: 'startup', ms: 2_000 } }), 'opening the library (2 s)');
  assert.match(busyLine({ pending: 0, restarting: true }), /restarting/);
  assert.equal(isTimeout(new Error('TIMEOUT: Kiln took too long to answer')), true);
  assert.equal(isTimeout(new Error('ITEM_NOT_FOUND: gone')), false);
  assert.equal(errorText(new Error('BACKEND_RESTARTING: Kiln is restarting')), 'Kiln is restarting');
});

test('the cached date formatter matches toLocaleString, adds the year only for other years, and survives bad input', () => {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const now = new Date(); now.setMonth(0, 15);
  assert.equal(date(now.toISOString()), now.toLocaleString(undefined, options));
  const old = new Date('2019-06-01T08:30:00Z');
  assert.equal(date(old.toISOString()), old.toLocaleString(undefined, { ...options, year: 'numeric' }));
  assert.equal(date('not a date'), 'Invalid Date');
});

test('rail counts: one pass gives the library, stages, nested collections, archive and trash', () => {
  const item = (id: string, extra: Partial<Item>) => ({ id, status: 'captured', collection: '', deletedAt: null, ...extra }) as Item;
  const items = [item('a', { collection: 'Work/Docs' }), item('b', { collection: 'Work' }), item('c', {}), item('d', { status: 'archived', collection: 'Work' }), item('e', { deletedAt: 't' }), item('f', { status: 'approved', collection: 'Home' })];
  const counts = railCounts(items, i => i.status === 'archived' || i.status === 'rejected', (i, stage) => stage === 'drafts' ? i.status === 'captured' : stage === 'approved' && i.status === 'approved');
  assert.deepEqual({ library: counts.library, unfiled: counts.unfiled, archive: counts.archive, trash: counts.trash }, { library: 4, unfiled: 1, archive: 1, trash: 1 });
  assert.deepEqual(Object.fromEntries(counts.collections), { Work: 2, 'Work/Docs': 1, Home: 1 });
  assert.deepEqual(counts.stages, { drafts: 3, approved: 1 });
});

test('a search runs from the keystroke until its answer is in, with no gap while the list catches up with the box', () => {
  const remember = { query: 'Remember', ids: ['a', 'b'], close: false };
  // Typed, but the deferred list still shows the unfiltered view: already searching, so nothing takes it for the results.
  assert.deepEqual(searchState('Remember', '', null, null), { searchIds: null, close: false, searching: true });
  // The list has caught up and the debounced search is on its way.
  assert.deepEqual(searchState('Remember', 'Remember', null, null), { searchIds: null, close: false, searching: true });
  assert.deepEqual(searchState('Remember', 'Remember', remember, null), { searchIds: ['a', 'b'], close: false, searching: false });
  // A longer query keeps the previous results on screen until its own answer replaces them.
  assert.deepEqual(searchState('Remember 2', 'Remember 2', remember, null), { searchIds: ['a', 'b'], close: false, searching: true });
  // Re-reading the same query after an edit is not a new search; a failed one stops the spinner.
  assert.equal(searchState('  Remember ', 'Remember', remember, null).searching, false);
  assert.equal(searchState('Other', 'Other', remember, 'Other').searching, false);
  // Clearing the box: nothing to search for, even before the list has caught up.
  assert.deepEqual(searchState('', 'Remember', remember, null), { searchIds: ['a', 'b'], close: false, searching: false });
  assert.deepEqual(searchState('', '', remember, null), { searchIds: null, close: false, searching: false });
});
