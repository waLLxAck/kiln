import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Item } from '../../../packages/protocol/schema';
import { pageStep, rangeIds, targetRow, TYPE_AHEAD_MS, typeAheadKey, typeAheadMatch } from './keyboard-undo';

/** Focus is somewhere keys type text: fields, the code editor, anything editable. */
export const typingIn = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor'));
/** Focuses the first element matching one of `selectors` once it is on screen (the detail pane loads after the row is chosen). */
export function focusWhenReady(selectors: string[], frames = 60) {
  const target = selectors.map(s => document.querySelector<HTMLElement>(s)).find(Boolean);
  if (target) target.focus(); else if (frames > 0) requestAnimationFrame(() => focusWhenReady(selectors, frames - 1));
}
/** The detail pane's main button: the primary action, else its first action, else anything in the pane. */
const DETAIL_TARGETS = ['.detail-pane .detail-actions .button.primary:not(:disabled)', '.detail-pane .detail-actions button:not(:disabled)', '.detail-pane button:not(:disabled)'];

type ListContext = { matching: Item[]; selected: string; picked: number; menuOpen: boolean; select: (id: string) => void; setSelected: (id: string) => void; setBulkIds: (ids: string[]) => void; hasShortcut: (event: KeyboardEvent) => boolean };
/**
 * Experimental keyboardUndo: the list's extra keys while a row has focus. Returns whether it handled the key; anything else
 * goes on to the list's usual handler (plain arrows at the edges, Ctrl+A, single-key shortcuts).
 * - Home/End/PageUp/PageDown move the open row; with Shift they, and the arrows, extend the selection from the open row, as Shift-click does.
 * - Enter opens the row and moves focus to the detail pane's main action (or the selection summary's first button).
 * - Type-ahead: a letter or digit that is not a shortcut for the row, or any Shift+letter, starts matching titles; while
 *   typing continues (under a second between keys) every letter, digit and space extends the match, so shortcuts wait.
 */
export function useListKeys() {
  const typed = useRef({ text: '', at: 0 });
  return (event: ReactKeyboardEvent<HTMLElement>, ctx: ListContext) => {
    const row = event.target;
    if (ctx.menuOpen || !(row instanceof HTMLElement) || !row.classList.contains('item-card')) return false;
    const list = event.currentTarget, rows = [...list.querySelectorAll<HTMLElement>('.item-card')], ids = ctx.matching.map(i => i.id);
    const at = Math.max(0, rows.indexOf(row));
    const focusRow = (index: number) => requestAnimationFrame(() => list.querySelectorAll<HTMLElement>('.item-card')[index]?.focus());
    // Picking several rows re-renders them without the swipe wrapper, which drops focus; keep it on the row so shortcuts still reach the list.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') { focusRow(at); return false; }
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const to = targetRow(event.key, at, ids.length, pageStep(list.clientHeight, row.offsetHeight + 2));
    if (to !== null) {
      event.preventDefault(); typed.current.text = '';
      if (event.shiftKey) {
        const open = ids.indexOf(ctx.selected), anchor = open >= 0 ? open : at;
        if (open < 0) ctx.setSelected(ids[at]);
        ctx.setBulkIds(rangeIds(ids, anchor, to));
      } else ctx.select(ids[to]);
      focusRow(to); return true;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); typed.current.text = '';
      if (ctx.picked > 1) focusWhenReady(['.selection-summary button:not(:disabled)']);
      else { if (ids[at] !== ctx.selected) ctx.select(ids[at]); requestAnimationFrame(() => focusWhenReady(DETAIL_TARGETS)); }
      return true;
    }
    if (!typeAheadKey(event.key)) return false;
    const now = Date.now(), active = Boolean(typed.current.text) && now - typed.current.at < TYPE_AHEAD_MS;
    if (!active && (event.key === ' ' || (!event.shiftKey && ctx.hasShortcut(event.nativeEvent)))) { typed.current.text = ''; return false; }
    event.preventDefault();
    const text = (active ? typed.current.text : '') + event.key.toLowerCase(); typed.current = { text, at: now };
    const found = typeAheadMatch(ctx.matching.map(i => i.title), at, text);
    if (found >= 0) { ctx.select(ids[found]); focusRow(found); }
    return true;
  };
}

/** Experimental keyboardUndo: Ctrl/Cmd+Z undoes and ? opens the shortcut sheet, whenever focus is not in a field, editor, dialog or menu. */
export function useGlobalKeys(on: boolean, handlers: { undo: () => void; sheet: () => void }) {
  const current = useRef(handlers); current.current = handlers;
  useEffect(() => {
    if (!on) return;
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || typingIn(event.target) || document.querySelector('dialog[open], .context-menu')) return;
      if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); current.current.sheet(); }
      else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); current.current.undo(); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [on]);
}
