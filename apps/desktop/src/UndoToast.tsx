import { useEffect, useRef, useState } from 'react';
import { Archive, Undo2 } from 'lucide-react';

export function UndoToast({ title, onUndo, onExpire }: { title: string; onUndo: () => void; onExpire: () => void }) {
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
    <Archive size={17} /><span>Archived <b>{title}</b></span><button className="toast-action" onClick={onUndo}><Undo2 size={14} />Undo</button><span className="toast-timer" style={{ animationPlayState: paused ? 'paused' : 'running' }} aria-hidden="true" />
  </div>;
}
