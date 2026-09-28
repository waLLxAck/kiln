import { useState } from 'react';
import { Save } from 'lucide-react';
import type { Installation, Item } from '../../../packages/protocol/schema';
import { api, shortHash } from './api';
import { InlineError, Modal } from './components';
import { updateMessage, type UpdateResult } from './InstallUpdates';

/**
 * Keep these changes: a copy edited outside Kiln (or a different copy of the same skill) is saved as a new draft of the
 * item, and approving that draft adopts the folder as the installed copy without rewriting it. Offered in the Compare
 * dialog, the location dialog, the item page's Installs rail and the Machines cell popover for this machine.
 */
export type KeepResult = { itemId: string; revision: string; destination: string; label: string; summary: string; exact: boolean; ignored: string[] };

/** Copies whose contents can be kept: edited after Kiln installed them, or external and different. */
export const canKeep = (copy?: Installation) => Boolean(copy && copy.targetId && !copy.linked && (copy.state === 'drifted' || (copy.state === 'external' && !copy.matches)));
export const keepExplanation = 'Keep these changes saves this folder as a new draft of the same item, so nothing edited here is lost. The folder is left as it is; you can then approve the draft and install it everywhere.';

const conflicted = (error: unknown) => String(error instanceof Error ? error.message : error).startsWith('REVISION_CONFLICT');
const plain = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^[A-Z_]+: /, '');
/**
 * Saves the copy as a draft of the revision the user was looking at. When the item changed in the meantime nothing is
 * overwritten: `reload` brings the new revision in and the user keeps the copy again after looking at it.
 */
async function keepCopy(item: Item, targetId: string, reload?: () => Promise<void>) {
  try { return await api<KeepResult>('deploy.keepCopy', { itemId: item.id, targetId, expect: item.revision }); }
  catch (error) {
    if (!conflicted(error) || !reload) throw new Error(plain(error));
    await reload();
    throw new Error(`${item.title} changed since you opened it, so nothing was kept. Kiln reloaded it: compare the copy again, then keep it.`);
  }
}

/** The "Keep these changes" button inside a dialog; on success the dialog shows `KeptDialog` in its place. */
export function KeepButton({ item, targetId, disabled, onKept, onError, reload }: { item: Item; targetId: string; disabled?: boolean; onKept: (result: KeepResult) => void; onError: (message: string) => void; /** Re-reads the library when the item changed meanwhile. */ reload?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <button className="button" disabled={disabled || busy} title={keepExplanation} onClick={async () => { setBusy(true); onError(''); try { onKept(await keepCopy(item, targetId, reload)); } catch (e) { onError(plain(e)); setBusy(false); } }}><Save size={14} />{busy ? 'Keeping…' : 'Keep these changes'}</button>;
}

/**
 * After keeping: the draft is saved and the next step offered. Approving records the folder as installed without rewriting
 * it, and updates the other copies Kiln installed in the same step ("Approve & update installs" when there are any).
 */
export function KeptDialog({ item, targetId, result, installations, onDone }: { item: Item; targetId: string; result: KeepResult; /** Known copies, to name the button after what it does. */ installations?: Installation[]; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const others = installations ? installations.filter(c => c.itemId === item.id && c.targetId !== targetId && c.state === 'installed').length : 1;
  const label = others ? 'Approve & update installs' : 'Approve & install';
  const later = `${item.title}: kept the ${result.label} copy as a new draft (${shortHash(result.revision)}). Approve it when you are ready.`;
  const approve = async () => {
    setBusy(true); setError('');
    try {
      await api('deploy.approveKept', { itemId: item.id, targetId, expect: result.revision });
      const lead = `${item.title}: approved revision ${shortHash(result.revision)}; the ${result.label} copy is now the installed version, left exactly as it was.`;
      onDone(`${lead} ${updateMessage('', await api<UpdateResult>('skills.update', { itemId: item.id }), true)}`);
    } catch (e) { setError(plain(e)); setBusy(false); }
  };
  return <Modal title="Changes kept as a draft" subtitle={item.title} onClose={() => onDone(later)}>
    <code className="path-text">{result.destination}</code>
    <p>The {result.label} copy is now a new draft revision of “{item.title}”, noted as <b>{result.summary}</b>. The folder was not changed.</p>
    {result.ignored.length > 0 && <p className="notice warning">Not kept, as when importing: {result.ignored.join(', ')}.{!result.exact && ' Because the folder holds files Kiln does not keep, it will still read as edited; reinstalling later replaces it.'}</p>}
    {result.exact && <p>{label} approves this draft and records this folder as installed without rewriting it{others ? ', then updates the other copies Kiln installed. Copies edited outside Kiln are left alone.' : '.'}</p>}
    <InlineError error={error} />
    <div className="modal-actions"><button className="button" onClick={() => onDone(later)}>Not now</button>{result.exact && <button className="button primary" disabled={busy} onClick={() => void approve()}>{label}</button>}</div>
  </Modal>;
}

/**
 * Keep these changes started from a single button (the Installs rail, Machines, Compare): keeps the copy, then shows
 * `KeptDialog`. `dialog` is rendered once by the app, outside any popover that closes on the next click.
 */
export function useKeepChanges({ items, installations, perform, refresh, onMessage }: { items: Item[]; installations: Installation[]; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>; onMessage: (message: string) => void }) {
  const [kept, setKept] = useState<{ item: Item; targetId: string; result: KeepResult } | null>(null);
  const keep = (itemId: string, targetId: string) => {
    const item = items.find(i => i.id === itemId);
    if (item) void perform(async () => { const result = await keepCopy(item, targetId, refresh); setKept({ item, targetId, result }); await refresh(); });
  };
  const dialog = kept && <KeptDialog item={kept.item} targetId={kept.targetId} result={kept.result} installations={installations} onDone={message => { setKept(null); onMessage(message); void refresh(); }} />;
  return { keep, dialog };
}
