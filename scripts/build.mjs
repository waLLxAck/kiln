import { build } from 'esbuild';
await import('./guidance.mjs');
await build({ entryPoints: ['apps/desktop/main.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/desktop/main.cjs', external: ['electron'], target: 'node22' });
await build({ entryPoints: ['apps/desktop/preload.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/desktop/preload.cjs', external: ['electron'], target: 'node22' });
await build({ entryPoints: ['apps/cli/main.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/cli/workbench.cjs', target: 'node22', banner: { js: '#!/usr/bin/env node' } });

await build({ entryPoints: ['apps/desktop/backend-worker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/desktop/backend-worker.cjs', target: 'node22' });

// Record where this build was made so the installed app can watch that repository's release folder for newer installers without being asked.
// KILN_SOURCE_ROOT overrides the recorded root, so a build made in a throwaway git worktree still points at the main checkout.
// KILN_PUBLIC_BUILD=1 records no folder at all: published installers shouldn't carry the build machine's paths, and have no local release folder to watch.
const { execSync } = await import('node:child_process'); const fs = await import('node:fs'); const path = await import('node:path');
let commit = ''; try { commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* Not a git checkout. */ }
const sourceRoot = path.resolve(process.env.KILN_SOURCE_ROOT || process.cwd());
const location = process.env.KILN_PUBLIC_BUILD === '1' ? {} : { sourceRoot, releaseDir: path.join(sourceRoot, 'release') };
fs.writeFileSync(path.join('dist', 'build-info.json'), JSON.stringify({ ...location, commit, builtAt: new Date().toISOString() }, null, 2));
