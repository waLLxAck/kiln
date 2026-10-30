import type { Item, Snapshot } from '../../../packages/protocol/schema';

export type ApprovalStatus = 'approved' | 'publishing' | 'publish_failed' | 'reviewed_locally';

export function approvalStatus(item: Pick<Item, 'id' | 'revision'>, snapshot: Pick<Snapshot, 'publish' | 'git' | 'repository'>): ApprovalStatus {
  if (!snapshot.repository.ready) return 'reviewed_locally';
  const job = snapshot.publish.find(entry => entry.itemId === item.id && entry.revision === item.revision && entry.action === 'approve');
  if (job) return job.status === 'done' ? 'approved' : job.status === 'failed' ? 'publish_failed' : 'publishing';
  return snapshot.git.ahead ? 'publishing' : 'approved';
}
