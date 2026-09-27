/** Commands quick search offers (betterSearch): the palette lists them, the main window runs them. */
import { useEffect, useRef } from 'react';
import { paletteCommandIds, type PaletteCommandId } from './palette-command-ids';

export { paletteCommandIds, type PaletteCommandId };
export const paletteCommands: { id: PaletteCommandId; title: string; hint: string }[] = [
  { id: 'capture', title: 'New capture', hint: 'Save a prompt, link or idea' },
  { id: 'library', title: 'Go to Library', hint: 'Everything you keep' },
  { id: 'experiments', title: 'Go to Experiments', hint: 'Trials and their results' },
  { id: 'home', title: 'Go to Config files', hint: 'Agent instruction and config files' },
  { id: 'activity', title: 'Go to Activity', hint: 'What changed and when' },
  { id: 'settings', title: 'Go to Settings', hint: 'Repository, folders and preferences' },
  { id: 'updates', title: 'Check for updates', hint: 'Look for a newer Kiln now' },
];
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** Commands whose title or hint has a word starting with every query word; all of them for an empty query. */
export function matchCommands(query: string) {
  const wanted = words(query);
  return paletteCommands.filter(c => { const have = words(`${c.title} ${c.hint}`); return wanted.every(w => have.some(h => h.startsWith(w))); });
}

/** The main window's side: quick search sets `#command=<id>` (see desktop.workbench in main.ts) and this runs it once. */
export function usePaletteCommands(run: (command: PaletteCommandId) => void) {
  const latest = useRef(run); latest.current = run;
  useEffect(() => {
    const handle = () => {
      const command = new URLSearchParams(location.hash.slice(1)).get('command');
      if (!command) return;
      history.replaceState(null, '', location.pathname + location.search);
      if ((paletteCommandIds as readonly string[]).includes(command)) latest.current(command as PaletteCommandId);
    };
    handle(); window.addEventListener('hashchange', handle); return () => window.removeEventListener('hashchange', handle);
  }, []);
}
