import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, FileText, Plus, TriangleAlert } from 'lucide-react';
import type { Item, Revision } from '../../../packages/protocol/schema';
import { contentChecks, type ContentCheck } from '../../../packages/domain/content-checks';
import { safeRelativePath } from '../../../packages/domain/relative-path';
import { api } from './api';
import { Field } from './components';
import { CodeEditor } from './CodeEditor';
import { itemLanguage, languageFor } from './code-language';
import { editableText, EDITABLE_TEXT_LIMIT, mergeTextEdits, newFileProblem } from './bundled-text';
import { draftKey, draftMetaKeys, parseDraft, serialiseDraft, type DraftMeta } from './item-draft';
import { noteDraft } from './code-editor-state';

export type ItemEditorProps = {
  item: Item; revision: Revision; collections: string[]; draft: string; onDraft: (value: string) => void; base: string;
  perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>; /** The revision was saved and the draft removed. */ onSaved: () => void;
};
/** What each form field holds for this item before any edit, to keep only real changes in the draft. */
const itemValues = (item: Item): Record<string, string> => ({ title: item.title, agentFilename: item.agent?.filename ?? '', collection: item.collection, tags: item.tags.join(', '), source: item.source, licence: item.licence, summary: '' });
const formFields = (form: HTMLFormElement) => { const data = new FormData(form); return Object.fromEntries(draftMetaKeys.filter(key => data.has(key)).map(key => [key, String(data.get(key))])) as Record<string, string>; };

/**
 * The item editor with the code editor on (`codeEditor` flag): Content in CodeMirror with live checks, bundled text files
 * editable in the same revision, and every form field kept in the private draft so switching items loses nothing.
 */
