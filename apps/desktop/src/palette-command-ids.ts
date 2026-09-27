/** Ids of the quick search commands (betterSearch). Kept free of React so the main process can validate them too. */
export const paletteCommandIds = ['capture', 'library', 'experiments', 'home', 'activity', 'settings', 'updates'] as const;
export type PaletteCommandId = typeof paletteCommandIds[number];
