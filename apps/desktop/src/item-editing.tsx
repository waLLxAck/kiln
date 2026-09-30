import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import type { ItemDetail } from '../../../packages/protocol/schema';
import type { ContentCheck } from '../../../packages/domain/content-checks';
import { safeRelativePath } from '../../../packages/domain/relative-path';
import { api } from './api';
import { Field, Modal } from './components';
import { CodeEditor } from './CodeEditor';
import { itemLanguage } from './code-language';
import { editableText, newFileProblem } from './bundled-text';
import { draftChanges, draftKey, draftValue, fieldValues, parseDraft, serialiseDraft, withField, type DraftField, type DraftMeta } from './item-draft';
import { noteDraft, useDraftMark } from './code-editor-state';
import './editor.css';

type Perform = (action: () => Promise<unknown>, message?: string) => Promise<void>;

/**
 * The item page's one edit flow: content, fields and bundled text files, kept together in the item's private draft
 * (item-draft.ts) until "Save revision" turns them into one new revision. The draft survives switching items and restarts;
 * opening the editor without changing anything leaves no draft behind, so the library's "unsaved" mark means real edits.
 */
export function useItemDraft(detail: ItemDetail, perform: Perform, refresh: () => Promise<void>) {
  const { item, revision } = detail;
  const stored = useMemo(() => parseDraft(localStorage.getItem(draftKey(item.id))), [item.id]);
  const [editing, setEditing] = useState(Boolean(stored));
  const [content, setContent] = useState(stored?.content ?? revision.content);
  const [base, setBase] = useState(stored?.base ?? revision.hash);
  const [meta, setMeta] = useState<DraftMeta>(stored?.meta ?? {});
  const [files, setFiles] = useState<Record<string, string>>(stored?.files ?? {});
  const [open, setOpen] = useState<string | null>(null);
  // Null until the first check has run, so "checks pass" never shows before it is true.
  const [checks, setChecks] = useState<ContentCheck[] | null>(null);
  const [storageFull, setStorageFull] = useState(false);
  const saving = useRef(false);
  const changed = draftChanges(revision, { content, meta, files });

  // Another item on the same page (not remounted): start again from its own draft.
  const shown = useRef(item.id);
  useEffect(() => {
    if (shown.current === item.id) return;
    shown.current = item.id;
    setEditing(Boolean(stored)); setContent(stored?.content ?? revision.content); setBase(stored?.base ?? revision.hash);
    setMeta(stored?.meta ?? {}); setFiles(stored?.files ?? {}); setOpen(null); setChecks(null); setStorageFull(false);
  }, [item.id]);
  // When the item moves on (the agent, another window, a pull): follow it when not editing, or when editing without a
  // change yet; with changes, the base stays so saving reports the conflict instead of overwriting.
  const seen = useRef(revision);
  useEffect(() => {
    const previous = seen.current; seen.current = revision;
    if (!editing || (content === previous.content && !Object.keys(files).length && base === previous.hash)) { setContent(revision.content); setBase(revision.hash); }
  }, [revision.hash]);
  useEffect(() => {
    if (!editing) return;
    if (!changed) { localStorage.removeItem(draftKey(item.id)); noteDraft(item.id, false); setStorageFull(false); return; }
    try { localStorage.setItem(draftKey(item.id), serialiseDraft({ content, base, meta, files })); noteDraft(item.id, true); setStorageFull(false); }
    catch { setStorageFull(true); }
  }, [editing, changed, content, base, meta, files, item.id]);

  // Decoded once per revision: the text of each bundled file that can be edited, or null when it is kept as it is.
  const texts = useMemo(() => Object.fromEntries(Object.entries(revision.files).map(([name, data]) => [name, editableText(data)])) as Record<string, string | null>, [revision.hash]);
  const names = useMemo(() => [...new Set([...Object.keys(revision.files), ...Object.keys(files)])].sort((a, b) => a.localeCompare(b)), [revision.hash, files]);
  const values = { ...fieldValues(item), ...meta };
  const nameList = names.join('\n');
  // Live checks while editing: what would block approval, with its line. The checks bring YAML and TOML parsers, so they
  // load only once an item is edited.
  useEffect(() => {
    if (!editing) { setChecks(null); return; }
    let live = true;
    const timer = setTimeout(() => void import('../../../packages/domain/content-checks').then(({ contentChecks }) => {
      if (live) setChecks(contentChecks({ kind: item.kind, content, files: Object.fromEntries(nameList.split('\n').filter(Boolean).map(name => [name, ''])), agent: item.agent ? { provider: item.agent.provider, filename: values.agentFilename } : undefined }));
    }), 200);
    return () => { live = false; clearTimeout(timer); };
  }, [editing, content, nameList, values.agentFilename, item.kind, item.agent?.provider]);

  const start = (file?: string) => {
    if (!editing) { setContent(revision.content); setBase(revision.hash); setMeta({}); setFiles({}); setEditing(true); }
    if (file !== undefined) setOpen(file);
  };
  const clear = () => { localStorage.removeItem(draftKey(item.id)); noteDraft(item.id, false); setEditing(false); setMeta({}); setFiles({}); setOpen(null); setStorageFull(false); setContent(revision.content); setBase(revision.hash); };
  return {
    editing, content, base, values, files, texts, names, open, checks, storageFull,
    /** Unsaved edits, or a base the item has moved past. */ dirty: changed || base !== item.revision,
    changedElsewhere: base !== item.revision,
    /** Opens the editor (keeping a draft already open), and optionally a bundled file in it. */
    start,
    setContent,
    setField: (key: DraftField, value: string) => setMeta(current => withField(current, item, key, value)),
    setOpen,
    editFile: (name: string, text: string) => setFiles(current => { const next = { ...current }; if (Object.hasOwn(revision.files, name) && texts[name] === text) delete next[name]; else next[name] = text; return next; }),
    /** Undoes the edits to one file; a new file goes away. */
    dropFile: (name: string) => { setFiles(current => { const next = { ...current }; delete next[name]; return next; }); if (!Object.hasOwn(revision.files, name) && open === name) setOpen(null); },
    /** Adds an empty text file to the draft and opens it; returns why the path can't be used instead. */
    addFile(path: string): string | null {
      const problem = newFileProblem(path, names, safeRelativePath);
      if (problem) return problem;
      start(path); setFiles(current => ({ ...current, [path]: '' }));
      return null;
    },
    /** Throws the draft away without asking; the callers ask first when it holds changes. */
    discard: clear,
    save() {
      if (saving.current) return;
      if (!values.title.trim()) { void perform(async () => { throw new Error('Give it a title before saving.'); }); return; }
      saving.current = true;
      void perform(async () => {
        await api('items.update', { id: item.id, expect: base, summary: meta.summary ?? '', value: draftValue(revision, item, { content, base, meta, files }) });
        clear(); await refresh();
      }, 'New draft revision saved').finally(() => { saving.current = false; });
    },
  };
}
export type ItemDraftState = ReturnType<typeof useItemDraft>;

