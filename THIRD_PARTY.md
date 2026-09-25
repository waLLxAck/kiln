# Third-party software

Kiln's original source is MIT licensed. The exact dependency graph is pinned in `package-lock.json`; each package retains its own licence. React, react-markdown, remark-gfm, Electron, Vite, esbuild, diff, YAML, Zod, and the Node.js tooling carry their upstream notices. Lucide icons use the ISC licence. TypeScript and Playwright use Apache-2.0.

Electron distributions include Chromium and other components with additional notices in `LICENSE.electron.txt` and `LICENSES.chromium.html`. Keep these files with the packaged application. Dependencies' licences are not replaced by Kiln's licence.

No source code was copied from the open-source projects that were inspected during planning (see [implementation and verification](docs/IMPLEMENTATION.md)). Inspecting a project does not include it in this distribution.

Imported skill content retains its original source and licence metadata. The migration records the nearest upstream licence as item metadata; it does not copy licence text into skill folders. An unknown licence remains marked unknown; import does not relicense a skill or authorize its public redistribution. Public GitHub publishing is an explicit user action.

The marketing site bundles Caveat, Familjen Grotesk, Instrument Sans and JetBrains Mono from the [Google Fonts repository](https://github.com/google/fonts/tree/main/ofl). These fonts use the SIL Open Font License 1.1. Their copyright notices are listed in `apps/marketing/src/fonts/README.md`, and each font file carries its copyright notice and licence URL in its name table.
