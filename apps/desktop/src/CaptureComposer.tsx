import { activeRun } from '../../../packages/agent/run-notice';
import { MAX_ATTACHMENT_BYTES } from '../../../packages/protocol/limits';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { AlertTriangle, Bot, Check, Clapperboard, File, FileText, Globe, Loader2, Paperclip, Plus, Sparkles, Type, Upload, X } from 'lucide-react';
import { api, variablesIn } from './api';
import { agentStarted } from './AgentPanel';
import { youtubeId } from '../../../packages/agent/video-link';
import type { AgentJob, AgentKind } from '../../../packages/agent/service';
import { entryTypeList, type EntryType } from '../../../packages/agent/distill';
import { ContextMenu, KindIcon, Lightbox, providerName } from './components';
import type { Item, Provider, RunProviderId } from '../../../packages/protocol/schema';
import { elapsed } from './StatusBar';
import './capture.css';

/** Something to put in the composer from outside it: a paste or drop on the window, or the Capture button (nothing to add, just open). */
export type CaptureSeed = { text?: string; files?: File[] };
export type CaptureRequest = { id: number; seed?: CaptureSeed };
const isImage = (file: File) => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name);
const size = (bytes: number) => bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1e3 ? `${Math.round(bytes / 1e3)} KB` : `${bytes} B`;
function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState('');
  useEffect(() => { if (!file) { setUrl(''); return; } const value = URL.createObjectURL(file); setUrl(value); return () => URL.revokeObjectURL(value); }, [file]);
  return url;
}
function ImageLightbox({ file, onClose }: { file: File; onClose: () => void }) {
  const url = useObjectUrl(file);
  return url ? <Lightbox src={url} name={file.name} onClose={onClose} /> : null;
}
function Thumbnail({ file, onOpen }: { file: File; onOpen: () => void }) {
  const url = useObjectUrl(file);
  return <button type="button" className="capture-thumb" aria-label={`Preview ${file.name}`} onClick={onOpen}>{url && <img src={url} alt={file.name} />}</button>;
}
/** What was pasted decides the main action: a bare YouTube link is distilled, another link is a page, anything else is text or files. */
type Detected = 'empty' | 'video' | 'link' | 'text' | 'files';
const detect = (text: string, files: File[]): Detected => files.length ? 'files' : !text.trim() ? 'empty' : /^\S+$/.test(text.trim()) && youtubeId(text) ? 'video' : /^https?:\/\/\S+$/i.test(text.trim()) ? 'link' : 'text';
const detectedLabel: Record<Detected, string> = { empty: '', video: 'YouTube video', link: 'Web page', text: 'Text', files: 'Files' };
const detectedIcon: Record<Detected, ReactNode> = { empty: <Plus size={16} />, video: <Clapperboard size={16} />, link: <Globe size={16} />, text: <Type size={16} />, files: <Paperclip size={16} /> };

type Props = { request?: CaptureRequest; provider: RunProviderId; /** Entry types Settings asks distillation for, named in the analyze buttons' tooltips. */ entryTypes: EntryType[]; providers: Provider[]; jobs: AgentJob[]; items: Item[]; onSaved: (id: string, analyzing: boolean) => void; onOpenItem: (id: string) => void; onOpenCollection: (name: string) => void };

/**
 * Capture as a dialog over whatever is on screen. It opens from the Capture button, Ctrl+N, the palette, or a paste or drop on
 * the window (`request`, with what was pasted or dropped as its seed). It reads what it was given and offers the matching
 * action; Save only keeps the material without running an agent. Recent and running analyses show under the input.
 * The dialog stays mounted while closed, so a half-written capture or a save in flight survives closing it.
 */
