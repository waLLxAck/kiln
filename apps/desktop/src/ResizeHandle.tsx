import { useState, type CSSProperties } from 'react';
export function usePanelWidth(key: string, initial: number, min: number, max: number) {
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  const [width, setWidth] = useState(() => { const saved = Number(localStorage.getItem(key)); return saved && Number.isFinite(saved) ? clamp(saved) : initial; });
  const update = (value: number) => { const next = clamp(value); setWidth(next); localStorage.setItem(key, String(next)); };
  return { width, min, max, update, style: { width, flexShrink: 0 } as CSSProperties };
}
/** `invert` for a panel anchored on the right: dragging the handle left makes it wider. */
export function ResizeHandle({ panel, label, invert = false }: { panel: ReturnType<typeof usePanelWidth>; label: string; invert?: boolean }) {
  const sign = invert ? -1 : 1;
  return <div className="resize-handle" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={panel.min} aria-valuemax={panel.max} aria-valuenow={panel.width} tabIndex={0}
    onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); panel.update(event.key === 'Home' ? panel.min : event.key === 'End' ? panel.max : panel.width + sign * (event.key === 'ArrowLeft' ? -20 : 20)); } }}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.start = String(event.clientX); event.currentTarget.dataset.width = String(panel.width); }}
    onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) panel.update(Number(event.currentTarget.dataset.width) + sign * (event.clientX - Number(event.currentTarget.dataset.start))); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />;
}
