# Developing Kiln

Building, testing, packaging and releasing Kiln. For how the code is organised, see [ARCHITECTURE.md](ARCHITECTURE.md); for what has been verified, see [IMPLEMENTATION.md](IMPLEMENTATION.md). User-facing behaviour is described in the [user guide](GUIDE.md).

## Requirements

Windows, macOS or Linux, Node.js 24 LTS (22.16 or newer), npm, Git. GitHub features additionally require GitHub CLI. Official Codex/Claude clients are optional for manual handoffs; Kiln does not store their authentication or request a model API key.

## Monorepo

One npm workspace repository contains the product and its marketing site, with one root lockfile:

| Workspace | Location | Responsibility |
| --- | --- | --- |
| `@kiln/desktop` | `apps/desktop/` | Electron shell and React desktop UI |
| `@kiln/cli` | `apps/cli/` | Command-line interface |
| `@kiln/marketing` | `apps/marketing/` | Independently built marketing website |
| `@kiln/core` | `packages/` | Shared domain, protocol, storage, agents, Git, deployment and configuration modules |

Root scripts coordinate builds and retain the existing desktop packaging paths. Shared TypeScript source is bundled into the desktop and CLI; the marketing site has its own Vite configuration and output directory. Site changes do not require starting Electron.

## Commands

```sh
npm ci
npm run dev                 # Desktop + renderer
npm run dev:marketing       # Marketing site at http://127.0.0.1:5174
npm run build               # Desktop + CLI
npm run build:marketing     # Static website in dist/marketing
npm run build:all           # Product + website
npm run preview:marketing   # Serve the built website
npm run check
npm test
npm run test:desktop
npm run package
npm run dist:win            # on Windows: release/Kiln Setup <version>.exe
npm run dist:mac            # on macOS: arm64 and x64 .dmg and .zip
npm run dist:linux          # on Linux: .AppImage and .deb
```

Each installer builds on its own platform; `.github/workflows/release.yml` builds all three on GitHub's runners.

`npm run test:desktop` runs isolated Electron tests. The real-install test is skipped by default and must be explicitly enabled; it should only be run against an authorized machine (see [IMPLEMENTATION.md](IMPLEMENTATION.md#executed-checks)). Build outputs and local verification evidence are ignored by Git.

The CLI runs with `npm run cli -- <command>`; after building, `npm link` makes `kiln` and `workbench` available. Its commands and options are in the [user guide](GUIDE.md#command-line-interface).

## Run a local build

On Windows, run `release/0.18.2/win-unpacked/Kiln.exe` or install the setup executable from `release/0.18.2`; keep the unpacked executable beside its supporting files. On macOS and Linux, `npm run dist:mac` and `npm run dist:linux` leave `release/mac-arm64/Kiln.app` (or `mac/` for Intel) and `release/linux-unpacked/kiln-workbench` next to the packages.

## In-app updates for local builds

The in-app update flow is for Windows builds made from a local checkout. Installs from GitHub update from the releases page (see the [user guide](GUIDE.md#updating-the-installed-app)).

Every build records where it was made. Kiln watches that repository's `release` folder (top level or one folder down) for a newer `Kiln Setup <version>.exe`. Checks run on startup and window focus. **Prepare update** copies the installer into Kiln's private update cache and verifies it while the app stays open. A progress indicator becomes **Restart to update** when ready. Preparation never launches the installer; closing Kiln normally does not install it, and the ready state survives reopening even if the original release folder disappears.

Only **Restart to update** verifies the cached installer again, starts it silently for the current user, and quits Kiln so Windows can replace the running files. The installer then relaunches Kiln. Save your work before restarting. If verification or starting the installer fails, Kiln stays open and offers a retry. Settings → Updates can choose a different source folder or stop checking.

Build a newer installer with `npm run dist:win` after increasing `version` in `package.json`. When building from a worktree, set `KILN_SOURCE_ROOT` to the main checkout. Published installers are built with `KILN_PUBLIC_BUILD=1`, which records no source folder, so they don't watch for local builds.

## Releases

Pushing a version tag such as `v0.18.2` runs `.github/workflows/release.yml`, which builds Windows, Linux and macOS on their own runners, starts each packaged app once, and publishes all the files with one `SHA256SUMS.txt` and the notes from [`docs/releases/`](releases/). Running that workflow by hand is a dry run: it builds everything and uploads the files as workflow artifacts without publishing.

## Performance diagnostics

Performance logs live in the `logs` folder under Electron's user-data directory (Settings → Open performance logs; paths are in the [user guide](GUIDE.md#panels-and-performance-logs)). `performance.jsonl` records request start/end/error codes, background queue and execution timings, requests still pending after two seconds, renderer tasks over 100 ms, event-loop delays over 500 ms, unresponsive/recovered windows, renderer exits, and CPU/memory samples every 15 seconds. One previous 5 MB log is retained as `performance.jsonl.1`. Nothing is uploaded. Request arguments, skill bodies, and credentials are excluded.

After a freeze, inspect the timestamps and match `requestId` or backend `id` across records. `backend.slow` is recorded by the main process while the worker is still busy. `queueMs` distinguishes waiting from execution. A renderer stall is recorded on recovery; Electron's unresponsive event can report a window that has not recovered. Main-loop stalls are recorded after recovery. A forced process kill or machine shutdown can prevent the final events from reaching disk. Logs diagnose symptoms; they do not guarantee a record of every OS-level hang.

Library, Git, import and search work run in a background worker with ordered mutations. Read-only GitHub/provider checks run independently of that queue. Unchanged snapshots skip skill reconciliation and index rebuilding; filesystem changes invalidate that cache.

Verification: `npm test`, `npm run build`, and `npx playwright test tests/desktop/performance.spec.ts tests/desktop/workbench.spec.ts`. The performance fixture creates and imports 217 temporary skills, checks main-loop responsiveness and saved panel widths, and deliberately blocks the renderer to verify diagnostics.

## Marketing site

The marketing homepage is a founder’s printout reviewed in red pen: skill folders tidy themselves into a Kiln skills panel, then a captured video prompt is tested, fixed, rerun and approved onto the same panel. It uses real HTML text and controls, with keyboard and tap fallbacks for every drag and calm end states for reduced motion. `node scripts/verify-marketing.mjs` checks it and the support page in Chromium. See [the marketing site](../apps/marketing/README.md).

The site is published at [wallxack.github.io/kiln](https://wallxack.github.io/kiln/) by the [Pages workflow](../.github/workflows/pages.yml) on every push to `main`. It installs only the marketing workspace and builds with `BASE_PATH=/kiln/`; set the same variable locally to check a build served under that path.

## Screenshots

The README and website screenshots are made by a workflow from a fictional demo library; see [docs/screenshots](screenshots/README.md).