export function CaptureDialog({ request, provider, entryTypes, providers, jobs, items, onSaved, onOpenItem, onOpenCollection }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(''), [attachments, setAttachments] = useState<File[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false), [agent, setAgent] = useState<RunProviderId>(provider), [saveOnly, setSaveOnly] = useState(false);
  const [agentMenu, setAgentMenu] = useState<{ x: number; y: number } | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), picker = useRef<HTMLInputElement>(null), field = useRef<HTMLTextAreaElement>(null), agentButton = useRef<HTMLButtonElement>(null);
  const saving = useRef(false), savedItem = useRef<string | null>(null), escapeTaken = useRef(false), closedByUs = useRef(false);
  useEffect(() => setAgent(provider), [provider]);
  const add = (files: File[]) => { if (!saving.current && !savedItem.current) setAttachments(current => [...current, ...files]); };
  const append = (value: string) => { if (value) setText(current => current ? current + '\n' + value : value); };
  // Paste, drop, the Capture button, Ctrl+N and the palette all arrive here from the window.
  useEffect(() => {
    if (!request) return;
    if (request.seed && !saving.current && !savedItem.current) { add(request.seed.files ?? []); append(request.seed.text ?? ''); }
    setOpen(true);
    requestAnimationFrame(() => field.current?.focus());
  }, [request?.id]);
  // Synced on every render, not only when `open` changes: the browser can close the dialog itself (a repeated Esc), and a quick
  // close and reopen may batch into no change of `open` at all.
  useEffect(() => { const d = dialog.current!; if (open && !d.open) { d.showModal(); field.current?.focus(); } else if (!open && d.open) { closedByUs.current = true; d.close(); } });
  // Esc on the agent menu or an image preview closes only that. Both stop the key before it reaches the dialog, but not the
  // dialog's own cancel, so note here (registered before them) whether the key was theirs.
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') escapeTaken.current = Boolean(document.querySelector('.capture-dialog .context-menu, .lightbox')); }; window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true); }, []);
  const close = () => { setOpen(false); setDragging(false); };
  const paste = (event: ClipboardEvent) => {
    if (saving.current || savedItem.current) { event.preventDefault(); return; }
    const files = Array.from(event.clipboardData.files);
    if (files.length || !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); event.stopPropagation(); add(files); append(event.clipboardData.getData('text/plain')); field.current?.focus(); }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault(); event.stopPropagation(); setDragging(false); if (saving.current || savedItem.current) return;
    add(Array.from(event.dataTransfer.files));
    append(event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('text/uri-list').split('\n').filter(line => !line.startsWith('#')).join('\n'));
    field.current?.focus();
  };
  const reset = () => { setText(''); setAttachments([]); setError(''); savedItem.current = null; setSavedId(null); };
  const done = (id: string, analyzing: boolean) => { reset(); close(); onSaved(id, analyzing); };
  const submit = async (analyze: boolean) => {
    if (saving.current || (!text.trim() && !attachments.length)) return;
    if (savedItem.current) {
      saving.current = true; setBusy(true); setError('');
      try { await api('agent.start', { id: savedItem.current, kind: 'distill', provider: agent }); agentStarted('distill'); done(savedItem.current, true); }
      catch (error) { setError(`Source saved, but analysis could not start: ${error instanceof Error ? error.message : String(error)}`); }
      finally { saving.current = false; setBusy(false); }
      return;
    }
    saving.current = true; setBusy(true); setError('');
    try {
      if (attachments.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error('Keep files under 25 MB in total. Remove a file to continue.');
      const files: Record<string, string> = Object.create(null);
      const names = new Set<string>();
      for (const file of attachments) {
        const original = file.name || 'clipboard-file';
        let name = original, suffix = 2;
        const dot = original.lastIndexOf('.');
        while (names.has(name.toLowerCase())) name = dot > 0 ? `${original.slice(0, dot)} (${suffix++})${original.slice(dot)}` : `${original} (${suffix++})`;
        names.add(name.toLowerCase());
        files[name] = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file); });
      }
      const result = await api<{ item: Item; job?: { kind: AgentKind }; error?: string }>('agent.capture', { text, files, provider: agent, analyze });
      if (result.error) { savedItem.current = result.item.id; setSavedId(result.item.id); setError(`Source saved, but analysis could not start: ${result.error}`); return; }
      if (result.job) agentStarted(result.job.kind);
      done(result.item.id, Boolean(result.job));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { saving.current = false; setBusy(false); }
  };

  const kind = detect(text, attachments), empty = kind === 'empty', locked = busy || Boolean(savedId);
  const agentName = providerName[agent];
  // One primary action per kind of material; Save only turns every one into a plain save.
  const primary: { label: string; analyze: boolean; icon: ReactNode } | null = savedId ? { label: 'Retry analysis', analyze: true, icon: <Sparkles size={15} /> }
    : kind === 'video' ? (saveOnly ? { label: 'Save link', analyze: false, icon: <Check size={15} /> } : { label: 'Distill video', analyze: true, icon: <Sparkles size={15} /> })
    : kind === 'link' ? (saveOnly ? { label: 'Save link', analyze: false, icon: <Check size={15} /> } : { label: 'Analyze page', analyze: true, icon: <Sparkles size={15} /> })
    : kind === 'text' ? { label: 'Save as draft', analyze: false, icon: <Check size={15} /> }
    : kind === 'files' ? { label: `Save ${attachments.length} file${attachments.length === 1 ? '' : 's'}`, analyze: false, icon: <Check size={15} /> } : null;
  const secondary: { label: string; analyze: boolean } | null = savedId || saveOnly ? null
    : kind === 'video' ? { label: 'Save link only', analyze: false } : kind === 'link' ? { label: 'Save link', analyze: false }
    : kind === 'text' || kind === 'files' ? { label: `Analyze with ${agentName}`, analyze: true } : null;
  const variables = kind === 'text' ? variablesIn(text) : [];
  const produces = `Produces ${entryTypeList(entryTypes)}. Choose the types in Settings → Distillation.`;
  const note = kind === 'video' ? (saveOnly ? 'Keeps the link as a source without fetching captions. Distill it later from the item.' : `${agentName} reads the captions and turns the video into a source plus the ${entryTypeList(entryTypes)} in it.`)
    : kind === 'link' ? (saveOnly ? 'Keeps the link. Analyze it later from the item.' : `Analyze page keeps the link as a source and asks ${agentName} for what is reusable in it.`)
    : kind === 'files' ? `Files: 25 MB in total. Images, PDFs and any other type.` : '';

  return <dialog ref={dialog} className="modal capture-dialog" aria-label="New capture"
    onCancel={event => { event.preventDefault(); if (escapeTaken.current) { escapeTaken.current = false; return; } close(); }}
    // Only closes the browser did itself need to reach the state; the close event of our own close() can arrive after a reopen.
    onClose={() => { if (closedByUs.current) closedByUs.current = false; else setOpen(false); }}
    // A click on the backdrop lands on the dialog itself; so does one on its padding, which must not close it.
    onClick={event => { if (event.target !== dialog.current) return; const box = dialog.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); }}
    onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={drop} onPaste={paste}>
    <div className="modal-head capture-head"><div><h2>Capture</h2><p>A YouTube link, a web page, a prompt you liked, or files.</p></div><button type="button" className="icon-button" aria-label="Close capture" title="Close (Esc). What you typed stays for next time." onClick={close}><X size={20} /></button></div>
    <div className={`capture-composer open ${dragging ? 'drag' : ''}`}>
      <div className="capture-input">
        <span className={`capture-icon k-${kind}`} aria-hidden="true">{detectedIcon[kind]}</span>
        <textarea ref={field} aria-label="Capture" rows={1} className={kind === 'text' || kind === 'empty' ? 'roomy' : ''} disabled={locked} value={text} onChange={event => setText(event.target.value)}
          placeholder={dragging ? 'Drop to capture' : attachments.length ? 'Add a note about these files (optional)' : 'Paste, drop or type anything to keep it…'}
          onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && primary) { event.preventDefault(); void submit(primary.analyze); } }} />
        {detectedLabel[kind] && <span className="capture-detected"><span className="capture-detected-dot" />{detectedLabel[kind]}</span>}
        <button type="button" className="icon-button" aria-label="Add files" title="Add files" disabled={locked} onClick={() => picker.current?.click()}><Upload size={15} /></button>
        {(!empty || savedId) && <button type="button" className="icon-button" aria-label="Clear capture" title={savedId ? 'Done: the source stays in the library' : 'Clear'} disabled={busy} onClick={() => { reset(); field.current?.focus(); }}><X size={15} /></button>}
      </div>
      <input ref={picker} aria-label="Select files" type="file" multiple hidden disabled={locked} onChange={event => { add(Array.from(event.target.files ?? [])); event.target.value = ''; field.current?.focus(); }} />
      {dragging && <div className="capture-dropzone"><Upload size={17} />Drop files, images or a link to capture them</div>}
      {!dragging && <>
        {attachments.length > 0 && <div className="capture-files">{attachments.map((file, index) => <span className={`capture-file ${isImage(file) ? 'has-thumb' : ''}`} key={index}>{isImage(file) ? <Thumbnail file={file} onOpen={() => setPreview(file)} /> : <File size={14} />}<span className="capture-file-name">{file.name}</span><span className="faint">{size(file.size)}</span><button type="button" disabled={locked} aria-label={`Remove file ${index + 1}`} onClick={() => setAttachments(current => current.filter((_, i) => i !== index))}><X size={12} /></button></span>)}</div>}
        {kind === 'text' && <div className="capture-info"><span className="muted">{text.length.toLocaleString()} characters</span>{variables.length > 0 && <><span className="capture-sep" /><span className="muted">Variables</span>{variables.map(v => <span key={v} className="capture-var">{`{{${v}}}`}</span>)}</>}<span className="capture-sep" /><span className="muted">Saved as</span><span className="capture-guess"><KindIcon kind="prompt" size={13} />a draft prompt</span></div>}
        {note && <p className="capture-note">{note}</p>}
        {error && <p role="alert" className="error-box capture-error"><AlertTriangle size={14} />{error}</p>}
      </>}
      <div className="capture-bar">
        <button ref={agentButton} type="button" className="capture-chip" disabled={saveOnly || busy} aria-haspopup="menu" title="Agent that analyzes the material" onClick={() => { const r = agentButton.current!.getBoundingClientRect(); setAgentMenu({ x: r.left, y: r.bottom + 4 }); }}><Bot size={13} /><span className="faint">Agent:</span> {agentName}</button>
        <button type="button" className={`capture-chip toggle ${saveOnly ? 'on' : ''}`} role="switch" aria-checked={saveOnly} disabled={Boolean(savedId)} onClick={() => setSaveOnly(value => !value)} title="Keep the material without running an agent or fetching captions"><span className="capture-switch" />Save only</button>
        <span className="capture-grow" />
        {empty && !savedId ? <span className="faint small">Ctrl V pastes · drop files anywhere</span> : <>
          {secondary && <button type="button" className="button" disabled={busy} title={secondary.analyze ? produces : undefined} onClick={() => void submit(secondary.analyze)}>{secondary.label}</button>}
          {primary && <button type="button" className="button primary" disabled={busy} title={primary.analyze ? produces : undefined} onClick={() => void submit(primary.analyze)}>{busy ? <><Loader2 className="spin" size={15} />Saving…</> : <>{primary.icon}{primary.label}<kbd>Ctrl ↵</kbd></>}</button>}
        </>}
      </div>
      {agentMenu && <ContextMenu x={agentMenu.x} y={agentMenu.y} onClose={() => setAgentMenu(null)} entries={providers.filter(p => p.id !== 'copilot').map(p => ({ label: `${p.label}${p.available ? '' : ' · not detected'}`, checked: agent === p.id, onSelect: () => setAgent(p.id as RunProviderId) }))} />}
      {preview && <ImageLightbox file={preview} onClose={() => setPreview(null)} />}
    </div>
    {open && <RecentCaptures jobs={jobs} items={items} onOpenItem={id => { close(); onOpenItem(id); }} onOpenCollection={name => { close(); onOpenCollection(name); }} />}
  </dialog>;
}

