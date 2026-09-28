// Kept free of React so main.ts can validate commands with the same lists the renderer uses.

/**
 * What the quick-search window can ask the main window to do. main.ts validates the request (`desktop.command`), shows the main
 * window and forwards it; preload re-dispatches it as a `kiln:command` event (see commands.ts).
 */
export const commandNames = ['capture', 'open-item', 'test-item', 'navigate', 'sync-installs', 'new-collection', 'toggle-theme', 'ask-item', 'check-updates'] as const;
export type CommandName = typeof commandNames[number];
/** `id` is the item for the `*-item` commands and the section for `navigate`. */
export type KilnCommand = { name: CommandName; id?: string };
/** Sections `navigate` accepts; the same ids the main window's navigation uses. */
export const commandSections = ['library', 'machines', 'home', 'activity', 'settings', 'archive', 'trash', 'experiments'] as const;
