import { useEffect, useState } from 'react';
import type { HomeList } from '../../../packages/home/service';
import { readInstruction } from '../../../packages/agent/distill';
import { api } from './api';
import { InlineError, Modal } from './components';
import { instructionChoices, scopeName } from './configModel';

/** What Config files opens with: the file, and the snippet added to it as an unsaved edit. */
export type InstructionAppend = { key: string; text: string; section: string; at: number };

/** The files an instruction item's target names ("CLAUDE.md / AGENTS.md" when it names none), for the button that adds it. */
export function addToLabel(content: string) {
  const files = readInstruction(content).target?.files.filter(file => file !== '.cursor/rules').map(file => file.split('/').at(-1)!) ?? [];
  return `Add to ${files.length ? files.join(' / ') : 'CLAUDE.md / AGENTS.md'}…`;
}

/**
 * Add to CLAUDE.md / AGENTS.md…: pick one of the instruction files Config files lists (the ones the item's target names
 * first), then Config files opens it with the snippet added where the target says it fits. Nothing is written until
 * the user saves there, so the file's stale-copy check and kept versions apply as for any edit.
 */
export function AddToInstructions({ content, onClose, onChoose }: { content: string; onClose: () => void; onChoose: (append: InstructionAppend) => void }) {
  const { snippet, target } = readInstruction(content);
  const [files, setFiles] = useState<HomeList | null>(null), [error, setError] = useState('');
  const [key, setKey] = useState('');
  useEffect(() => { void api<HomeList>('home.list').then(setFiles).catch(e => setError(e instanceof Error ? e.message : String(e))); }, []);
  const choices = files ? instructionChoices(files.files, target) : [];
  useEffect(() => { if (!key && choices.length) setKey((choices.find(c => c.suggested) ?? choices[0]).file.key); }, [files]);
  const cursor = target?.files.includes('.cursor/rules') && !choices.some(c => c.suggested && c.file.path.replaceAll('\\', '/').includes('/.cursor/rules/'));
  return <Modal title="Add to an instruction file" subtitle={target?.section ? `Fits ${target.section}` : 'Added at the end of the file'} onClose={onClose} wide>
    {!files && !error ? <p className="muted small">Reading your instruction files…</p> : <div className="project-choices" role="radiogroup" aria-label="Instruction file">{choices.map(({ file, suggested: named }) => <div className={`project-choice ${file.key === key ? 'selected' : ''}`} key={file.key}>
      <label><input type="radio" name="instruction-file" checked={file.key === key} onChange={() => setKey(file.key)} /><span><b>{file.label}</b><code className="path-text">{file.path}</code><small>{named ? 'Suggested · ' : ''}{scopeName(file.scope)}{file.exists ? '' : ' · new file'}</small></span></label>
    </div>)}</div>}
    {cursor && <p className="muted small">For Cursor, add the rule file under <code>.cursor/rules</code> with Add file… in Config files.</p>}
    {files && target?.scope === 'project' && !choices.some(c => c.suggested && c.file.scope?.startsWith('Project · ')) && <p className="muted small">No project listed yet: add the project folder in Config files first.</p>}
    <InlineError error={error} />
    <div className="modal-actions"><span className="muted small">Opens in Config files as an unsaved edit. Review it there, then save.</span><button className="button" onClick={onClose}>Cancel</button>
      <button className="button primary" disabled={!key || !snippet} onClick={() => onChoose({ key, text: snippet, section: target?.section ?? '', at: Date.now() })}>Open with the text added</button></div>
  </Modal>;
}