/**
 * The in-place editor: one save bar ("What changed?", Save revision, Discard), the fields, and the content in the code
 * editor with live checks. Bundled files are edited in the page's Files section, into the same draft.
 */
export function ItemEditor({ detail, draft, collections, name, goto }: { detail: ItemDetail; draft: ItemDraftState; collections: string[]; /** The main file's name, e.g. SKILL.md. */ name: string; /** A line to put the cursor on (a score's line link). */ goto?: { line: number; at: number } }) {
  const { item } = detail;
  const [asking, setAsking] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const save = () => { if (form.current?.reportValidity() !== false) draft.save(); };
  const problems = useMemo(() => (draft.checks ?? []).map(c => ({ message: c.message, line: c.line })), [draft.checks]);
  const field = (key: DraftField, label: string, props: { required?: boolean; placeholder?: string; list?: string; title?: string } = {}) =>
    <Field label={label}><input name={key} value={draft.values[key]} onChange={event => draft.setField(key, event.target.value)} {...props} /></Field>;
  return <>
    <form ref={form} className="item-editor" aria-label={`Edit ${name}`} onSubmit={event => { event.preventDefault(); save(); }}
      onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's' && !event.defaultPrevented) { event.preventDefault(); save(); } }}>
      <div className={`item-savebar ${draft.dirty ? 'dirty' : ''}`}>
        <span className="item-savebar-state">{draft.dirty ? <><span className="item-dot" />Unsaved changes</> : <><Pencil size={13} />Editing</>}</span>
        <input name="summary" aria-label="What changed? (optional)" placeholder="What changed? (optional)" title="Leave it empty to use a plain revision note." value={draft.values.summary} onChange={event => draft.setField('summary', event.target.value)} />
        <button className="button primary" type="submit" title="Creates an unapproved revision. Ctrl+S">Save revision</button>
        {draft.dirty
          ? <button className="button" type="button" aria-label="Discard local draft" title="Throw away the unsaved changes kept on this machine" onClick={() => setAsking(true)}>Discard</button>
          : <button className="button" type="button" title="Nothing changed; close the editor" onClick={draft.discard}>Done</button>}
      </div>
      {draft.changedElsewhere && <div className="notice warning">This item changed elsewhere since you started. Your draft is kept: copy what you need, discard it, then compare in History.</div>}
      {draft.storageFull && <div className="notice warning"><TriangleAlert size={15} /> This draft is too large to keep on this machine. Save it as a revision before leaving this item.</div>}
      <div className="item-editor-fields">
        {field('title', 'Title', { required: true })}
        {item.kind === 'agent' && field('agentFilename', 'Agent filename', { required: true })}
        {field('collection', 'Collection', { list: 'editor-collections', placeholder: 'Unfiled', title: 'Use / for a subfolder. Changing only the collection keeps the revision and its approval.' })}
        {field('tags', 'Tags', { placeholder: 'Comma separated' })}
        {field('source', 'Source')}
        {field('licence', 'Licence')}
        <datalist id="editor-collections">{collections.map(c => <option key={c} value={c} />)}</datalist>
      </div>
      <div className="item-doc editing">
        <div className="item-doc-bar"><span className="item-doc-name">{name}</span><span className="muted small">Autosaved privately on this machine</span></div>
        <CodeEditor className="item-code" value={draft.content} onChange={draft.setContent} language={itemLanguage(item)} ariaLabel="Content" onSave={save} diagnostics={problems} diagnosticsTitle="Needs attention before approval" goto={goto} />
        {item.kind === 'skill' && draft.checks?.length === 0 && <p className="code-checks-ok"><Check size={13} />SKILL.md checks pass: frontmatter, name, description and local links.</p>}
      </div>
    </form>
    {asking && <DiscardDraftDialog title={item.title} onCancel={() => setAsking(false)} onDiscard={() => { setAsking(false); draft.discard(); }} />}
  </>;
}

/** Asks before throwing away a private draft; the saved revisions are not affected. */
export function DiscardDraftDialog({ title, onCancel, onDiscard }: { title: string; onCancel: () => void; onDiscard: () => void }) {
  return <Modal title="Discard your local draft?" subtitle={title} onClose={onCancel}>
    <p>The unsaved text, fields and file edits for this item are removed from this machine. Saved revisions stay as they are.</p>
    <div className="modal-actions"><button className="button" onClick={onCancel}>Keep editing</button><button className="button danger-text" onClick={onDiscard}><Trash2 size={14} />Discard draft</button></div>
  </Modal>;
}
/** A small mark on a library row whose item has a private draft. */
export function DraftMark({ id }: { id: string }) {
  return useDraftMark(id) ? <small className="draft-mark lib-draft" title="Unsaved draft on this machine" aria-label="Unsaved draft">unsaved</small> : null;
}
