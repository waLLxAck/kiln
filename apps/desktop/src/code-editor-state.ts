import { useLayoutEffect, useSyncExternalStore } from 'react';

/**
 * Shared state for the `codeEditor` experiment, so views without the settings (Config files, list rows) can follow the
 * switch live. App sets it from `snapshot.settings`; list rows read which items have a private draft. The draft ids are
 * read from localStorage once when needed and then updated only when an item gains or loses a draft, never per keystroke.
 */
let enabled = false;
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

/** Called once by App with whether the experiment is on. */
export function useCodeEditorFlag(on: boolean) {
  useLayoutEffect(() => { if (on === enabled) return; enabled = on; drafted = null; emit(); }, [on]);
}
/** Whether the code editor experiment is on, for components that do not receive the settings. */
export const useCodeEditorOn = () => useSyncExternalStore(subscribe, () => enabled);
/** Whether an item has a private draft, while the experiment is on. */
export const useDraftMark = (id: string) => useSyncExternalStore(subscribe, () => enabled && draftIds().has(id));
/** Records that an item gained or lost its private draft; list rows update only when that changes. */
export function noteDraft(id: string, present: boolean) {
  if (!drafted || drafted.has(id) === present) return;
  drafted = new Set(drafted); if (present) drafted.add(id); else drafted.delete(id);
  emit();
}
