# Kiln marketing

The homepage is a founder's printout reviewed in red pen: “My agents were loading skills I forgot I had. So I built this.” Two printed sheets tell the story. On the first, doodled skill folders tidy themselves into a Kiln skills panel: folder labels become the columns, each file flies into its cell, duplicates merge into one row, and a dead link and an empty folder crumple into the cleanup bar. On the second, a visitor drags a phone playing a YouTube video, a post or a skills repository into Capture, drags the prompt into Test, fixes the line that made the run uncertain, reruns it, approves it, and sees the new skill land on the same panel with its install switches off. A download section with the unsigned-build note and four questions closes the page. A short support page (`support/index.html`) explains that Kiln is free, MIT licensed and built by one developer, links to Ko-fi and lists the other ways to help.

Run from the repository root:

```sh
npm run dev:marketing
npm run build:marketing
npm run preview:marketing
```

The pages are plain TypeScript and DOM with template strings; there is no framework, backend or tracking, and they make no external requests. `index.html` and `support/index.html` are the two Vite inputs. `src/chrome.ts` renders the header and footer both pages share, and `src/support.ts` renders the support page. `src/main.ts` boots `src/home.ts`, which renders the hero and the closing section and wires the two acts: `src/folders.ts` (the doodle and the tidy-up) and `src/new-skills.ts` (capture, test and approve). `src/panel.ts` renders and drives both copies of the skills panel from the sample rows in `src/content.ts`. `src/ink.ts` places the margin notes and draws the red-pen marks and arrows with `src/rough.ts`; `src/drag.ts` handles pointer dragging and the flights used by the keyboard and tap fallbacks. `src/styles.css` holds the reset and all page styles.

Everything interactive changes only page state. The panel, folders, sources, test runs and token counts are labelled samples; test runs replay sample output and nothing on the page calls a model. Product claims follow the root README. The download links to the 0.18.0 Windows installer on the public GitHub releases page, links to all releases, and says the build is unsigned, so Windows SmartScreen may warn about it. Every external link (repository, releases, installer, issues and the Ko-fi page) is a constant at the top of `src/content.ts`; change `kofi` there to move donations elsewhere, and keep `.github/FUNDING.yml` and the root README in step.

Every drag has a button fallback (Add to Kiln, Test on my repo), switches are real buttons with `role="switch"`, and the diff flyout takes focus and closes with Escape. Visitors who prefer reduced motion get the end states at once: the folders are already in the panel, the notes are already written, and nothing flies.

The fonts are self-hosted in `src/fonts`: Caveat, Familjen Grotesk, Instrument Sans and JetBrains Mono, all under the SIL Open Font License 1.1. `src/fonts/README.md` lists their copyright notices.

Run `node scripts/verify-marketing.mjs` from the repository root with the development server running. It checks five widths for page errors, failed requests and horizontal overflow, drives the tidy-up, a switch and the diff flyout, Add to Kiln, the uncertain run, the one-line edit, the passing rerun, approval, the new panel row and the download link with reduced motion emulated, then repeats the flows once with full motion. It also checks the support page at three widths: the Ko-fi button, the other ways to help, the links back to the homepage, and that every support link resolves under the site's base path. Set `MARKETING_URL` to check a built or served instance (for example `http://127.0.0.1:4174/kiln/`), and `CHROMIUM_PATH` if Chromium is not at `/usr/bin/chromium`.

Vite outputs `dist/marketing` separately from the desktop renderer. The Electron package excludes the website. Build both with `npm run build:all`.

The build respects a `BASE_PATH` environment variable (default `/`). Internal links use Vite's `import.meta.env.BASE_URL`, so the site works under any base. GitHub Pages serves it at https://wallxack.github.io/kiln/: `.github/workflows/pages.yml` installs only this workspace (no Electron download), builds with `BASE_PATH=/kiln/` and deploys on every push to `main`, or when run by hand. To try that build locally, run `BASE_PATH=/kiln/ npm run build:marketing` and then `BASE_PATH=/kiln/ npm run preview:marketing`, which serves it at http://127.0.0.1:4174/kiln/.
