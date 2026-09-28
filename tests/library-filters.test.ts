import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Installation } from '../packages/protocol/schema';
import { candidateTokens, matchesQuery, narrowest, parseTyped, tokenLabel, type QueryToken } from '../apps/desktop/src/library-filters';
const item = { id: 'a', kind: 'skill', status: 'approved', collection: 'Code/Review', tags: ['review'], favourite: true, origin: null } as unknown as Item;
const copies = [
  { itemId: 'a', location: 'agents', provider: 'codex', scope: 'personal', state: 'installed', linked: false, matches: true },
  { itemId: 'a', location: 'copilot', provider: 'copilot', scope: 'project', state: 'external', linked: true, matches: false },
] as Installation[];
const t = (facet: QueryToken['facet'], value: string): QueryToken => ({ facet, value });
test('copy facets distinguish native copies from shared access and combine on one copy', () => {
  assert.equal(matchesQuery(item, copies.slice(0, 1), [t('provider', 'codex')]), false);
  assert.equal(matchesQuery(item, copies, [t('provider', 'copilot'), t('scope', 'project'), t('state', 'linked')]), true);
  assert.equal(matchesQuery(item, copies, [t('provider', 'copilot'), t('scope', 'personal')]), false);
  assert.equal(matchesQuery(item, copies, [t('in', 'agents'), t('state', 'changed')]), false);
  assert.equal(matchesQuery(item, copies, [t('in', 'copilot'), t('state', 'changed')]), true);
  assert.equal(matchesQuery(item, copies, [t('tag', 'review')]), true);
  assert.equal(matchesQuery(item, copies, [t('tag', 'other')]), false);
});
test('uninstalled native agents match provider but do not invent a local copy', () => {
  const agent = { ...item, kind: 'agent', agent: { provider: 'copilot', filename: 'review.md' } } as Item;
  assert.equal(matchesQuery(agent, [], [t('provider', 'copilot')]), true);
  assert.equal(matchesQuery(agent, [], [t('provider', 'copilot'), t('scope', 'personal')]), false);
});
test('one facet matches either value, different facets must all match', () => {
  assert.equal(matchesQuery(item, [], [t('kind', 'prompt'), t('kind', 'skill')]), true);
  assert.equal(matchesQuery(item, [], [t('kind', 'skill'), t('status', 'captured')]), false);
  assert.equal(matchesQuery(item, [], [t('is', 'favourite'), t('collection', 'Code')]), true, 'a collection token includes its subfolders');
  assert.equal(matchesQuery(item, [], [t('collection', 'Cod')]), false);
});
test('installed, not installed and "not installed in" read the copies', () => {
  assert.equal(matchesQuery(item, copies, [t('state', 'installed')]), true);
  assert.equal(matchesQuery(item, [], [t('state', 'none')]), true);
  assert.equal(matchesQuery(item, copies, [t('state', 'none')]), false);
  assert.equal(matchesQuery(item, copies, [t('state', 'none'), t('in', 'claude')]), true, 'no copy in the Claude folder');
  const prompt = { ...item, kind: 'prompt' } as Item;
  assert.equal(matchesQuery(prompt, [], [t('state', 'none')]), false, 'only skills and agents can be not installed');
});
test('suggestions only offer values that exist, and labels read plainly', () => {
  const offered = candidateTokens([item], copies, []);
  assert.ok(offered.some(o => o.facet === 'in' && o.value === 'copilot'));
  assert.ok(!offered.some(o => o.facet === 'in' && o.value === 'claude'));
  assert.ok(!offered.some(o => o.facet === 'from'));
  assert.equal(tokenLabel(t('status', 'captured')), 'draft');
  assert.equal(tokenLabel(t('in', 'agents')), 'Shared Agents');
  assert.equal(tokenLabel(t('from', 'x'), () => 'A video'), 'A video');
});
test('is:duplicate matches items in a duplicate group and is offered only when there are some', () => {
  const duplicates = new Set([item.id]);
  assert.equal(matchesQuery(item, [], [t('is', 'duplicate')], duplicates), true);
  assert.equal(matchesQuery(item, [], [t('is', 'duplicate')]), false);
  assert.equal(matchesQuery({ ...item, favourite: false } as Item, [], [t('is', 'duplicate'), t('is', 'favourite')], duplicates), true, 'two values of one facet match either');
  assert.ok(candidateTokens([item], [], [], duplicates).some(o => o.facet === 'is' && o.value === 'duplicate'));
  assert.ok(!candidateTokens([item], [], []).some(o => o.facet === 'is' && o.value === 'duplicate'));
  assert.equal(tokenLabel(t('is', 'duplicate')), 'a duplicate');
});
test('the narrowest token is the one whose removal shows the most', () => {
  const counts: Record<string, number> = { 'kind:skill': 3, 'tag:git': 1 };
  const result = narrowest([t('tag', 'git'), t('kind', 'skill')], '', tokens => counts[tokens.map(x => `${x.facet}:${x.value}`).join()] ?? 0);
  assert.deepEqual(result, { token: t('tag', 'git'), count: 3 });
  assert.deepEqual(narrowest([], 'zzz', (_, text) => text ? 0 : 9), { token: null, count: 9 });
});
test('typing facet: narrows the suggestions to that facet', () => {
  assert.deepEqual(parseTyped('Kind:sk'), { facet: 'kind', rest: 'sk' });
  assert.deepEqual(parseTyped('http://x'), { facet: null, rest: 'http://x' });
});
test('stages follow the status, and Installed follows the copies', async () => {
  const { inStage } = await import('../apps/desktop/src/library-filters');
  assert.equal(inStage(item, 'approved', []), true);
  assert.equal(inStage(item, 'drafts', []), false);
  assert.equal(inStage(item, 'installed', []), false);
  assert.equal(inStage(item, 'installed', copies), true);
  assert.equal(inStage(item, '', []), true);
});
