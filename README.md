<p align="center"><img src="assets/kiln.svg" width="96" height="96" alt="Kiln logo: a cream kiln arch with an orange fire opening on a dark rounded square"></p>

<p align="center"><a href="https://ko-fi.com/wallxack"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support Kiln on Ko-fi" height="36"></a></p>

# Kiln

A local desktop workbench for prompts and agent skills. Capture useful material, test an exact revision, record a decision, and install an approved snapshot into Codex, Claude Code or GitHub Copilot. Kiln is a desktop app for Windows, macOS and Linux; the macOS and Linux builds are new in 0.18.1 and have not been tested on real machines yet.

Kiln is for developers who want to keep useful agent workflows, understand which versions they have tested, and reuse approved skills across projects and machines. The desktop app and CLI share one library and the same approval rules. Kiln is free and MIT licensed; managed agent interactions use your installed, signed-in Codex or Claude Code CLI and its account usage.

**[Website](https://wallxack.github.io/kiln/)** · **Download: [Windows](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln.Setup.0.18.2.exe) · [macOS](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln-0.18.2-arm64.dmg) · [Linux](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln-0.18.2-x86_64.AppImage)** · [All releases](https://github.com/waLLxAck/kiln/releases) · [Report an issue](https://github.com/waLLxAck/kiln/issues) · **[❤️ Sponsor](https://ko-fi.com/wallxack)**

## Screenshots

![Kiln showing the code-review skill: an install switch per folder, and the Claude copy flagged as edited outside Kiln](docs/screenshots/skill-installs.png)

One skill, a switch per install location, and every folder it's in, including a copy edited outside Kiln.

| | |
| --- | --- |
| ![A YouTube video distilled into a prompt, techniques, an insight and a tool](docs/screenshots/video-distilled.png) | ![A prompt tested read-only on a local project, with a pass verdict](docs/screenshots/experiment-result.png) |
| A video distilled into a prompt, techniques, an insight and a tool, each linked to its minute. | The prompt tested read-only on your own project, with the agent's verdict for that exact revision. |
| ![An older copy of a skill compared line by line with the approved version](docs/screenshots/drift-compare.png) | ![Agent instructions, permissions and hooks in one editor](docs/screenshots/config-files.png) |
| An older copy found in another folder, compared with the approved version. | Agent instructions, permissions and hooks in one editor, with previous versions. |

Screenshots of Kiln on Windows with a made-up library; the agent's replies in them are scripted. [All screenshots and how they're made](docs/screenshots/).

## Download