/** Analyses running now, and those that finished in the last half hour, newest first. Hidden when there are none. */
function RecentCaptures({ jobs, items, onOpenItem, onOpenCollection }: { jobs: AgentJob[]; items: Item[]; onOpenItem: (id: string) => void; onOpenCollection: (name: string) => void }) {
  const [now, setNow] = useState(Date.now()), [dismissed, setDismissed] = useState<string[]>([]);
  const recent = jobs.filter(j => (j.kind === 'distill' || j.kind === 'capture') && !dismissed.includes(j.id) && (activeRun(j) || now - new Date(j.finishedAt ?? j.startedAt).getTime() < 30 * 60_000)).slice(0, 4);
  const running = recent.some(activeRun);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), running ? 1000 : 30_000); return () => clearInterval(timer); }, [running]);
  if (!recent.length) return null;
  return <section className="capture-recent" aria-label="Recent captures">
    <div className="capture-recent-head"><h3>Recent captures</h3>{running && <span className="muted small"><Loader2 size={12} className="spin" /> working · also in the status bar</span>}</div>
    <div className="capture-strip">{recent.map(job => {
      const item = items.find(i => i.id === job.itemId), made = job.createdItemIds?.length ?? 0, done = job.status === 'completed';
      const icon = item?.tags.includes('youtube') ? <Clapperboard size={14} /> : item?.kind === 'link' || /^https?:\/\//.test(item?.source ?? '') ? <Globe size={14} /> : item?.kind === 'file' || item?.kind === 'image' ? <Paperclip size={14} /> : <FileText size={14} />;
      return <div key={job.id} className={`capture-card ${job.status}`}>
        <div className="capture-card-top"><span className="capture-card-icon">{icon}</span><span className="capture-card-text"><b className="ellipsis" title={item?.title}>{item?.title ?? 'Removed item'}</b><small className="ellipsis">{providerName[job.provider]} · {job.status === 'running' ? elapsed(job.startedAt, now) : job.status === 'queued' ? 'queued' : done ? 'finished' : job.status}</small></span>
          <button type="button" className="icon-button" aria-label="Hide from recent captures" onClick={() => setDismissed(current => [...current, job.id])}><X size={12} /></button></div>
        <div className={`capture-progress ${job.status}`}><i /></div>
        <div className="capture-card-foot">{activeRun(job) ? <span className="capture-state"><Loader2 size={12} className="spin" /><span className="ellipsis">{job.status === 'queued' ? 'Waiting for a free run slot' : job.phase}</span></span>
          : done ? <><span className="capture-done"><Check size={12} />Done · {made} entr{made === 1 ? 'y' : 'ies'}</span><span className="capture-grow" />{job.collection && made ? <button type="button" className="text-button" onClick={() => onOpenCollection(job.collection!)}>Open collection</button> : item && <button type="button" className="text-button" onClick={() => onOpenItem(item.id)}>Open</button>}</>
          : <><span className="capture-failed" title={job.error}><AlertTriangle size={12} />{job.status === 'cancelled' ? 'Cancelled' : 'Did not finish'}</span><span className="capture-grow" />{item && <button type="button" className="text-button" onClick={() => onOpenItem(item.id)}>Open</button>}</>}</div>
      </div>;
    })}</div>
  </section>;
}
