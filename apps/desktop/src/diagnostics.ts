import { api } from './api';
const report = (event: string, fields: Record<string, unknown> = {}) => { void api('desktop.telemetry', { event, ...fields }).catch(() => {}); };
export function startDiagnostics() {
  let previous = performance.now();
  setInterval(() => { const current = performance.now(); if (!document.hidden && current - previous > 1500) report('renderer.stall', { durationMs: Math.round(current - previous - 1000) }); previous = current; }, 1000);
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.duration >= 100) report('renderer.longTask', { durationMs: Math.round(entry.duration) }); }).observe({ type: 'longtask', buffered: true });
  window.addEventListener('error', () => report('renderer.error'));
  window.addEventListener('unhandledrejection', () => report('renderer.rejection'));
  // Only static control labels; never input values, skill titles, or content.
  document.addEventListener('click', event => { const button = (event.target as Element)?.closest('button'); if (button && !button.closest('.item-list,.inventory-list')) report('renderer.click', { target: (button.getAttribute('aria-label') || button.textContent || 'button').trim().slice(0, 80) }); }, true);
}
