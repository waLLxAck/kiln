# Architecture

The npm workspace monorepo contains `@kiln/desktop` (`apps/desktop`), `@kiln/cli` (`apps/cli`), `@kiln/core` (`packages`), and an independent `@kiln/marketing` website (`apps/marketing`). One root lockfile installs all workspaces. Product builds retain the root Electron entry point and existing `dist/desktop`, `dist/renderer`, and `dist/cli` paths; the website builds to `dist/marketing` and is excluded from the Electron package.

Electron owns native windows, the tray, shortcuts, clipboard, file pickers, and a narrow IPC bridge. React renders the editor and quick palette. The CLI and Electron call the same domain router.

| Module | Responsibility |
| --- | --- |
| `apps/desktop/main.ts` | Native shell, guarded IPC, trusted file and clipboard operations |
| `apps/desktop/src/` | Library, editor, experiments, deployments, GitHub, machines, quick search |
| `apps/cli/main.ts` | Scriptable JSON interface to the shared domain |
| `packages/protocol/` | Runtime-validated records and request types |
| `packages/domain/` | Revisions, approval, trials, provenance, import/export and organization |
| `packages/storage/` | Atomic writes, cross-process lock, path guards, bundle files, rebuildable search |
| `packages/deployment/` | Approved snapshots, target ownership, plans, receipts, rollback, uninstall, recovery |
| `packages/git/` | Checkpoints, synchronization, conflicts, GitHub, standard infrastructure and legacy migration |
| `packages/providers/` | Official-client detection and explicit manual handoff support |
| `packages/home/` | Home-folder instruction files (`~/.claude/CLAUDE.md`, `~/AGENTS.md`, `~/.codex/AGENTS.md`) and PowerShell profiles: list, edit in place with a stale-hash guard, kept versions, user-added files |

Electron was chosen to keep desktop and CLI invariants in one TypeScript implementation and make real Windows UI tests repeatable. The two foundation prototypes proposed by Gate A were not completed. No code was copied from Skills Manager or T3 Code; their pinned inspection references are recorded in the implementation report.

The renderer has no Node access, uses a sandbox and context isolation, and receives only an allowlisted request function. The main process validates sender frame/origin, arguments and paths. Navigation, webviews and permission requests are blocked. Previews render inert text or user-imported assets. External URLs are limited to HTTP(S); imported programs are revealed in Explorer rather than launched.

Canonical mutations use a cross-process lock, optimistic revision checks and atomic individual file replacement. Item saves also persist a transaction intent before changing working files; recovery completes that exact revision before external-edit reconciliation. A dead lock owner can be recovered by PID. Deployment has its own explicit journal because it changes multiple destination files. Git checkpoints use a temporary index so unrelated staged work cannot enter a Kiln checkpoint.

SQLite is a search cache. Canonical snapshots and metadata stay readable JSON/Markdown. A file watcher marks search dirty; refresh reconciles external working-file changes into new drafts and verifies revision hashes.

GitHub uses the official `gh` executable and its authentication store. Commands use argument arrays without shell interpolation. Authentication is not proxied through Kiln and tokens are not copied into the library.

A library is usable only when it is a standard Kiln repository with a GitHub remote (`Snapshot.repository.ready`); the desktop app shows setup until then. Approving a revision records the approval and persists a private publication snapshot. `packages/git/publish.ts` builds a Git tree from that immutable snapshot, its approval and redacted supporting evidence, without staging working item directories. Earlier unapproved revisions and later edits stay local. Desktop approval uses a plain commit message without invoking an agent. Publication retries use the same persisted snapshot. Generated repository validation shares the app's versioned revision identity function, including descriptions in new hashes and agent metadata.

Agent consent is checked in Electron before calls reach the worker. Chat remains a flexible CLI integration with broad permissions; the warning records an optional machine-private opt-out. Each conversation has its own ID and folder. Raw sessions remain private; explicit transcript export is separate from authored-library export. Legacy private revisions are archived outside the canonical repository and remain readable locally.

Managed experiments can select a local project as the provider working directory. Private job folders still hold attachments, provider traces and results; private trial environments record the requested workspace. Canonical experiment records keep only a machine-private placeholder. Both runners retain read-only permissions. Failed-run retries reuse the selected project, context, provider and immutable item revision.
