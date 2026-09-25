import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item } from '../packages/protocol/schema';
import { joinAnd, sharedTitleIds, shortenSegments, sourceLabel, titleCollisions } from '../apps/desktop/src/item-source';
const labels = (map: ReturnType<typeof titleCollisions>) => Object.fromEntries([...map].map(([id, value]) => [id, value.label]));

const item = (id: string, title: string, source: string, extra: Partial<Item> = {}) => ({ id, title, source, kind: 'skill', ...extra }) as Item;

test('source labels show imported folders under ~, repository paths and web addresses', () => {
  assert.equal(sourceLabel('local:/home/ada/.codex/skills/.system/skill-creator', '/home/ada'), '~/.codex/skills/.system/skill-creator');
  assert.equal(sourceLabel('local:C:\\Users\\Ada\\.claude\\skills\\review', 'c:\\users\\ada\\'), '~\\.claude\\skills\\review', 'Windows paths keep their separators');
  assert.equal(sourceLabel('local:/home/adam/.claude/skills/review', '/home/ada'), '/home/adam/.claude/skills/review', 'a sibling of home is not under ~');
  assert.equal(sourceLabel('repository:mine/acme/review/SKILL.md'), 'repository mine/acme/review/SKILL.md');
  assert.equal(sourceLabel('https://www.example.com/skills/review/'), 'example.com/skills/review');
  assert.equal(sourceLabel(''), 'captured in Kiln');
});

test('only items sharing a kind and title get a source label, and only when the sources differ', () => {
  const found = titleCollisions([
    item('a', 'skill-creator', 'local:/home/ada/.claude/skills/synced/0c6f/skill-creator'),
    item('b', 'Skill-Creator ', 'local:/home/ada/.codex/skills/.system/skill-creator'),
    item('c', 'review', 'local:/home/ada/.claude/skills/review'),
    item('d', 'review', 'local:/home/ada/.claude/skills/review', { kind: 'prompt' }),
    item('e', 'deploy', 'local:/home/ada/.agents/skills/deploy'),
    item('f', 'deploy', 'local:/home/ada/.agents/skills/deploy'),
    item('g', 'skill-creator', 'local:/tmp/old', { deletedAt: '2026-01-01T00:00:00.000Z' }),
  ], '/home/ada');
  assert.deepEqual(labels(found), { a: '~/.claude/skills/synced/0c6f/skill-creator', b: '~/.codex/skills/.system/skill-creator' });
});

test('imported items whose shared source is only a folder name are told apart by the origin kept on this machine', () => {
  const items = [item('a', 'skill-creator', 'local-import:skill-creator'), item('b', 'skill-creator', 'local-import:skill-creator'), item('c', 'solo', 'local-import:solo')];
  assert.deepEqual(sharedTitleIds(items), ['a', 'b']);
  assert.equal(titleCollisions(items, '/home/ada').size, 0, 'without origins there is nothing to tell them apart');
  const origins = { a: 'local:/home/ada/.claude/skills/synced/0c6f/skill-creator', b: 'local:/home/ada/.codex/skills/.system/skill-creator' };
  assert.deepEqual(labels(titleCollisions(items, '/home/ada', origins)), { a: '~/.claude/skills/synced/0c6f/skill-creator', b: '~/.codex/skills/.system/skill-creator' });
});

test('long folder names are cut short in labels unless that would make two read the same', () => {
  const uuid = 'be0098eb-8b95-415a-ba5c-3c612e9bd3b9_3286232b';
  assert.equal(shortenSegments(`~/.claude/skills/synced/${uuid}/skill-creator`), '~/.claude/skills/synced/be0098eb…/skill-creator');
  assert.equal(shortenSegments('C:\\Users\\ada\\a-very-long-folder-name\\x'), 'C:\\Users\\ada\\a-very-l…\\x');
  const items = [item('a', 'x', `local:/h/.claude/skills/synced/${uuid}/x`), item('b', 'x', 'local:/h/.codex/skills/.system/x')];
  const found = titleCollisions(items, '/h');
  assert.deepEqual(labels(found), { a: '~/.claude/skills/synced/be0098eb…/x', b: '~/.codex/skills/.system/x' });
  assert.equal(found.get('a')!.full, `~/.claude/skills/synced/${uuid}/x`, 'the full folder stays available for the tooltip');
  const alike = titleCollisions([item('a', 'x', 'local:/h/synced/be0098eb-aaaa-bbbb-cccc/x'), item('b', 'x', 'local:/h/synced/be0098eb-dddd-eeee-ffff/x')], '/h');
  assert.deepEqual(labels(alike), { a: '~/synced/be0098eb-aaaa-bbbb-cccc/x', b: '~/synced/be0098eb-dddd-eeee-ffff/x' });
  assert.equal(joinAnd(['A']), 'A'); assert.equal(joinAnd(['A', 'B']), 'A and B'); assert.equal(joinAnd(['A', 'B', 'C']), 'A, B and C');
});
