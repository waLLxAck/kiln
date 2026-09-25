/**
 * Build-time switches for the desktop renderer. vite.config.ts reads them from the environment when the renderer is built (or
 * served by `npm run dev`) and bakes them in as `define` constants; they are not settings and cannot change at run time.
 *
 * - `machines`: the Machines section is not reliable yet. Public release builds (KILN_PUBLIC_BUILD=1, as release.yml builds them)
 *   show a "Coming soon" page in its place; every other build shows the real section. KILN_SHOW_MACHINES=1 shows it in a public
 *   build too, and KILN_SHOW_MACHINES=0 hides it in any build, to try the public page locally.
 */
export function desktopFlags(env: Record<string, string | undefined> = process.env) {
  const machines = env.KILN_SHOW_MACHINES === '1' ? true : env.KILN_SHOW_MACHINES === '0' ? false : env.KILN_PUBLIC_BUILD !== '1';
  return { machines };
}
/** The `define` entries for Vite: each flag as a global constant the renderer reads through src/features.ts. */
export const desktopDefines = (env: Record<string, string | undefined> = process.env) => ({ __KILN_SHOW_MACHINES__: JSON.stringify(desktopFlags(env).machines) });
