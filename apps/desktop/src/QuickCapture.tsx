import { MAX_ATTACHMENT_BYTES } from '../../../packages/protocol/limits';
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { File, Loader2, Upload, X } from 'lucide-react';
import { api } from './api';
import { agentStarted } from './AgentPanel';
import { youtubeId } from '../../../packages/agent/video-link';
import type { AgentKind } from '../../../packages/agent/service';
import { Lightbox, Modal, providerName } from './components';
import type { RunProviderId } from '../../../packages/protocol/schema';
import type { Item } from '../../../packages/protocol/schema';
export type CaptureSeed = { text?: string; files?: File[] };
const isImage = (file: File) => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name);
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
export function QuickCapture({ seed, provider, onClose, onDone }: { seed?: CaptureSeed; provider: RunProviderId; onClose: () => void; onDone: (id: string) => void }) {
  const [text, setText] = useState(seed?.text ?? ''), [attachments, setAttachments] = useState<File[]>(seed?.files ?? []), [busy, setBusy] = useState(false), [error, setError] = useState(''), [preview, setPreview] = useState<File | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const savedItem = useRef<string | null>(null);
  const add = (files: File[]) => { if (!saving.current && !savedItem.current) setAttachments(current => [...current, ...files]); };
  const paste = (event: ClipboardEvent) => {
    if (saving.current || savedItem.current) { event.preventDefault(); return; }
    const files = Array.from(event.clipboardData.files);
    if (files.length || !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault(); event.stopPropagation(); add(files);
      const value = event.clipboardData.getData('text/plain');
      if (value) setText(current => current ? current + '\n' + value : value);
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault(); event.stopPropagation(); if (saving.current || savedItem.current) return;
    add(Array.from(event.dataTransfer.files));
    const value = event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('text/uri-list').split('\n').filter(line => !line.startsWith('#')).join('\n');
    if (value) setText(current => current ? current + '\n' + value : value);
  };
  const submit = async (analyze = true) => {
    if (saving.current || (!text.trim() && !attachments.length)) return;
    if (savedItem.current) {
      saving.current = true; setBusy(true); setError('');
      try { await api('agent.start', { id: savedItem.current, kind: 'distill', provider }); agentStarted('distill'); onDone(savedItem.current); }
      catch (error) { setError(`Source saved, but analysis could not start: ${error instanceof Error ? error.message : String(error)}`); }
      finally { saving.current = false; setBusy(false); }
      return;
    }
    saving.current = true; setBusy(true); setError('');
    try {
      if (attachments.reduce((size,file) => size + file.size,0) > MAX_ATTACHMENT_BYTES) throw new Error('Keep files under 25 MB in total. Remove a file to continue.');
      const files: Record<string,string> = Object.create(null);
      const names = new Set<string>();
      for (const file of attachments) {
        const original = file.name || 'clipboard-file';
        let name = original, suffix = 2;
        const dot = original.lastIndexOf('.');
        while (names.has(name.toLowerCase())) name = dot > 0 ? `${original.slice(0,dot)} (${suffix++})${original.slice(dot)}` : `${original} (${suffix++})`;
        names.add(name.toLowerCase());
        files[name] = await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file); });
      }
      const result = await api<{ item: Item; job?: { kind: AgentKind }; error?: string }>('agent.capture', { text, files, provider, analyze });
      if (result.error) { savedItem.current = result.item.id; setError(`Source saved, but analysis could not start: ${result.error}`); return; }
      if (result.job) agentStarted(result.job.kind); onDone(result.item.id);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { saving.current = false; setBusy(false); }
  };
  return <Modal title="Add to library" onClose={() => { if (preview) setPreview(null); else if (!saving.current) onClose(); }}><div className="quick-capture" onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={drop} onPaste={paste}>
    <button className="import-zone" disabled={busy || Boolean(savedItem.current)} onClick={() => picker.current?.click()}><Upload size={24}/><span>Drop, paste or select files<small>Any file type · add multiple files, images or references</small></span></button>
    <input ref={picker} aria-label="Select files" type="file" multiple hidden disabled={busy || Boolean(savedItem.current)} onChange={event => { add(Array.from(event.target.files ?? [])); event.target.value = ''; }}/>
    <textarea aria-label="Idea" autoFocus rows={5} disabled={busy || Boolean(savedItem.current)} value={text} onChange={event => setText(event.target.value)} placeholder="Paste or write text, links or references…" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } }} />
    {attachments.map((file,index) => <div className={`capture-file ${isImage(file) ? 'has-thumb' : ''}`} key={index}>{isImage(file) ? <Thumbnail file={file} onOpen={() => setPreview(file)} /> : <File size={16}/>}<span>{file.name}</span><button className="icon-button" disabled={busy || Boolean(savedItem.current)} aria-label={`Remove file ${index+1}`} onClick={() => setAttachments(current => current.filter((_,i) => i !== index))}><X size={14}/></button></div>)}
    {preview && <ImageLightbox file={preview} onClose={() => setPreview(null)} />}
    {!attachments.length && youtubeId(text) ? <p className="notice video-notice"><b>YouTube video.</b> Distill video reads the captions and asks {providerName[provider]} to create reusable prompts, tools, techniques and resources. Save only keeps the link without fetching captions or running an agent.</p>
      : <p className="muted small">Save only keeps your source without running an agent. Analyze and add asks {providerName[provider]} to analyze it into reusable insights, techniques, prompts, tools and resources in a collection. Anything it cannot read is reported. Files: 25 MB total.</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    <div className="modal-actions">{!savedItem.current && <button className="button" disabled={busy || (!text.trim() && !attachments.length)} onClick={() => void submit(false)}>Save only</button>}<button className="button primary" disabled={busy || (!text.trim() && !attachments.length)} onClick={() => void submit()}>{busy ? <><Loader2 className="spin" size={16}/>Saving…</> : savedItem.current ? 'Retry analysis' : !attachments.length && youtubeId(text) ? 'Distill video' : 'Analyze and add'}</button></div>
  </div></Modal>;
}
