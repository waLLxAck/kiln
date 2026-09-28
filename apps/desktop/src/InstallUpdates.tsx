import { CircleArrowUp } from 'lucide-react';
import type { Installation, Item, Snapshot } from '../../../packages/protocol/schema';
import { api, shortHash } from './api';

// Update installed copies. Keep these changes (for copies edited outside Kiln) is in KeepChanges.tsx.
type Copy = { label: string; destination: string; targetId: string };
export type UpdateResult = { itemId: string; revision: string; approved: boolean; updated: Copy[]; adopted: Copy[]; current: number; skipped: (Copy & { reason: string })[] };
type Settings = Snapshot['settings'] | undefined;

const list = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
/** What an update did, for the toast: updated, adopted and skipped copies, and the new-session reminder when anything changed. */
export function updateMessage(title: string, result: UpdateResult, quiet = false) {
  const parts = result.approved ? [`Approved revision ${shortHash(result.revision)}.`] : [];
  if (result.updated.length) parts.push(`Updated ${list(result.updated.map(c => c.label))} to revision ${shortHash(result.revision)}.`);
  if (result.adopted.length) parts.push(`${list(result.adopted.map(c => c.label))} already matched and ${result.adopted.length === 1 ? 'is' : 'are'} now managed by Kiln.`);
  if (!quiet && !result.updated.length && !result.adopted.length) parts.push('No installed copy needed updating.');
  if (result.skipped.length) parts.push(`Skipped ${result.skipped.map(c => `${c.label} (${c.reason})`).join('; ')}.`);
  if (quiet || result.updated.length || result.approved) parts.push('New agent sessions pick up the change.');
  return `${title}${title ? ': ' : ''}${parts.join(' ')}`;
}
/** Updates every Kiln-written copy that is behind; `approve` approves the current revision first. */
export async function updateInstalls(item: Item, approve: boolean) {
  return updateMessage(item.title, await api<UpdateResult>('skills.update', { itemId: item.id, approve, expect: item.revision }));
}
/**
 * Item header primary action while Kiln manages at least one copy: "Approve & update installs" for a
 * draft, "Update installs (N)" when approved copies are behind. Null means the header keeps its usual button.
 */
export function installUpdatesButton({ settings, item, approved, copies, onAction }: { settings: Settings; item: Item; approved: boolean; copies: Installation[]; onAction: (name: string) => void }) {
  if (item.deletedAt || !copies.some(c => c.state === 'installed')) return null;
  const behind = copies.filter(c => c.outdated).length;
  if (!approved) return <button className="button primary" title="Approve this revision, then update every copy Kiln installed. Copies edited outside Kiln are left alone." onClick={() => onAction('approve-update-installs')}><CircleArrowUp size={15} />Approve & update installs</button>;
  if (behind) return <button className="button primary" title="Install the approved revision over copies Kiln installed earlier. Copies edited outside Kiln are left alone." onClick={() => onAction('update-installs')}><CircleArrowUp size={15} />Update installs ({behind})</button>;
  return null;
}
