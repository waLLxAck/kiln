import { useRef, useState, type DragEvent, type PointerEvent } from 'react';
import type { Item } from '../../../packages/protocol/schema';

const MIME = 'application/x-kiln-items';
type Handlers = { onDragOver?: (event: DragEvent<HTMLElement>) => void; onDragLeave?: (event: DragEvent<HTMLElement>) => void; onDrop?: (event: DragEvent<HTMLElement>) => void };
/** Chains two handlers for one event, so an item drop target can sit on a row that is already a collection drop target. */
const both = <E,>(a?: (event: E) => void, b?: (event: E) => void) => a && b ? (event: E) => { a(event); b(event); } : a ?? b;

/**
 * Experimental keyboardUndo: drag list rows onto sidebar collections (or Unfiled) to file them. Dragging a picked row takes
 * the whole selection. A custom type keeps these drags apart from collection drags (Collections.tsx) and from files dropped
 * to capture. Rows that can be swiped to archive only start a drag from their icon or with a mostly vertical first move, so
 * a sideways swipe still archives.
 */
export function useItemDrag({ on, onMove }: { on: boolean; onMove: (items: Item[], collection: string) => void }) {
  const [dragging, setDragging] = useState<Item[] | null>(null), [over, setOver] = useState<string | null>(null);
  const start = useRef<{ x: number; y: number; handle: boolean; decided: boolean } | null>(null);
  const end = () => { setDragging(null); setOver(null); };
  return {
    active: Boolean(dragging),
    /** Spread on a row's button. `swipes` says the row can be swiped to archive; `picked` is the multi-selection. */
    source: (item: Item, swipes: boolean, picked: Item[]) => !on ? {} : {
      // A swipeable row only becomes draggable once its first move is mostly vertical (or starts on the icon): Chromium cancels
      // the swipe's pointer as soon as a native drag begins, so the choice has to be made before the drag threshold.
      draggable: swipes ? undefined : true,
      onPointerDown: (event: PointerEvent<HTMLElement>) => { const handle = Boolean((event.target as Element).closest('.item-kind')); start.current = { x: event.clientX, y: event.clientY, handle, decided: !swipes || handle }; if (swipes) event.currentTarget.draggable = handle; },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const from = start.current; if (!swipes || !from || from.decided || !(event.buttons & 1)) return;
        const dx = Math.abs(event.clientX - from.x), dy = Math.abs(event.clientY - from.y); if (Math.max(dx, dy) < 2) return;
        from.decided = true; event.currentTarget.draggable = dy > dx;
      },
      onDragStart: (event: DragEvent<HTMLElement>) => {
        const items = picked.length > 1 && picked.some(i => i.id === item.id) ? picked : [item];
        event.dataTransfer.setData(MIME, JSON.stringify(items.map(i => i.id))); event.dataTransfer.effectAllowed = 'move';
        const badge = document.createElement('div'); badge.className = 'item-drag-image'; badge.textContent = items.length === 1 ? item.title : `${items.length} items`;
        document.body.append(badge); event.dataTransfer.setDragImage(badge, -12, -8); setTimeout(() => badge.remove(), 0);
        setDragging(items);
      },
      onDragEnd: (event: DragEvent<HTMLElement>) => { if (swipes) event.currentTarget.draggable = false; end(); },
    },
    /**
     * Spread on a drop target: `collection` is its name, '' for Unfiled. `existing` are the row's own drag handlers (a collection's
     * reorder drop), which keep working alongside.
     */
    target: <T extends Handlers>(collection: string, existing: T = {} as T) => !on ? existing : {
      ...existing,
      'data-item-drop': over === collection && dragging ? 'true' : undefined,
      onDragOver: both(existing.onDragOver, (event: DragEvent<HTMLElement>) => { if (!dragging || !event.dataTransfer.types.includes(MIME)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; if (over !== collection) setOver(collection); }),
      onDragLeave: both(existing.onDragLeave, (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(current => current === collection ? null : current); }),
      onDrop: both(existing.onDrop, (event: DragEvent<HTMLElement>) => { if (!dragging || !event.dataTransfer.types.includes(MIME)) return; event.preventDefault(); event.stopPropagation(); const items = dragging; end(); onMove(items, collection); }),
    },
  };
}
