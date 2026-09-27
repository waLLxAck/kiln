import { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { Item, Snapshot } from '../../../packages/protocol/schema';
import { api } from './api';
import { UndoToast } from './UndoToast';
import { fieldOf, fieldRequests, planUndo, progressLabel, pushUndo, runBatched, undoLabel, undoneLabel, type UndoChange, type UndoEntry, type UndoField, type UndoValue } from './keyboard-undo';

/** What to set on one item: `{ deleted }`, `{ status }` or `{ favourite }`; null leaves it alone. */
type Patch = Record<string, unknown> | null;
type Options = { on: boolean; root: string | undefined; perform: (action: () => Promise<unknown>) => Promise<void>; refresh: () => Promise<void>; setMessage: (message: string) => void };
const failure = (failed: { error: unknown }[], total: number, verb: string) => { const reason = failed[0].error instanceof Error ? (failed[0].error as Error).message : String(failed[0].error); return new Error(`${failed.length} of ${total} item${total === 1 ? '' : 's'} could not be ${verb}: ${reason.replace(/^[A-Z_]+: /, '')}`); };

/**
 * Experimental keyboardUndo: the last 20 library actions (trash, restore, status, favourite, collection moves) and the
 * toasts that go with them. Changes run in small batches with a progress toast; an undo only touches items still as the
 * action left them. Cleared when the library changes or the flag goes off.
 */
export function useUndoStack({ on, root, perform, refresh, setMessage }: Options) {
  const [stack, setStack] = useState<UndoEntry[]>([]), stackRef = useRef(stack); stackRef.current = stack;
  const [toast, setToast] = useState<UndoEntry | null>(null), [progress, setProgress] = useState<string | null>(null);
  const running = useRef(false), nextId = useRef(1);
  useEffect(() => { setStack([]); setToast(null); }, [root, on]);
  /** Remembers an action that already happened, and offers to undo it. */
  const record = (label: string, changes: UndoChange[]) => { if (!changes.length) return; const entry = { id: nextId.current++, label, changes }; stackRef.current = pushUndo(stackRef.current, entry); setStack(stackRef.current); setToast(entry); };
  /** Sets fields in batches, showing "Moving 12 of 40…" while more than one item is involved. Returns the changes that went through. */
  const execute = async <C extends { id: string; expect: string; field: UndoField; to: UndoValue }>(changes: C[], label: (done: number, total: number) => string) => {
    const requests = fieldRequests(changes), total = changes.length;
    if (total > 1) setProgress(label(0, total));
    try {
      const { succeeded, failed } = await runBatched(requests, request => api(request.method, request.args), { weight: request => request.ids.length, onProgress: done => { if (total > 1) setProgress(label(done, total)); } });
      const through = new Set(succeeded.flatMap(r => r.ids));
      return { done: changes.filter(c => through.has(c.id)), failed };
    } finally { setProgress(null); }
  };
  /** Changes one field on each item, as a single undoable action. `patch` says what to set on an item, or null to leave it. */
  const apply = (items: Item[], patch: (item: Item) => Patch) => perform(async () => {
    const changes = items.flatMap(item => { const change = patch(item); const [field, to] = Object.entries(change ?? {})[0] ?? []; return field === undefined ? [] : [{ id: item.id, expect: item.revision, field: field as UndoField, to: to as UndoValue, before: fieldOf(item, field as UndoField) }]; });
    if (!changes.length) return;
    const { field, to } = changes[0];
    const { done, failed } = await execute(changes, (n, total) => progressLabel(field, to, n, total));
    await refresh();
    record(undoLabel(field, to, items.filter(i => done.some(c => c.id === i.id))), done.map(c => ({ id: c.id, field: c.field, before: c.before, after: c.to })));
    if (failed.length) throw failure(failed, changes.length, 'changed');
  });
  /** Files items in a collection ('' for none) with the Move dialog's operation, as one undoable action. */
  const move = (items: Item[], collection: string) => perform(async () => {
    const result = await api<{ collection: string; moved: string[] }>('items.move', { ids: items.map(i => i.id), collection });
    await refresh();
    recordMove(items, result);
  });
  /** Records a move that already ran (the Move dialog does its own call). */
  const recordMove = (items: Item[], result: { collection: string; moved: string[] }) => {
    const moved = items.filter(i => result.moved.includes(i.id));
    if (!moved.length) { setMessage('Already there'); return; }
    record(undoLabel('collection', result.collection, moved), moved.map(i => ({ id: i.id, field: 'collection', before: i.collection, after: result.collection })));
  };
  /** Undoes the newest action, or the one a toast offers when it is still the newest. */
  const undo = (only?: number) => {
    const top = stackRef.current.at(-1);
    if (running.current || (only !== undefined && top?.id !== only)) return;
    if (!top) { setMessage('Nothing to undo'); return; }
    running.current = true; stackRef.current = stackRef.current.slice(0, -1); setStack(stackRef.current); setToast(null);
    void perform(async () => {
      try {
        const fresh = await api<Snapshot>('snapshot');
        const { apply: changes, skipped } = planUndo(top, fresh.items);
        const { done, failed } = await execute(changes.map(c => ({ ...c, to: c.before })), (n, total) => progressLabel(changes[0].field, changes[0].before, n, total, true));
        await refresh();
        if (failed.length) throw failure(failed, changes.length, 'put back');
        setMessage(undoneLabel(top, done.length, skipped.length));
      } finally { running.current = false; }
    });
  };
  const toasts = (message: string) => <div className="toast-stack">
    {progress && <div className="toast progress-toast" role="status"><Loader2 className="spin" size={17} />{progress}</div>}
    {toast && <UndoToast key={toast.id} title="" label={toast.label} onUndo={() => undo(toast.id)} onExpire={() => setToast(current => current?.id === toast.id ? null : current)} />}
    {message && <div className="toast" role="status"><Check size={17} />{message}</div>}
  </div>;
  return { apply, move, recordMove, undo, toasts, depth: stack.length };
}
