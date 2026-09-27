import { lazy, Suspense } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Modal } from './components';
import { useDraftMark } from './code-editor-state';
import type { ItemEditorProps } from './ItemEditor';

// The editor, its checks (YAML and TOML parsers) and CodeMirror load only when an item is edited with the code editor on.
const Editor = lazy(() => import('./ItemEditor'));
export function ItemCodeEditor(props: ItemEditorProps) {
  return <Suspense fallback={<p className="muted small"><Loader2 size={13} className="spin" /> Opening the editor…</p>}><Editor {...props} /></Suspense>;
}
/** Asks before throwing away a private draft; the saved revisions are not affected. */
export function DiscardDraftDialog({ title, onCancel, onDiscard }: { title: string; onCancel: () => void; onDiscard: () => void }) {
  return <Modal title="Discard your local draft?" subtitle={title} onClose={onCancel}>
    <p>The unsaved text, fields and bundled file edits for this item are removed from this machine. Saved revisions stay as they are.</p>
    <div className="modal-actions"><button className="button" onClick={onCancel}>Keep editing</button><button className="button danger-text" onClick={onDiscard}><Trash2 size={14} />Discard draft</button></div>
  </Modal>;
}
/** A small mark on a library row whose item has a private draft (code editor on). */
export function DraftMark({ id }: { id: string }) {
  return useDraftMark(id) ? <small className="draft-mark lib-draft" title="Unsaved draft on this machine" aria-label="Unsaved draft">unsaved</small> : null;
}
