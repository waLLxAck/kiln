import { useEffect, useRef } from 'react';
import type { CommandName, KilnCommand } from './command-names';
export { commandNames, commandSections, type CommandName, type KilnCommand } from './command-names';

export type CommandHandlers = Partial<Record<CommandName, (id?: string) => void>>;

/** Runs the matching handler for each `kiln:command` from quick search. Handlers are read at dispatch time, so they may close over fresh state. */
export function useKilnCommands(handlers: CommandHandlers) {
  const current = useRef(handlers); current.current = handlers;
  useEffect(() => {
    const receive = (event: Event) => { const { name, id } = (event as CustomEvent<KilnCommand | undefined>).detail ?? {}; if (name) current.current[name]?.(id); };
    window.addEventListener('kiln:command', receive); return () => window.removeEventListener('kiln:command', receive);
  }, []);
}
