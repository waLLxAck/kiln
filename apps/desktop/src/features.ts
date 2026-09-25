// Build-time switches baked in by vite.config.ts (see ../build-flags.ts). Outside a Vite build, such as in unit tests, the
// constant is missing and every section is shown.
declare const __KILN_SHOW_MACHINES__: boolean | undefined;
/** False in public release builds: the Machines section shows "Coming soon" and nothing links into it. */
export const machinesEnabled: boolean = typeof __KILN_SHOW_MACHINES__ === 'undefined' ? true : __KILN_SHOW_MACHINES__;