Kiln 0.18.2 is on the [releases page](https://github.com/waLLxAck/kiln/releases), with earlier versions, release notes and `SHA256SUMS.txt`.

| Platform | File | Status |
| --- | --- | --- |
| Windows (x64) | [`Kiln.Setup.0.18.2.exe`](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln.Setup.0.18.2.exe) | Supported |
| macOS, Apple silicon | [`Kiln-0.18.2-arm64.dmg`](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln-0.18.2-arm64.dmg) (or [`.zip`](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln-0.18.2-arm64.zip)) | New, untested |
| macOS, Intel | [`Kiln-0.18.2-x64.dmg`](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln-0.18.2-x64.dmg) (or [`.zip`](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln-0.18.2-x64.zip)) | New, untested |
| Linux (x64) | [`Kiln-0.18.2-x86_64.AppImage`](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/Kiln-0.18.2-x86_64.AppImage) or [`kiln_0.18.2_amd64.deb`](https://github.com/waLLxAck/kiln/releases/download/v0.18.2/kiln_0.18.2_amd64.deb) | New, untested |

"Untested" means the macOS and Linux builds are built, inspected and started once on GitHub's CI runners, but nobody has used them on a real Mac or Linux desktop yet. Please [report what breaks](https://github.com/waLLxAck/kiln/issues). If you would rather not run an unsigned build, [build Kiln from source](#build-from-source).

**Windows.** The installer is unsigned, so Windows SmartScreen may warn you before it runs: choose **More info**, then **Run anyway**. It installs per user and lets you choose the installation folder.

**macOS.** Open the disk image and drag Kiln to Applications. The app is ad-hoc signed (so it runs on Apple silicon) but not notarized by Apple, so Gatekeeper blocks the first launch. Right-click Kiln in Applications and choose **Open**; on macOS 15 and later, try to open it once, then choose **Open Anyway** in System Settings → Privacy & Security. Alternatively, clear the quarantine flag in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Kiln.app
```

**Linux.** Either make the AppImage executable and run it (AppImages need FUSE 2: `libfuse2`, or `libfuse2t64` on Ubuntu 24.04):

```sh
chmod +x Kiln-0.18.2-x86_64.AppImage
./Kiln-0.18.2-x86_64.AppImage
```

or install the Debian/Ubuntu package, which adds Kiln to the applications menu (the package is named `kiln-workbench`; remove it with `sudo apt remove kiln-workbench`):

```sh
sudo apt install ./kiln_0.18.2_amd64.deb
```

Ubuntu 23.10 and later restrict the unprivileged user namespaces that Chromium's sandbox uses. When they are unavailable, the AppImage's launcher starts Kiln with `--no-sandbox`, so the renderer runs without Chromium's sandbox. If Kiln still exits with a sandbox error, start it with `./Kiln-0.18.2-x86_64.AppImage --no-sandbox`. The .deb installs an AppArmor profile meant to keep the sandbox on. Kiln itself never turns the sandbox off.

To use Kiln you also need Git and the [GitHub CLI](https://cli.github.com/) (`gh`), signed in: first launch creates or opens your Kiln repository on GitHub. Managed runs need the official Codex or Claude Code CLI, and video distillation needs [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on PATH.

## What Kiln offers

This README is the product reference for the app and the [marketing site](https://wallxack.github.io/kiln/). The table lists what ships today.

| Capability | What you can do today |
| --- | --- |
| Capture | Paste or drop text, links, images and files; save the original immediately or ask an agent to analyze it. Use the tray and configurable global quick-search shortcut. |
| Source analysis | Turn captured material into prompts, insights, techniques, tools and resources, grouped in a collection and linked to their source. |
| YouTube distillation | Fetch captions and metadata with `yt-dlp`, retain the transcript, and extract reusable entries with timestamped source links. |
| Library organization | Search, filter by kind/status/provider/location/tags, favorite items, manage collections, select in bulk, archive, trash and restore. |
| Prompt editing | Keep Markdown and attachments, resolve template variables when copying, inspect revision history and diffs, and retain provenance when deriving new items. |
| Experiments | Choose a local project/repository or an isolated example, then test an exact revision through Codex or Claude Code. Or prepare a manual handoff with a project, task, rubric and variables. Keep output, limitations and pass/fail/uncertain assessments with that revision. Agent assessments and human judgements are distinct. |
| Run visibility | See live activity, model, reasoning effort, elapsed time and token usage; cancel or retry runs and inspect local evidence. Up to two managed runs can be active. |
| Item conversations | Ask an agent about an item and its attachments, including source-video context; continue a private session or explicitly export its transcript. |
| Skill authoring | Ask an agent to turn a prompt, image or note into a new SKILL.md draft using bundled writing guidance, with a link back to the source revision. |
| Custom agents | Import and manage native Codex, Claude Code and Copilot agent definitions; install approved definitions into compatible client locations. |
| Review and approval | Approve an exact revision. Publish that reviewed snapshot to your Kiln GitHub repository, with visible progress and retry for failed publishing. New edits become drafts. |
| Installation | Install approved skills and agent definitions into personal or enrolled project locations. Inspect copies, drift and receipts; remove copies, roll back supported deployments, and sync desired installs on another machine. |
| Imports and portability | Import existing installed skills or skills repositories as drafts. Export/import authored library data and attachments, including empty custom collections. Imported approvals require local review. |
| Configuration editor | Discover and edit agent instructions, settings, permissions, MCP configuration, hooks and shell profiles. Validate supported syntax, compare backups, restore versions and detect stale edits. |
| Git and GitHub | Create or open a Kiln repository, inspect changes, checkpoint, synchronize and resolve conflicts. GitHub access uses the official `gh` CLI. |
| CLI | Script collections, items, experiments, approvals, installation and library operations through structured JSON results and the same domain code as the desktop. |
| Desktop preferences | Choose theme and agent defaults, resize panels, configure quick search and startup behavior, inspect local performance logs, and, on Windows, prepare/restart into a newer installer. |

## The problems behind the workflow

### “I know I saved something useful. Where did it go?”

Prompts get buried in chats, skills end up in hidden folders, and a video bookmark loses the reason you saved it. Kiln gives related material a collection: the source, extracted ideas, prompt drafts and skills can stay together. Search, kind and status filters, tags and favorites help retrieve it later. Collections can be renamed and reordered; bulk selection makes clearing out a stale library practical. Renaming a collection also revises its items, so previously approved items need approval again.

Existing work does not need to be recreated. Import installed skills, native agent definitions or a skills repository as drafts with their supporting files. Original source files are left in place. Imports do not automatically approve or install anything.

### “Did this prompt work here, or only in someone else’s demo?”

An idea worth trying in a game project may be irrelevant to a backend service. Pick the local project for the experiment and run the exact prompt revision there. The result, limitations and agent assessment stay associated with that revision, separate from the human decision to keep it. Managed experiments request read-only access; tasks that require changes or unavailable tools cannot be presented as proven successes. A manual handoff is available for an external session.

### “Which version did I trust?”

A skill can evolve without losing the version that was reviewed. History and diffs show what changed; approvals refer to an exact immutable snapshot. Further editing produces a new draft. Installation uses approved content, including when a newer unapproved draft exists.

Kiln creates and manages a GitHub repository with a standard library layout for authored content, attachments, revisions and approvals. Approval publishes the reviewed snapshot rather than every private draft. Git controls expose changes, synchronization and conflicts; failed publishing is visible and retryable. Repository validation checks content integrity without executing skills. The [repository format](docs/REPOSITORY_FORMAT.md) documents what is portable and what remains private to a machine.

### “I changed an agent setting. How do I get back?”

Instructions, permissions, hooks, MCP settings and shell profiles are spread across client-specific files. Config files brings discovered personal files and added project files into one editor, with each file’s purpose and location. Supported syntax is validated on save. Kiln keeps 30 private backups, offers comparisons and restoration, and detects stale edits when a file changes on disk.

These files are edited in their actual locations; config editing does not automatically publish or synchronize them through the library repository. Instruction files can explicitly be copied into the library as drafts. Changing settings does not run a hook or guarantee an already-running agent session has reloaded its configuration.

### “Which projects still have the old copy?”

Installing a skill is only the start of maintaining it. Kiln shows copies in configured personal locations and enrolled projects, distinguishes managed copies from outside edits, and offers comparisons for differences. Install receipts record the revision and destination. Removal can clear an installed copy while keeping the library item and history; supported rollback operations check for intervening changes.

For another machine, open the Kiln repository there, configure its locations, review any required approvals and sync desired installs. This is local installation on each machine, not remote deployment. Skills and native agent definitions are installed only into compatible client locations, and new client sessions load the copies.

### “There was one good idea in that hour-long talk.”

Distilling a captioned YouTube video creates a collection of reusable entries with timestamped source links and the transcript attached to the source item. Ask the agent about an entry with that source context already available. Plain text, screenshots and files can also be captured for later analysis; Save only preserves the material without calling a model.

Managed runs use an existing signed-in Codex or Claude Code client and its subscription/account usage rather than asking for a separate model API key. Subscription usage limits still apply. Ordinary library editing, approval and installation do not invoke a model.

These are the factual basis for the marketing site. Its interactive skills panel, capture, test run and approval use sample states and condensed library prompts; they do not connect to the visitor’s files, call a model or claim measured outcomes.

## Product boundaries

- The library is local, but desktop onboarding requires a Kiln-created repository connected to GitHub. Approval publishes the reviewed snapshot; this is not an account-free, offline-only product.
- Managed agent runs support Codex and Claude Code. Copilot supports skills and agent-definition import/installation, not built-in experiment execution.
- Automated capture and experiments request read-only access. Item chat has broader file and command access. Agent interactions use the official clients and show a consent notice; normal editing, approval and installation do not invoke a model.
- Local run folders hold private inputs and transcripts. Normal export/publishing excludes reserved session data and machine-specific paths; authored text and arbitrary attachments are not automatically secret-redacted.
- SSH execution, remote deployment and a remote machine dashboard are not implemented. Windows installers are unsigned and the full Windows release matrix is not certified. macOS builds are ad-hoc signed and not notarized; the macOS and Linux builds have not been tested on real machines.

## Core workflow

Kiln keeps your library in a GitHub repository it manages. Three words cover every state an item can be in:

- **Draft**: what you are editing. Lives only on this machine.
- **Approved**: you reviewed an exact revision. Kiln commits it to your Kiln repository and pushes it to GitHub at once. Only approved revisions can be installed.
- **Installed**: a copy of the approved version sits in an agent's skills folder.

First launch walks through connecting GitHub and creating or opening your Kiln repository; nothing else is available until that is done. Only a repository Kiln created counts. Your own skills repositories, including one that had the Kiln layout added in place, are import sources: their skills come in as drafts to approve.

## Open the app

After installing, start Kiln from its Start Menu or Desktop shortcut on Windows, from Applications on macOS, or from the AppImage or your applications menu on Linux. If you built it yourself, run `release/0.18.2/win-unpacked/Kiln.exe` or install the setup executable from `release/0.18.2`; keep the unpacked executable beside its supporting files. On macOS and Linux, `npm run dist:mac` and `npm run dist:linux` leave `release/mac-arm64/Kiln.app` (or `mac/` for Intel) and `release/linux-unpacked/kiln-workbench` next to the packages. Closing the window keeps Kiln in the tray (the menu bar on macOS); use **Quit Kiln** there to exit, or Cmd+Q on macOS. Linux desktops without a tray (GNOME without an AppIndicator extension) show no icon: quit from **File → Quit** (press Alt to show the menu bar), and opening Kiln again brings the window back. The default quick-search shortcut is **Ctrl+Shift+Space** (**Cmd+Shift+Space** on macOS) and can be changed in Settings. Global shortcuts may not work under Wayland on Linux.

See [what changed in 0.18.2](docs/releases/0.18.2.md).

## Use a library

1. On first launch, sign in with the official `gh` CLI and create a Kiln repository on GitHub (or open one Kiln created earlier). The same screen offers **Import my installed skills** (the folders Codex and Claude Code already read on this machine) and **Import from a skills repository** (a clone or one of your GitHub repositories); everything arrives as drafts with supporting and linked files, and nothing is moved. **Settings & repository** has the same tools later, including **Connect a different repository**.
2. In **Settings → Skill & agent locations**, choose **Agents** (`~/.agents/skills`, shared by Codex, Copilot and other clients) and **Claude** (`~/.claude/skills`). Both skill and client-specific agent-definition paths are shown. **Find skills and agents not in the library** imports existing items as drafts and offers safe cleanup of broken links or empty folders. Optional `.codex/skills` and `.copilot/skills` copies are under **Client-specific locations**; Copilot project copies use `.github/skills`. An installed item shows **Installed** in its header. Click it to manage or remove individual copies in **Installs**, where Agents and Claude locations are grouped together and client-specific copies are in a disclosure. See [verified compatibility and sources](docs/SKILL_LOCATIONS.md).
3. Browse **Library** or **Skills**. The lifecycle chips (Captured, Testing, Approved) filter and count items; **Archive** holds rejected and archived items. Right-click any item for status, favourite, install and trash actions. Right-click a collection in the sidebar to delete it; the items inside move to Trash. Items in **Trash** can be restored or deleted permanently.
4. **Test** runs an experiment with Codex or Claude Code (or a manual handoff); output and the agent assessment are saved automatically against the exact revision. **Create skill** asks the chosen agent to draft a SKILL.md from a prompt, image or note using Kiln's bundled writing-for-agents guidance; the draft arrives as a new unapproved skill linked to its source.
5. Every skill shows one toggle per configured location. **Install** copies the approved version into the agent's skills folder (approving the current draft first if needed); new agent sessions see it. **Approve & install** does both for every configured location in one click. **Remove** deletes only that copy. An identical folder Kiln did not create is adopted rather than rewritten; a junction is replaced by a real copy; a differing folder is set aside under Kiln's private data only after you confirm. Project folders are enrolled in **Machines** and installed to from an item's Installs tab.
6. Installed skills are recorded in `workbench/installs.json` inside the library. On another machine, clone the library, turn on the same locations and press **Install everything marked for this machine**, or run `workbench skills sync`. Sync installs the latest locally trusted approved revision, even when a newer draft exists. It never creates an approval; missing or imported-only approvals are reported for review.
7. **Approve** commits that item (and only that item) and pushes it to GitHub in the background; the desktop uses a plain "Approve …" commit message without invoking an agent. Automatic approval publishing commits only the exact reviewed snapshot, excluding earlier private drafts and edits made while publishing. Explicit CLI Git checkpoints still commit all managed working files. If a push fails, the item says so and offers **Retry**; **Settings → Kiln repository** shows anything still waiting.

## Config files

**Config files** manages personal and project instructions, permissions, hooks, MCP settings and shell profiles. Built-in entries cover Claude settings and CLAUDE.md, Codex config.toml / hooks.json / AGENTS.md / AGENTS.override.md, Copilot CLI settings / saved permissions / MCP / instructions, and VS Code settings. `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `COPILOT_HOME` are respected for config discovery. Enrolled project folders appear automatically; **Add project folder** discovers project settings, rules, agents and hooks. **Add another file** handles other locations, editor profiles, hook scripts and organization-specific files.

Filter by agent, path or purpose. Missing files have format-appropriate starter templates. Saves validate JSON/TOML syntax (VS Code allows JSON comments), reject stale edits, preserve line endings and BOM, and retain 30 private backups with diff and restore. These are syntax checks, not proof that an installed client supports a setting. Settings and hooks stay outside the publishable library; only Markdown instructions have **Copy to library**. Editing never executes hooks. Restart the relevant client/session after changing its configuration. CLI flags, trust requirements and organization policies can override files; Kiln does not calculate effective permissions.

Copilot skill installation and import are supported; built-in Kiln agent runs still use Codex or Claude. Shared skills may already be visible to Copilot, but each client's discovery paths and features differ. References: [Claude settings](https://code.claude.com/docs/en/settings), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Copilot CLI configuration](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference), [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference), [VS Code skills](https://code.visualstudio.com/docs/agent-customization/agent-skills).

## Standard repositories

Every new or migrated Kiln library uses the same [versioned layout](docs/REPOSITORY_FORMAT.md). App infrastructure lives in `.kiln/` and a pinned GitHub Actions workflow validates data without executing skills. Infrastructure upgrades show a file preview and refuse to overwrite locally modified infrastructure.

## Build from source

```sh
git clone https://github.com/waLLxAck/kiln.git
cd kiln
npm ci
npm run build
```

### Monorepo and development

One npm workspace repository contains the product and its marketing site, with one root lockfile:

| Workspace | Location | Responsibility |
| --- | --- | --- |
| `@kiln/desktop` | `apps/desktop/` | Electron shell and React desktop UI |
| `@kiln/cli` | `apps/cli/` | Command-line interface |
| `@kiln/marketing` | `apps/marketing/` | Independently built marketing website |
| `@kiln/core` | `packages/` | Shared domain, protocol, storage, agents, Git, deployment and configuration modules |

Root scripts coordinate builds and retain the existing desktop packaging paths. Shared TypeScript source is bundled into the desktop and CLI; the marketing site has its own Vite configuration and output directory. Site changes do not require starting Electron.

```sh
npm ci
npm run dev                 # Desktop + renderer
npm run dev:marketing       # Marketing site at http://127.0.0.1:5174
npm run build               # Desktop + CLI
npm run build:marketing     # Static website in dist/marketing
npm run build:all           # Product + website
npm run preview:marketing   # Serve the built website
```

The marketing homepage is a founder’s printout reviewed in red pen: skill folders tidy themselves into a Kiln skills panel, then a captured video prompt is tested, fixed, rerun and approved onto the same panel. It uses real HTML text and controls, with keyboard and tap fallbacks for every drag and calm end states for reduced motion. `node scripts/verify-marketing.mjs` checks it and the support page in Chromium. See [the marketing site](apps/marketing/README.md).

The site is published at [wallxack.github.io/kiln](https://wallxack.github.io/kiln/) by the [Pages workflow](.github/workflows/pages.yml) on every push to `main`. It installs only the marketing workspace and builds with `BASE_PATH=/kiln/`; set the same variable locally to check a build served under that path.

Requirements: Windows, macOS or Linux, Node.js 24 LTS (22.16 or newer), npm, Git. GitHub features additionally require GitHub CLI. Official Codex/Claude clients are optional for manual handoffs; Kiln does not store their authentication or request a model API key.

```powershell
npm ci
npm run dev
npm run check
npm test
npm run test:desktop
npm run package
npm run dist:win     # on Windows: release/Kiln Setup <version>.exe
npm run dist:mac     # on macOS: arm64 and x64 .dmg and .zip
npm run dist:linux   # on Linux: .AppImage and .deb
```

Each installer builds on its own platform; `.github/workflows/release.yml` builds all three on GitHub's runners.

`npm run test:desktop` runs isolated Electron tests. The real-install test is skipped by default and must be explicitly enabled; it should only be run against an authorized machine. Build outputs and local verification evidence are ignored by Git.

The CLI uses the same domain code, IDs, approval checks, deployment receipts, and mutation lock:

```powershell
npm run cli -- --help
npm run cli -- collections list
npm run cli -- items list --collection "Game Design Practice"
npm run cli -- items list --collection "Game Design Practice" --query puzzles
npm run cli -- items read <id1> <id2> --full
npm run cli -- --library "C:\path\to\library" github status
npm run cli -- --library "C:\path\to\library" deploy installations
npm run cli -- --library "C:\path\to\library" skills sync
npm run cli -- --library "C:\path\to\library" library export --file "C:\backups\kiln.json"
```

Start with the named collection; read content only for the items you need. Collection names match exactly, including case. Lists return IDs, titles and kinds; `items list --full` restores the detailed metadata returned before 0.16.0. Lists include archived/rejected items and exclude trash. `--status` narrows them further. Collection summaries include empty collections with count zero.

Lists return `total` and `nextOffset`; pass `--offset <nextOffset>` for another page. `--limit` defaults to 50 (maximum 500). `items read` accepts 1–100 IDs in one call. Single reads retain their existing object shape; multiple IDs return `{ items: [...] }` in requested order. Add `--full` to read content and attached files. `--revision` works with one ID only. A failed batch returns an error without partial content.

After building, `npm link` makes both `kiln` and `workbench` available through npm's bin directory. Other typed operations accept `--input request.json`. Results include `schemaVersion`, `ok`, and `data`; errors use structured stderr and a nonzero exit status. Unknown, misplaced, repeated and valueless options fail before storage is opened. `--library` and `--local` can isolate storage. `KILN_LIBRARY` and `KILN_LOCAL` override defaults; `KILN_DESKTOP_DATA` isolates desktop preferences for tests.

## Release scope

This is the local workflow release, with GitHub onboarding and standardized migration. Managed Codex capture and experiment runs are supported. SSH execution remains unimplemented. External client hooks can be edited in Config files; Kiln does not execute them itself. The full Windows release matrix has not been certified. Windows builds are unsigned. The macOS and Linux builds are new in 0.18.1 and untested on real machines; the Mac build is ad-hoc signed and not notarized.

See [implementation and verification](docs/IMPLEMENTATION.md), [architecture](docs/ARCHITECTURE.md), and [third-party notices](THIRD_PARTY.md).

## Performance diagnostics

Drag the dividers beside the navigation sidebar and skill list to resize them. Widths are saved on this machine. Focus a divider and use arrow keys (20 px), Home, or End for keyboard resizing.

Settings → Open performance logs opens the local `logs` folder under Electron's user-data directory (normally `%APPDATA%/kiln-workbench/logs` on Windows, `~/Library/Application Support/kiln-workbench/logs` on macOS and `~/.config/kiln-workbench/logs` on Linux). Isolated profiles use their own logs folder. `performance.jsonl` records request start/end/error codes, background queue and execution timings, requests still pending after two seconds, renderer tasks over 100 ms, event-loop delays over 500 ms, unresponsive/recovered windows, renderer exits, and CPU/memory samples every 15 seconds. One previous 5 MB log is retained as `performance.jsonl.1`. Nothing is uploaded. Request arguments, skill bodies, and credentials are excluded.

After a freeze, inspect the timestamps and match `requestId` or backend `id` across records. `backend.slow` is recorded by the main process while the worker is still busy. `queueMs` distinguishes waiting from execution. A renderer stall is recorded on recovery; Electron's unresponsive event can report a window that has not recovered. Main-loop stalls are recorded after recovery. A forced process kill or machine shutdown can prevent the final events from reaching disk. Logs diagnose symptoms; they do not guarantee a record of every OS-level hang.

Library, Git, import and search work run in a background worker with ordered mutations. Read-only GitHub/provider checks run independently of that queue. Unchanged snapshots skip skill reconciliation and index rebuilding; filesystem changes invalidate that cache.

Verification: `npm test`, `npm run build`, and `npx playwright test tests/desktop/performance.spec.ts tests/desktop/workbench.spec.ts`. The performance fixture creates and imports 217 temporary skills, checks main-loop responsiveness and saved panel widths, and deliberately blocks the renderer to verify diagnostics.

## Distilling a YouTube video

Paste a bare YouTube link into Add to library and the button becomes **Distill video**. Kiln fetches the captions and metadata with `yt-dlp` the same way the shell `yt` helper does (auto-captions, English first, `~/cookies.txt` when present; nothing else is downloaded), keeps the cleaned transcript as `transcript.md` on the link item, and asks the chosen agent for library entries: ready-to-paste prompts, tools with what they do and their official URL, techniques as numbered steps, resources, and only the insights that change what you would do. Each entry becomes its own item in a collection named from the video title (Unicode and whitespace normalized, limited to 80 characters; a video ID suffix distinguishes collisions), linked back to the video with a timestamped URL and a one-line description shown under its title. Prompts are stored bare so Copy yields only the prompt. The video item shows the summary, takeaway, entry counts and an **Open** button for the collection. `yt-dlp` must be on PATH.

### Asking the agent about a video

Distillation keeps a private copy of the CLI transcript in its run folder. It is never attached to the library item, included in a normal library export, or newly published to GitHub. The public video captions remain attached as `transcript.md`.

**Ask the agent** starts a chat with the selected item, its attachments, and the source video's captions and entry list when applicable. Follow-up messages continue that chat. Switching items starts a separate session, including switching back to an earlier item; **New session** starts over on the same item. Session folders are isolated so simultaneous chats cannot replace one another's context.

Kiln runs your installed, signed-in Codex or Claude Code CLI. Before each agent interaction, a warning explains what is sent, account usage, and access to files and commands. **Agree and continue** starts the operation; **Cancel** sends nothing. **Don't show again** remembers acceptance on this machine. **Settings → Show agent access warnings again** restores the warning. Chat retains broad read/write access: Windows Codex chat runs without a sandbox, and Claude chat allows Bash, Write and Edit. The instruction to edit library entries through Kiln's CLI is not a security boundary. Capture, distillation and trials request read-only access. Ordinary desktop actions such as Install, Save, Approve and Retry are programmatic and do not invoke an agent or show this warning.

**Export conversation…** separately saves a private transcript after an explicit warning about messages, local paths and tool output. Review that file before sharing it. Normal exports remove reserved session attachments and machine-specific source paths, redact private trial inputs and activity details, and exclude approvals whose revision bytes had to be transformed. Kiln does not redact secrets deliberately included in authored prose or arbitrary attachments.

When an older library opens, legacy session-bearing revisions are archived in machine-private storage and the current item becomes a cleaned, unapproved draft. Local History can still read the original. Existing remote Git history is not rewritten; material published by an older release remains in that history.

## Updating the installed app

If you installed Kiln from GitHub, update by downloading and running the newer installer from the [releases page](https://github.com/waLLxAck/kiln/releases). The in-app flow below is for Windows builds made from a local checkout.

On macOS and Linux, Kiln doesn't update itself: Settings → Updates links to the releases page. Replace `Kiln.app` in Applications with the new one, replace the AppImage file, or `sudo apt install` the new .deb.

Every build records where it was made. Kiln watches that repository's `release` folder (top level or one folder down) for a newer `Kiln Setup <version>.exe`. Checks run on startup and window focus. **Prepare update** copies the installer into Kiln's private update cache and verifies it while the app stays open. A progress indicator becomes **Restart to update** when ready. Preparation never launches the installer; closing Kiln normally does not install it, and the ready state survives reopening even if the original release folder disappears.

Only **Restart to update** verifies the cached installer again, starts it silently for the current user, and quits Kiln so Windows can replace the running files. The installer then relaunches Kiln. Save your work before restarting. If verification or starting the installer fails, Kiln stays open and offers a retry. Settings → Updates can choose a different source folder or stop checking. Build a newer installer with `npm run dist:win` after increasing `version` in `package.json`. When building from a worktree, set `KILN_SOURCE_ROOT` to the main checkout. Published installers are built with `KILN_PUBLIC_BUILD=1`, which records no source folder, so they don't watch for local builds. Pushing a version tag such as `v0.18.2` runs `.github/workflows/release.yml`, which builds Windows, Linux and macOS on their own runners, starts each packaged app once, and publishes all the files with one `SHA256SUMS.txt` and the notes from `docs/releases/`. Running that workflow by hand is a dry run: it builds everything and uploads the files as workflow artifacts without publishing. Updates started from an older Kiln release still follow that release's update flow; the two-step flow starts after installing 0.8.1.

## Quick capture and agent runs

Use the import area or Ctrl+N, paste/drop content or select files, then choose **Analyze and add**. **Save only** keeps the original text and attachments immediately without calling an agent or fetching captions. **Analyze and add** uses the same analysis as a YouTube video. Kiln preserves your original source and asks your default agent to create reusable prompts, insights, techniques, tools and resources in a collection, linked back to that source. Unreadable sources and unsupported files are reported instead of guessed. Mixed files stay together on the source item. Failed starts can be retried without creating another copy. Existing captures are not automatically reprocessed.

Codex runs need the native Codex CLI on PATH with `codex login status` reporting ChatGPT. Apps opened from the macOS Dock or a Linux launcher get a minimal PATH, so packaged Kiln on those platforms takes PATH from your login shell (nvm, mise, Homebrew and similar setups) and also looks in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin` and `~/.claude/local`. Claude Code runs use `claude -p --output-format stream-json --json-schema` with Read/Glob/Grep and read-only WebFetch/WebSearch tools, none of your settings, hooks or MCP servers, and the client's own sign-in; if a headless run reports an expired session, run `claude` once in a terminal. Kiln uses `codex exec --json --output-schema` with a read-only sandbox. Capture runs use an isolated working folder; experiments can use a selected local project as their working directory. Runs use existing CLI authentication with unrelated user tool configuration excluded. No API key is requested. Capture sends the selected input to the chosen agent; diagnostic logs themselves are local. See [official non-interactive CLI documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [authentication](https://learn.chatgpt.com/docs/auth).

**Test** opens a provider selector, a **Project / repository** selector and an optional context box. Choose an enrolled project, use **Choose project folder…** for any local repository or directory, or keep **No project — isolated example**. Enrollment is not required to test a folder. The selected directory becomes the actual working directory for Codex or Claude Code; experiments remain read-only, so tasks requiring edits or unavailable tools are reported as uncertain. The last managed experiment’s project is offered again for that item. **Manual handoff instead** keeps your selection and tells you where to start the external session.

The agent saves its actual output and a pass/fail/uncertain assessment. Selected paths and task context stay in machine-private job/run files and the project is shown in the run metadata. Retrying a failed, cancelled or interrupted run preserves its project, context, provider and exact revision, even if you have since edited the item. Missing or unreadable folders are rejected before a run begins. Agent assessments are labelled separately from human judgements. Missing context and unavailable tools must be reported; synthetic tests are not evidence of running against a real codebase. A run never approves or installs the item.

Settings → Official agents chooses the Codex model and reasoning effort from the installed CLI's own catalog; leaving either blank uses the catalog default, and the resolved values are shown on every run. While a run is active the item shows a live activity list (messages, reasoning summaries, commands, web searches) with the thread id and, on completion, the input/cached/output token counts. Up to two runs can be active. Cancel/retry controls and **Run files** expose progress and evidence. Local `agent-jobs` folders retain the structured response and bounded CLI event stream. App exit stops managed subprocesses; interrupted jobs can be retried. Experiments also retain their trial records and output files.

Performance fixes in 0.2: theme applies immediately and saves outside the work queue; selected-item installation checks inspect one skill; duplicate read requests are shared; unchanged item metadata and Git status are reused; copied observations do not rebuild the index. GitHub checks are explicit, and import previews distinguish pending changes from already imported skills.

Setup checks the signed-in GitHub CLI account for `my-kiln` and offers **Use this repository** or **Use something else**. Existing local copies are reused only when their GitHub origin matches and they are Kiln libraries. Connection failures offer a retry; unrelated repositories are never attached.

Agents are Library items alongside skills. In **Settings → Skill & agent locations**, use **Find skills and agents not in the library**. The existing scanner detects both kinds and imports them as drafts. Native YAML and TOML content is retained; only the matching client is offered for installation. Approved definitions use personal or project agent directories, with the same backup and drift checks as skills. General instructions, permissions, hooks, and settings remain under Config files.

Agent formats: [Claude subagents](https://code.claude.com/docs/en/sub-agents), [Copilot custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration), and [Codex standalone agents](https://learn.chatgpt.com/docs/agent-configuration/subagents). Older Codex role files without name and description can be imported as drafts and repaired before installation.

## Library tabs, chat and collections

The **All** tab lists everything newest first; the other tabs are one per kind and appear only when something of that kind exists. Entries distilled from a video are filed under their own kinds, **Insights**, **Techniques**, **Tools** and **Resources**, next to Prompts; a tool or resource with a known URL leads with it, so Open goes there. Libraries distilled before this release are re-filed the first time they open.

**Ask the agent** (the speech-bubble button beside Capture) opens a conversation about the item you have open. For a video, or an entry distilled from one, the agent also gets the transcript and every entry from that video, in a fresh item-specific session; for any other item it gets the item and its attached files. Switching items starts a new session; the agent is instructed to make edits through Kiln's CLI as revisions, and the button is disabled when nothing is open. Paste or drop anything onto the window to capture it; the capture dialog also takes files.

**Collections** are renamed, reordered, added and deleted from the sidebar's right-click menu or **Manage collections**. Renaming moves every item in the collection, trashed ones included; because the collection is part of each revision, approved items return to Captured and need approving again. Imported collections can be renamed freely; nothing ties them to their source repository.

Editing an item does not need a note: leave **What changed?** empty to use a plain revision note. Desktop saves do not invoke the model.

## Bulk Library management

Pick several rows the way a file manager does: **Ctrl-click** toggles a row, **Shift-click** extends from the focused row, and **Ctrl+A** picks every filtered result, including rows below the scroll. The count appears next to the search box; Esc or its × clears it. Changing filters, tabs or sections clears the selection too.

Right-click a picked row for the same menu a single item has, applied to all of them: favourites, status, **Remove local copies…**, and trash, restore or permanent deletion. Single-key shortcuts in the menu work on the selection while the list has focus. With two or more rows picked, the detail pane shows a summary instead of one item.

The filter row holds Status and Installed; collections are chosen in the sidebar. **+ Filter** adds Provider, Location, Copy state, Scope and Tag as further pills; each pill's menu counts what choosing a value would show, and its × removes the pill. Provider means native definitions or client-specific copies; shared `.agents/skills` copies use the Agents location. Location, state and scope criteria must match the same copy.

**Remove local copies** previews all detected skill/agent copies of the picked items across configured roots, including client-specific folders and recorded installations under previous names. The filter selects items; the review covers all their locations. Library items, approvals and history remain. Matching managed copies are deleted; other copies move to private backups; links are unlinked without following their targets. Changed or unreadable paths are skipped with an explicit result. Successful removals clear the corresponding desired installs so sync does not recreate them. Completed removal plans are repeatable without touching newly created copies. This is not a full-disk search.

## Contributing

Issues and pull requests are welcome. [Open an issue](https://github.com/waLLxAck/kiln/issues) for bugs, questions or ideas; for a bug, include the steps, what you expected and what happened. For a pull request, keep the change focused and run `npm run check` and `npm test` first (and `npm run test:desktop` for desktop UI changes). Describe user-facing changes in this README, which is the product reference.

## Support

Kiln is free and built by one developer. If it saves you time, you can [support it on Ko-fi](https://ko-fi.com/wallxack); that pays for the time to keep building it. Starring the repository, reporting issues and telling people about it help too. See the [support page](https://wallxack.github.io/kiln/support/).

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY.md](THIRD_PARTY.md).
