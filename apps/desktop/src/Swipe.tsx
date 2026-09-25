import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Archive } from 'lucide-react';

/** How far (px) the card must travel before letting go archives it. A share of the row width, with a floor for narrow lists. */
export const swipeThreshold = (width: number) => Math.max(72, Math.round(width * 0.35));

/**
 * Horizontal drag on a list row (mouse, pen or touch) slides the row aside and reveals "Archive"; release past the threshold
 * slides it away and calls `onArchive`. Short drags spring back and a drag never turns into a click.
 * The drag follows the pointer through window listeners rather than pointer capture: Chromium drops capture when the
 * window gains or loses focus, which used to kill the first drag after clicking into Kiln. Wheel and trackpad scrolling
 * never archive. Disabled rows render children untouched.
 */
export function SwipeToArchive({ enabled, onArchive, label, children }: { enabled: boolean; onArchive: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const drag = useRef<{ x: number; y: number; active: boolean; pointerId: number; detach: () => void } | null>(null);
  const dragged = useRef(false);
  useEffect(() => () => drag.current?.detach(), []);
  if (!enabled) return <>{children}</>;
  const width = () => ref.current?.offsetWidth ?? 320;
  const commit = (direction: number) => {
    setLeaving(true); setOffset(direction * width());
    setTimeout(onArchive, 180);
  };
  const settle = (dx: number) => { if (Math.abs(dx) >= swipeThreshold(width())) commit(Math.sign(dx)); else setOffset(0); };
  const end = () => { drag.current?.detach(); drag.current = null; };
  const move = (event: PointerEvent) => {
    const d = drag.current; if (!d || leaving || event.pointerId !== d.pointerId) return;
    if ((event.buttons & 1) === 0) { end(); setOffset(0); return; } // Button released without a pointerup reaching us.
    const dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (!d.active) { if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return; d.active = true; dragged.current = true; }
    event.preventDefault(); setOffset(Math.max(-width(), Math.min(width(), dx)));
  };
  const up = (event: PointerEvent) => { const d = drag.current; if (!d || event.pointerId !== d.pointerId) return; end(); if (!d.active || leaving) return; settle(event.clientX - d.x); };
  const cancel = () => { end(); if (!leaving) setOffset(0); };
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || leaving || drag.current) return;
    const detach = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); };
    drag.current = { x: event.clientX, y: event.clientY, active: false, pointerId: event.pointerId, detach }; dragged.current = false;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
  };
  const swallowClick = (event: ReactMouseEvent) => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); dragged.current = false; } };
  const progress = Math.min(1, Math.abs(offset) / swipeThreshold(width()));
  return <div ref={ref} className={`swipe-row ${offset ? 'swiping' : ''} ${leaving ? 'leaving' : ''} ${progress >= 1 ? 'armed' : ''}`} data-direction={offset < 0 ? 'left' : 'right'} onPointerDown={down} onClickCapture={swallowClick}>
    {offset !== 0 && <div className="swipe-backdrop" aria-hidden="true" style={{ opacity: 0.55 + progress * 0.45 }}><Archive size={16} /><span>{label}</span></div>}
    <div className="swipe-content" style={{ transform: offset ? `translateX(${offset}px)` : undefined, transition: drag.current?.active ? 'none' : undefined }}>{children}</div>
  </div>;
}