export default function ItemEditor({ item, revision, collections, draft, onDraft, base, perform, refresh, onSaved }: ItemEditorProps) {
  const saved = useMemo(() => parseDraft(localStorage.getItem(draftKey(item.id))), [item.id]);
  const [meta, setMeta] = useState<DraftMeta>(saved?.meta ?? {});
  const [edits, setEdits] = useState<Record<string, string>>(saved?.files ?? {});
  const [open, setOpen] = useState<string | null>(null);
  const [newPath, setNewPath] = useState(''), [pathProblem, setPathProblem] = useState<string | null>(null);
  const [checks, setChecks] = useState<ContentCheck[]>([]);
  const [storageFull, setStorageFull] = useState(false);
  const form = useRef<HTMLFormElement>(null), saving = useRef(false);
  const original = useMemo(() => itemValues(item), [item]);
  // Decoded once per revision: the text of every bundled file that can be edited, or null for binary and large files.
  const texts = useMemo(() => Object.fromEntries(Object.entries(revision.files).map(([name, content]) => [name, editableText(content)])) as Record<string, string | null>, [revision.hash]);
  const names = [...new Set([...Object.keys(revision.files), ...Object.keys(edits)])].sort((a, b) => a.localeCompare(b));
  const showFiles = item.kind !== 'agent' && (item.kind === 'skill' || names.length > 0);

  useEffect(() => {
    try { localStorage.setItem(draftKey(item.id), serialiseDraft({ content: draft, base, meta, files: edits })); setStorageFull(false); noteDraft(item.id, true); }
    catch { setStorageFull(true); }
  }, [draft, base, meta, edits, item.id]);
  const agentFilename = meta.agentFilename ?? item.agent?.filename ?? '';
  const nameList = names.join('\n');
  useEffect(() => {
    const timer = setTimeout(() => setChecks(contentChecks({ kind: item.kind, content: draft, files: Object.fromEntries(nameList.split('\n').filter(Boolean).map(name => [name, ''])), agent: item.agent ? { provider: item.agent.provider, filename: agentFilename } : undefined })), 250);
    return () => clearTimeout(timer);
  }, [draft, nameList, agentFilename, item.kind, item.agent?.provider]);

  const readMeta = () => { if (!form.current) return; const fields = formFields(form.current); setMeta(Object.fromEntries(Object.entries(fields).filter(([key, value]) => value !== original[key]))); };
  const submit = () => {
    if (!form.current || saving.current || !form.current.reportValidity()) return;
    const fields = formFields(form.current);
    saving.current = true;
    void perform(async () => {
      await api('items.update', { id: item.id, expect: base, summary: fields.summary, value: { ...revision, ...fields, content: draft, files: item.kind === 'agent' ? revision.files : mergeTextEdits(revision.files, edits), ...(item.kind === 'agent' ? { agent: { provider: item.agent?.provider, filename: fields.agentFilename } } : {}), tags: (fields.tags ?? '').split(',').map(t => t.trim()).filter(Boolean) } });
      localStorage.removeItem(draftKey(item.id)); noteDraft(item.id, false); onSaved(); await refresh();
    }, 'New draft revision saved').finally(() => { saving.current = false; });
  };
  const editFile = (name: string, text: string) => setEdits(current => { const next = { ...current }; if (Object.hasOwn(revision.files, name) && texts[name] === text) delete next[name]; else next[name] = text; return next; });
  const dropEdit = (name: string) => { setEdits(current => { const next = { ...current }; delete next[name]; return next; }); if (!Object.hasOwn(revision.files, name)) setOpen(null); };
  const addFile = () => {
    const path = newPath.trim(), problem = newFileProblem(path, names, safeRelativePath);
    setPathProblem(problem); if (problem) return;
    setEdits(current => ({ ...current, [path]: '' })); setOpen(path); setNewPath('');
  };
  const onKey = (event: React.KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's' && !event.defaultPrevented) { event.preventDefault(); submit(); } };
  const problems = checks.map(c => ({ message: c.message, line: c.line }));

  return <form ref={form} className="item-code-form" onSubmit={event => { event.preventDefault(); submit(); }} onChange={readMeta} onKeyDown={onKey}>
    {base !== item.revision && <div className="notice warning">This item changed elsewhere. Your unsaved text is preserved. Copy it before cancelling, then compare in History.</div>}
    {storageFull && <div className="notice warning"><TriangleAlert size={15} /> This draft is too large to keep privately on this machine. Save it as a revision before leaving this item.</div>}
    <Field label="Title"><input name="title" defaultValue={meta.title ?? item.title} required /></Field>
    {item.kind === 'agent' && <Field label="Agent filename"><input name="agentFilename" defaultValue={meta.agentFilename ?? item.agent?.filename} required /></Field>}
    <div className="code-field"><span className="code-field-label">Content</span>
      <CodeEditor className="item-code" value={draft} onChange={onDraft} language={itemLanguage(item)} ariaLabel="Content" onSave={submit} diagnostics={problems} diagnosticsTitle="Needs attention before approval" />
      {item.kind === 'skill' && !checks.length && <p className="code-checks-ok"><Check size={13} />SKILL.md checks pass: frontmatter, name, description and local links.</p>}
    </div>
    {showFiles && <section className="code-files" aria-label="Bundled files in this draft">
      <div className="code-field-label">Bundled files <small className="muted">Text files open here and are saved with the revision. Binary files are kept exactly as they are.</small></div>
      {names.length > 0 && <div className="code-file-list">{names.map(name => {
        const added = !Object.hasOwn(revision.files, name), editable = added || texts[name] !== null;
        return <button type="button" key={name} className={`code-file ${open === name ? 'active' : ''}`} aria-pressed={open === name} disabled={!editable} title={editable ? `Edit ${name}` : `Binary, or larger than ${EDITABLE_TEXT_LIMIT / 1024} KB: kept as it is`} onClick={() => setOpen(open === name ? null : name)}>
          <FileText size={13} aria-hidden="true" /><span>{name}</span>{added ? <small className="draft-mark">new</small> : Object.hasOwn(edits, name) ? <small className="draft-mark">edited</small> : !editable ? <small className="muted">binary</small> : null}
        </button>;
      })}</div>}
      {open && <div className="code-file-editor"><div className="section-heading"><h4>{open}</h4><span className="inline">{Object.hasOwn(edits, open) && <button type="button" className="text-button" onClick={() => dropEdit(open)}>{Object.hasOwn(revision.files, open) ? 'Undo changes to this file' : 'Remove new file'}</button>}<button type="button" className="text-button" onClick={() => setOpen(null)}>Close file</button></span></div>
        <CodeEditor key={open} value={edits[open] ?? texts[open] ?? ''} onChange={text => editFile(open, text)} language={languageFor(open)} ariaLabel={`${open} content`} onSave={submit} />
      </div>}
      <Field label="Add a text file" hint="A relative path such as references/notes.md. It starts empty and is saved with this revision."><div className="input-button"><input aria-label="New text file path" placeholder="references/notes.md" value={newPath} onChange={event => { setNewPath(event.target.value); setPathProblem(null); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addFile(); } }} /><button type="button" className="button" onClick={addFile}><Plus size={14} />Add text file</button></div></Field>
      {pathProblem && <p className="error-box" role="alert">{pathProblem}</p>}
    </section>}
    <div className="form-grid"><Field label="Collection"><input name="collection" defaultValue={meta.collection ?? item.collection} list="collection-names" placeholder="None (unfiled)" title="Use / for a subfolder. Changing only the collection keeps the revision and its approval." /><datalist id="collection-names">{collections.map(name => <option key={name} value={name} />)}</datalist></Field><Field label="Tags"><input name="tags" defaultValue={meta.tags ?? item.tags.join(', ')} /></Field></div>
    <Field label="Source"><input name="source" defaultValue={meta.source ?? item.source} /></Field><Field label="Licence"><input name="licence" defaultValue={meta.licence ?? item.licence} /></Field>
    <Field label="What changed? (optional)" hint="Leave it empty to use a plain revision note."><input name="summary" defaultValue={meta.summary ?? ''} placeholder="Brief revision note" /></Field>
    <div className="modal-actions"><span className="muted small">Text, fields and file edits autosave privately. Ctrl+S or Save creates an unapproved revision.</span><button className="button primary" type="submit" title="Ctrl+S">Save revision</button></div>
  </form>;
}
