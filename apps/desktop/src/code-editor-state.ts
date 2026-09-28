import { useSyncExternalStore } from 'react';

/**
 * Which items have a private draft, for the marks on list rows. The draft ids are read from localStorage once when needed
 * and then updated only when an item gains or loses a draft, never per keystroke.
 */
let drafted: Set<string> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function draftIds() {
  if (!drafted) {
    drafted = new Set();
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith('kiln-draft:')) drafted.add(key.slice('kiln-draft:'.length)); }
  }
  return drafted;
}

/** Whether an item has a private draft. */
export const useDraftMark = (id: string) => useSyncExternalStore(subscribe, () => draftIds().has(id));
/** Records that an item gained or lost its private draft; list rows update only when that changes. */
export function noteDraft(id: string, present: boolean) {
  if (!drafted || drafted.has(id) === present) return;
  drafted = new Set(drafted); if (present) drafted.add(id); else drafted.delete(id);
  emit();
}
