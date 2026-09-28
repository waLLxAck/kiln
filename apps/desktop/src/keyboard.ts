import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Item } from '../../../packages/protocol/schema';
import { pageStep, rangeIds, targetRow, TYPE_AHEAD_MS, typeAheadKey, typeAheadMatch } from './keyboard-undo';

/** Focus is somewhere keys type text: fields, the code editor, anything editable. */
export const typingIn = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor'));
/** Focuses the first element matching one of `selectors` once it is on screen (the item page loads after the row is opened). */
export function focusWhenReady(selectors: string[], frames = 120) {
  const target = selectors.map(s => document.querySelector<HTMLElement>(s)).find(Boolean);
  if (target) target.focus(); else if (frames > 0) requestAnimationFrame(() => focusWhenReady(selectors, frames - 1));
}
/** The open item's main button: the header's primary action, else its More menu, else anything on the page. */
const ITEM_TARGETS = ['.item-page .detail-actions .button.primary:not(:disabled)', '.item-page .detail-actions .item-more', '.item-page button:not(:disabled)'];
const rowSelector = (id: string) => `.item-card[data-id="${CSS.escape(id)}"]`;

type ListContext = {
  /** The rows in the order shown, folded groups left out. */
  rows: Item[]; selected: string; picked: number;
  /** Makes a row the open one, dropping any multi-selection. */
  focus: (id: string) => void;
  /** Picks a range of rows with `anchor` as the open one, as Shift-click does. */
  pick: (ids: string[], anchor: string) => void;
  open: (id: string) => void; selectAll: () => void;
  /** What a single-key shortcut on this row (or the selection) would do, without doing it; null when the key is not one. */
  shortcut: (event: KeyboardEvent, id: string) => (() => void) | null;
};
/**
 * The library table's keys while a row has focus. Returns whether it handled the key.
 * - Arrows, Home/End and PageUp/PageDown move the open row; with Shift they extend the selection from the open row.
 * - Enter opens the row and moves focus to the item's main action (with several picked: to the bulk bar).
 * - Type-ahead: a letter or digit that is not a shortcut for the row, or any Shift+letter, starts matching titles; while
 *   typing continues (under a second between keys) every letter, digit and space extends the match, so shortcuts wait.
 * - Ctrl/Cmd+A picks every row shown, keeping focus on the row.
 * - Any other shortcut key runs its menu entry.
 */
export function useListKeys() {
  const typed = useRef({ text: '', at: 0 }), pending = useRef<string | null>(null);
  // Picking several rows re-renders them without the swipe wrapper, which drops focus. Focusing again right after the commit,
  // before the next key arrives, keeps fast key presses (Shift+↓ ↓) on the list.
  useLayoutEffect(() => { if (pending.current && !document.activeElement?.matches(rowSelector(pending.current))) document.querySelector<HTMLElement>(rowSelector(pending.current))?.focus(); });
  return (event: ReactKeyboardEvent<HTMLElement>, ctx: ListContext) => {
    const row = event.target;
    if (!(row instanceof HTMLElement) || !row.classList.contains('item-card')) return false;
    const list = event.currentTarget, ids = ctx.rows.map(i => i.id);
    // Keys act on the row that has focus, which Tab or a script may have moved away from the open one.
    const id = row.dataset.id ?? ctx.selected, at = Math.max(0, ids.indexOf(id));
    const focusRow = (target: string) => { pending.current = target; list.querySelector<HTMLElement>(rowSelector(target))?.focus(); requestAnimationFrame(() => requestAnimationFrame(() => { if (pending.current === target) pending.current = null; })); };
    const run = (action: () => void) => { event.preventDefault(); typed.current.text = ''; action(); return true; };
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') return run(() => { ctx.selectAll(); focusRow(id); });
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const to = targetRow(event.key, at, ids.length, pageStep(list.clientHeight, row.offsetHeight));
    if (to !== null) return run(() => {
      if (event.shiftKey) { const open = ids.indexOf(ctx.selected), anchor = open >= 0 ? open : at; ctx.pick(rangeIds(ids, anchor, to), ids[anchor]); }
      else ctx.focus(ids[to]);
      focusRow(ids[to]);
    });
    if (event.key === 'Enter' && !event.shiftKey) return run(() => {
      if (ctx.picked > 1) focusWhenReady(['.bulk-bar button:not(:disabled)']);
      else { ctx.open(id); requestAnimationFrame(() => focusWhenReady(ITEM_TARGETS)); }
    });
    const shortcut = () => ctx.shortcut(event.nativeEvent, id);
    if (!typeAheadKey(event.key)) { const action = shortcut(); return action ? run(action) : false; }
    const now = Date.now(), active = Boolean(typed.current.text) && now - typed.current.at < TYPE_AHEAD_MS;
    if (!active) {
      if (event.key === ' ') return false;
      const action = event.shiftKey ? null : shortcut();
      if (action) return run(action);
    }
    event.preventDefault();
    const text = (active ? typed.current.text : '') + event.key.toLowerCase(); typed.current = { text, at: now };
    const found = typeAheadMatch(ctx.rows.map(i => i.title), at, text);
    if (found >= 0) { ctx.focus(ids[found]); focusRow(ids[found]); }
    return true;
  };
}

/** Ctrl/Cmd+Z undoes and ? opens the shortcut sheet, whenever focus is not in a field, editor, dialog or menu. */
export function useGlobalKeys(handlers: { undo: () => void; sheet: () => void }) {
  const current = useRef(handlers); current.current = handlers;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || typingIn(event.target) || document.querySelector('dialog[open], .context-menu')) return;
      if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); current.current.sheet(); }
      else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); current.current.undo(); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, []);
}
