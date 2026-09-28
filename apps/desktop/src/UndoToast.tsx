import { useEffect, useRef, useState } from 'react';
import { Archive, Check, Undo2 } from 'lucide-react';

/** An action that can still be taken back. `label` replaces the archive wording (the library's undo stack names every action). */
export function UndoToast({ title, label, onUndo, onExpire }: { title: string; label?: string; onUndo: () => void; onExpire: () => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const remaining = useRef(8000), expire = useRef(onExpire);
  expire.current = onExpire;
  const paused = hovered || focused;
  useEffect(() => {
    if (paused) return;
    const start = performance.now(), timer = setTimeout(() => expire.current(), remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - start)); };
  }, [paused]);
  return <div className="toast undo-toast" role="status" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false); }}>
    {label ? <><Check size={17} /><span>{label}</span></> : <><Archive size={17} /><span>Archived <b>{title}</b></span></>}<button className="toast-action" onClick={onUndo}><Undo2 size={14} />Undo</button><span className="toast-timer" style={{ animationPlayState: paused ? 'paused' : 'running' }} aria-hidden="true" />
  </div>;
}
