import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublishJob, Snapshot } from '../packages/protocol/schema';
import { approvalStatus } from '../apps/desktop/src/approval-status';

const item = { id: 'reviewed-item', revision: 'reviewed-revision' };
const job = (status: PublishJob['status'], extra: Partial<PublishJob> = {}): PublishJob => ({ id: 'publish-job', itemId: item.id, revision: item.revision, title: 'Reviewed item', action: 'approve', status, message: '', composer: '', commit: '', startedAt: '2026-10-30T00:00:00Z', ...extra });
const snapshot = (publish: PublishJob[], ahead = 0, ready = true): Pick<Snapshot, 'publish' | 'git' | 'repository'> => ({ publish, git: { attached: true, branch: 'main', commit: 'head', changes: [], remote: 'origin', ahead, behind: 0 }, repository: { standard: true, dedicated: true, git: true, remote: true, ready } });

test('an approval is not presented as approved until its push succeeds', () => {
  for (const status of ['queued', 'composing', 'committing', 'pushing'] as const) assert.equal(approvalStatus(item, snapshot([job(status)])), 'publishing');
  assert.equal(approvalStatus(item, snapshot([job('failed')])), 'publish_failed');
  assert.equal(approvalStatus(item, snapshot([job('queued'), job('failed')])), 'publishing');
  assert.equal(approvalStatus(item, snapshot([job('done'), job('failed')])), 'approved');
  assert.equal(approvalStatus(item, snapshot([job('failed'), job('done')])), 'publish_failed');
  assert.equal(approvalStatus(item, snapshot([job('done')], 1)), 'approved');
});

test('publication state belongs to the exact item and reviewed revision', () => {
  assert.equal(approvalStatus(item, snapshot([job('done', { revision: 'older-revision' })], 1)), 'publishing');
  assert.equal(approvalStatus(item, snapshot([job('done', { itemId: 'another-item' })], 1)), 'publishing');
  assert.equal(approvalStatus(item, snapshot([job('done', { action: 'unapprove' })], 1)), 'publishing');
  assert.equal(approvalStatus(item, snapshot([], 1)), 'publishing');
  assert.equal(approvalStatus(item, snapshot([])), 'approved');
  assert.equal(approvalStatus(item, snapshot([], 0, false)), 'reviewed_locally');
});
