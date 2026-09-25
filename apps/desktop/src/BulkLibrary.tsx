import { useEffect, useState } from 'react';
import type { RemovalPlan } from '../../../packages/deployment/service';
import { api } from './api';
import { InlineError, Modal } from './components';

export function BulkRemovalDialog({ itemIds, onClose, onDone }: { itemIds: string[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [plan, setPlan] = useState<RemovalPlan | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempted, setAttempted] = useState(false);
  const preview = async () => { setBusy(true); setError(''); try { setPlan(await api('skills.previewRemoval', { itemIds })); setAttempted(false); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  useEffect(() => { void preview(); }, []);
  const remove = async () => { if (!plan) return; setBusy(true); setError(''); try { setPlan(await api('skills.removeAllLocal', { planId: plan.id, confirm: true })); setAttempted(true); await onDone(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const count = plan?.entries.filter(e => e.method !== 'blocked' && !e.result).length ?? 0;
  return <Modal title="Remove local copies" subtitle={`${itemIds.length} selected library items`} onClose={() => { if (!busy) onClose(); }} wide>
    <p>Remove all detected skill and agent copies for these items across configured personal and project folders, including other providers. Your filters selected the items; removal covers all their locations. Library items, approvals and history stay.</p>
    <p className="small muted">Matching Kiln copies are deleted. Other copies are moved to a private backup. Links are removed without deleting their destination. Files changed since this preview are skipped. This does not scan the entire computer.</p>
    <InlineError error={error} />
    {!plan ? <p>Checking local copies…</p> : <><p><b>{plan.entries.length} local copies</b>{!plan.entries.length && ' — none found in configured folders'}</p><div className="inventory-list">{plan.entries.map(entry => <div key={entry.destination}><div><b>{entry.title}</b><code className="path-text">{entry.destination}</code><small>{entry.error || entry.result || entry.reason || (entry.method === 'delete' ? 'Delete matching copy' : entry.method === 'unlink' ? 'Remove link only' : 'Move copy to private backup')}</small></div></div>)}</div></>}
    <div aria-live="polite" className="small muted">{busy && plan ? 'Removing copies…' : attempted ? `${plan?.entries.filter(e => e.result).length ?? 0} handled; ${plan?.entries.filter(e => e.error).length ?? 0} skipped.` : ''}</div>
    <div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>{attempted ? 'Done' : 'Cancel'}</button>{attempted && !plan?.complete ? <button className="button" disabled={busy} onClick={() => void preview()}>Refresh preview</button> : !attempted && <button className="button primary" disabled={busy || !count} onClick={() => void remove()}>Remove {count} local copies</button>}</div>
  </Modal>;
}
