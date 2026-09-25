# Implementation and verification

Status: local workflow release, 6 September 2026. The requirement IDs (FR-01 to FR-14) come from the original product requirements, which cover a broader roadmap; this report distinguishes implemented behavior from remaining gates.

## Coverage

| Requirement | Implemented behavior / limit |
| --- | --- |
| FR-01 | Text, Markdown, links, imported images/files, private file references; revision history, trash and restore |
| FR-02 | Tags, favourites, custom collections, reorder, FTS search, variables, duplicate warnings |
| FR-03 | Windows tray, configurable global shortcut, quick palette, copy/open and editor |
| FR-04 | Git attachment, exact checkpoints, diff, fetch/pull/push, three-way item conflicts, keep both revisions, restore |
| FR-05 | Lifecycle states, exact-hash approval, source/origin, trial and action history |
| FR-06 | Exact-revision manual handoff, representative task, rubric, variables, private output/reference, human judgement |
| FR-07 | Separate draft skill with source prompt/revision link, structured procedure and validation |
| FR-08 | Approved snapshot copies to Codex/Claude skill and instruction destinations; preview, receipts, drift, rollback and uninstall |
| FR-09 | Official client detection and manual handoff; no API key required by Kiln. Managed execution is not implemented |
| FR-10 | GUI and CLI share domain methods, IDs, validation and locking |
| FR-11 | GitHub create/clone/connect, Git sync, named local profiles, private paths and drift. No remote machine dashboard |
| FR-12 | Not implemented: SSH enrollment, companion protocol, remote deployment and runs |
| FR-13 | App observations with deduplication and explicit unknown external coverage. No external harness hooks |
| FR-14 | Complete authored JSON export/import including assets and empty custom collections; private paths and transcripts excluded |
| Existing skills repository | Standard layout and owned infrastructure updates; additive migration of an existing skills repository; live GitHub connection and disposable install/uninstall test |

## Executed checks

- 22 unit/integration tests passed: revisions, imported trust, export recovery, path/asset guards, immutable deployments, two-agent instruction scope, private references, locks, Git staging preservation, two-offline-version conflict resolution, interrupted local apply recovery, standard infrastructure ownership, full-bundle migration, and uninstall/reinstall/drift.
- Two real Electron UI tests passed: capture/copy/trial/approval/deploy/edit/rollback; quick palette keyboard copy/Escape, reopen persistence and hostile preview.
- One opt-in real-machine Electron test passed: 217 migrated skills visible, the library's private GitHub repository connected, disposable skill installed and uninstalled through the UI for both Codex and Claude, exact destination bytes checked. All 1,066 pre-existing installation entries unchanged.
- TypeScript check and production build passed. The NSIS installer was built and installed per-user under `%LOCALAPPDATA%\Programs\Kiln`, with Desktop and Start Menu shortcuts. A real test launched that installed executable, displayed the selected library's 217 active skills, verified both enrolled agents and recorded zero renderer errors. Package hashes and screenshots are in `artifacts/skills-migration/`.
- Dependency audit after the esbuild update reported zero known vulnerabilities. This is a point-in-time audit, not a security guarantee.

Tests use real files and Git repositories in temporary directories with spaces and Unicode. They do not execute imported skill scripts. Trial judgements in deterministic tests are fixtures; no claim is made that an official model produced those outputs. The live disposable skill test verifies installation, not model invocation.

Run `npm test` and `npm run test:desktop` to repeat safe local checks. The real-machine test requires `KILN_LIVE_TEST=1`, an explicitly authorized `KILN_LIVE_LIBRARY` and the `owner/repository` it is connected to in `KILN_LIVE_REPOSITORY`; leave it disabled for ordinary CI.

## Remaining release work

Gate A's comparative foundation prototypes, full Windows installer/DPI/monitor/clipboard-contention matrix, measured 10,000-item performance targets, signed builds, SSH companion and interruption tests, managed official-agent sessions, and optional external observation hooks remain open. GitHub creation/clone commands are implemented; the live test checked the existing GitHub connection without creating an unnecessary remote repository.

Existing external installations remain visible but cannot be uninstalled by Kiln. Transfer from another installer is a separate migration step; this release refuses automatic takeover, including junctions. The 22 imported validation warnings remain visible rather than altering upstream content.

## Foundation inspection references

- Skills Manager: `xingkongliang/skills-manager` at `bb926d070f313e604c1b805ad2366520ee85af43`.
- T3 Code: `pingdotgg/t3code` at `5fa35d211682ee02e34fba0711838ca431ed003b`.

These are inspection pins, not vendored dependencies or measured prototypes. The application is an original implementation.
