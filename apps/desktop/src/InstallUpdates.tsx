import { useState } from 'react';
import { CircleArrowUp, Save } from 'lucide-react';
import type { Installation, Item, Snapshot } from '../../../packages/protocol/schema';
import { api, shortHash } from './api';
import { InlineError, Modal } from './components';

// Experimental: installUpdates ("Update installed copies") and keepOutsideEdits ("Keep changes made outside Kiln").
type Copy = { label: string; destination: string; targetId: string };
export type UpdateResult = { itemId: string; revision: string; approved: boolean; updated: Copy[]; adopted: Copy[]; current: number; skipped: (Copy & { reason: string })[] };
export type KeepResult = { itemId: string; revision: string; destination: string; label: string; summary: string; exact: boolean; ignored: string[] };
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
/** Copies whose contents "Keep these changes" can bring into the item: edited after Kiln installed them, or external and different. */
export const canKeep = (copy?: Installation) => Boolean(copy && copy.targetId && !copy.linked && (copy.state === 'drifted' || (copy.state === 'external' && !copy.matches)));
export const keepExplanation = 'Keep these changes saves this folder as a new draft of the same item, so nothing edited here is lost. The folder is left as it is; you can then approve the draft and install it everywhere.';
/** "Keep these changes" button; on success the caller shows `KeptDialog` in place of its own. */
export function KeepButton({ item, targetId, disabled, onKept, onError }: { item: Item; targetId: string; disabled?: boolean; onKept: (result: KeepResult) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  return <button className="button" disabled={disabled || busy} title={keepExplanation} onClick={async () => { setBusy(true); onError(''); try { onKept(await api<KeepResult>('deploy.keepCopy', { itemId: item.id, targetId, expect: item.revision })); } catch (e) { onError(e instanceof Error ? e.message : String(e)); setBusy(false); } }}><Save size={14} />{busy ? 'Keeping…' : 'Keep these changes'}</button>;
}
/**
 * After keeping: the draft is saved, and the next step is offered. Approve & install approves it and records the folder as installed
 * without rewriting it, and the other copies Kiln installed are updated to it in the same step.
 */
export function KeptDialog({ item, targetId, result, settings, onDone }: { item: Item; targetId: string; result: KeepResult; settings: Settings; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const later = `${item.title}: kept the ${result.label} copy as a new draft (${shortHash(result.revision)}). Approve it when you are ready.`;
  const approve = async () => {
    setBusy(true); setError('');
    try {
      await api('deploy.approveKept', { itemId: item.id, targetId, expect: result.revision });
      const lead = `${item.title}: approved revision ${shortHash(result.revision)}; the ${result.label} copy is now the installed version, left exactly as it was.`;
      onDone(`${lead} ${updateMessage('', await api<UpdateResult>('skills.update', { itemId: item.id }), true)}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return <Modal title="Changes kept as a draft" subtitle={item.title} onClose={() => onDone(later)}>
    <code className="path-text">{result.destination}</code>
    <p>The {result.label} copy is now a new draft revision of “{item.title}”, noted as <b>{result.summary}</b>. The folder was not changed.</p>
    {result.ignored.length > 0 && <p className="notice warning">Not kept, as when importing: {result.ignored.join(', ')}.{!result.exact && ' Because the folder holds files Kiln does not keep, it will still read as edited; reinstalling later replaces it.'}</p>}
    {result.exact && <p>{'Approve & update installs approves this draft, records this folder as installed without rewriting it, and updates the other copies Kiln installed. Copies edited outside Kiln are left alone.'}</p>}
    <InlineError error={error} />
    <div className="modal-actions"><button className="button" onClick={() => onDone(later)}>Not now</button>{result.exact && <button className="button primary" disabled={busy} onClick={() => void approve()}>{'Approve & update installs'}</button>}</div>
  </Modal>;
}
