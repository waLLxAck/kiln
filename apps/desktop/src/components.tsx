import { Children, cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement } from 'react';
import { Bot, X, FileText, Link, Image, File, Terminal, BookOpen, BookMarked, FolderSymlink, Check, Lightbulb, ListOrdered, Loader2, ArrowUpRight, Wrench } from 'lucide-react';
import type { Item, ProviderId } from '../../../packages/protocol/schema';

/** The Kiln mark (cream kiln arch with an orange fire opening). Its dark rounded square is the `.brand-symbol` background. */
export function KilnMark() {
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 25V16a8 8 0 0 1 16 0v9z" fill="var(--brand-fg)" /><path d="M13 25v-5.5a3 3 0 0 1 6 0V25z" fill="var(--brand-fire)" /></svg>;
}
export const providerName: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot' };
/** Plain-language meaning of each lifecycle status, shown wherever a status can be chosen or filtered. */
export const statusHelp: Record<string, string> = {
  captured: 'A draft. New in the library and only on this machine; nothing has been tried yet.',
  testing: 'A draft with at least one experiment started for this revision. Still only on this machine.',
  approved: 'You approved this exact revision. It is committed to your Kiln repo on GitHub and can be installed.',
  rejected: 'Kept for reference but hidden from the main library.',
  archived: 'Finished with. Hidden from the main library.',
};
export function KindIcon({ kind, size = 19 }: { kind: Item['kind']; size?: number }) {
  const Icon = { prompt: FileText, agent: Bot, skill: Terminal, instruction: BookOpen, link: Link, insight: Lightbulb, technique: ListOrdered, tool: Wrench, resource: BookMarked, image: Image, file: File, reference: FolderSymlink }[kind];
  return <Icon size={size} aria-hidden="true" />;
}
export function Badge({ status }: { status: string }) { return <span className={`badge ${status}`} title={statusHelp[status]}>{status === 'approved' && <Check size={11} />}{status.replaceAll('_', ' ')}</span>; }
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  useEffect(() => { const receive = (event: Event) => setError((event as CustomEvent<string>).detail); window.addEventListener('kiln:error', receive); return () => window.removeEventListener('kiln:error', receive); }, []);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="modal-title" onClick={event => { if (event.target === ref.current) onClose(); }}>
    <div className="modal-head"><div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>{error && <InlineError error={error} />}{children}
  </dialog>;
}
export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{children}</p>{action}</div>;
}
export function Submit({ busy, children = 'Save' }: { busy: boolean; children?: ReactNode }) { return <button type="submit" className="button primary" disabled={busy}>{busy && <Loader2 size={16} className="spin" />}{children}</button>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  const labelled = Children.map(children, child => isValidElement(child) && ['input', 'textarea', 'select'].includes(String(child.type)) ? cloneElement(child as ReactElement<Record<string, unknown>>, { 'aria-labelledby': id, ...(hint ? { 'aria-describedby': `${id}-hint` } : {}) }) : child);
  return <label className="field"><span id={id}>{label}</span>{labelled}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>;
}
export function InlineError({ error }: { error: string }) { return error ? <div role="alert" className="error-box">{error}</div> : null; }
export function ExternalLabel({ children }: { children: ReactNode }) { return <span className="inline">{children}<ArrowUpRight size={13} /></span>; }

/** Full-window image view. Click anywhere or press Escape to close. */
export function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }; window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true); }, [onClose]);
  return <div className="lightbox" role="dialog" aria-label={`Preview of ${name}`} onClick={onClose}>
    <img src={src} alt={name} /><div className="lightbox-caption"><span>{name}</span><button type="button" className="icon-button" aria-label="Close preview" onClick={onClose}><X size={18} /></button></div>
  </div>;
}
export const imageFile = (name: string) => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name);
export const imageSource = (name: string, base64: string) => { const ext = name.split('.').at(-1)?.toLowerCase() ?? 'png'; return `data:image/${ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext};base64,${base64}`; };

export type MenuEntry = { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string; shortcut?: string; /** Right-aligned text such as a count; unlike `shortcut` it is not a key. */ note?: string; onSelect?: () => void } | 'separator' | { heading: string };
/** The enabled entry whose single-key shortcut matches this keyboard event, if any. Ignores modifier combinations. */
export function shortcutEntry(entries: MenuEntry[], event: KeyboardEvent | { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return null;
  const key = event.key.toLowerCase();
  for (const entry of entries) if (typeof entry === 'object' && 'label' in entry && !entry.disabled && entry.shortcut?.toLowerCase() === key) return entry;
  return null;
}
/** Right-click menu anchored at a screen position; keeps itself inside the window. */
export function ContextMenu({ x, y, entries, onClose }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => { const box = ref.current?.getBoundingClientRect(); if (!box) return; setPosition({ left: Math.min(x, window.innerWidth - box.width - 8), top: Math.min(y, window.innerHeight - box.height - 8) }); }, [x, y]);
  useEffect(() => {
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { onClose(); return; } const hit = shortcutEntry(entries, event); if (hit) { event.preventDefault(); event.stopPropagation(); hit.onSelect?.(); onClose(); } };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', key, true); window.addEventListener('blur', onClose); window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true); window.removeEventListener('blur', onClose); window.removeEventListener('resize', onClose); };
  }, [onClose, entries]);
  return <div ref={ref} className="context-menu" role="menu" style={position} onContextMenu={event => event.preventDefault()}>
    {entries.map((entry, i) => entry === 'separator' ? <hr key={i} /> : 'heading' in entry ? <div key={i} className="context-heading">{entry.heading}</div> : <button key={i} role="menuitem" className={entry.danger ? 'danger' : ''} disabled={entry.disabled} title={entry.hint} onClick={() => { entry.onSelect?.(); onClose(); }}><span className="context-check">{entry.checked && <Check size={13} />}</span>{entry.icon}<span className="context-label">{entry.label}</span>{entry.shortcut && <kbd className="context-key" aria-label={`Shortcut ${entry.shortcut}`}>{entry.shortcut}</kbd>}{entry.note && <span className="context-note">{entry.note}</span>}</button>)}
  </div>;
}
