# Kiln user guide

This guide covers everything the [README](../README.md) summarises. Together they are the product reference for the app and the [marketing site](https://wallxack.github.io/kiln/). For building, testing and releasing Kiln, see [DEVELOPMENT.md](DEVELOPMENT.md).

- [What Kiln offers](#what-kiln-offers)
- [Installing](#installing)
- [Core workflow](#core-workflow)
- [Open the app](#open-the-app)
- [Set up a library](#set-up-a-library)
- [Capture](#capture)
- [Distilling a YouTube video](#distilling-a-youtube-video)
- [Experiments](#experiments)
- [Agent runs](#agent-runs)
- [Asking the agent](#asking-the-agent)
- [Library tabs and collections](#library-tabs-and-collections)
- [Bulk Library management](#bulk-library-management)
- [Custom agents](#custom-agents)
- [Config files](#config-files)
- [Standard repositories](#standard-repositories)
- [Command-line interface](#command-line-interface)
- [Updating the installed app](#updating-the-installed-app)
- [Panels and performance logs](#panels-and-performance-logs)
- [The problems behind the workflow](#the-problems-behind-the-workflow)
- [Product boundaries](#product-boundaries)
- [Notes for older libraries and releases](#notes-for-older-libraries-and-releases)

## What Kiln offers

What ships today:

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

## Installing

Downloads are listed in the README's [Download](../README.md#download) section and on the [releases page](https://github.com/waLLxAck/kiln/releases), with earlier versions, release notes and `SHA256SUMS.txt`.

"Untested" means the macOS builds are built, inspected and started once on GitHub's CI runners, but nobody has used them on a real Mac yet. The Linux build has been tried on one Arch Linux desktop (Hyprland on Wayland) as well. Please [report what breaks](https://github.com/waLLxAck/kiln/issues). If you would rather not run an unsigned build, [build Kiln from source](DEVELOPMENT.md).

**Windows.** The installer is unsigned, so Windows SmartScreen may warn you before it runs: choose **More info**, then **Run anyway**. It installs per user and lets you choose the installation folder.

**macOS.** Open the disk image and drag Kiln to Applications. The app is ad-hoc signed (so it runs on Apple silicon) but not notarized by Apple, so Gatekeeper blocks the first launch. Right-click Kiln in Applications and choose **Open**; on macOS 15 and later, try to open it once, then choose **Open Anyway** in System Settings → Privacy & Security. Alternatively, clear the quarantine flag in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Kiln.app
```

**Linux.** There are three files. The AppImage is one executable file:

```sh
chmod +x Kiln-0.19.1-x86_64.AppImage
./Kiln-0.19.1-x86_64.AppImage
```

AppImages need FUSE 2. If it fails with `dlopen(): error loading libfuse.so.2`, install it (`sudo pacman -S fuse2` on Arch, `sudo apt install libfuse2` on Debian and older Ubuntu, `sudo apt install libfuse2t64` on Ubuntu 24.04 and later), or run it without FUSE:

```sh
./Kiln-0.19.1-x86_64.AppImage --appimage-extract-and-run
```

The tar.gz is the same app as a plain folder and needs no FUSE. Unpack it anywhere and run `kiln-workbench` inside:

```sh
tar -xzf Kiln-0.19.1-x64.tar.gz
./Kiln-0.19.1-x64/kiln-workbench
```

The Debian/Ubuntu package adds Kiln to the applications menu (the package is named `kiln-workbench`; remove it with `sudo apt remove kiln-workbench`):

```sh
sudo apt install ./kiln_0.19.1_amd64.deb
```

Ubuntu 23.10 and later restrict the unprivileged user namespaces that Chromium's sandbox uses. When they are unavailable, the AppImage's launcher starts Kiln with `--no-sandbox`, so the renderer runs without Chromium's sandbox. If Kiln still exits with a sandbox error (the AppImage or the tar.gz), start it with `--no-sandbox`, for example `./Kiln-0.19.1-x86_64.AppImage --no-sandbox`. The .deb installs an AppArmor profile meant to keep the sandbox on. Kiln itself never turns the sandbox off.

**Requirements.** Git and the [GitHub CLI](https://cli.github.com/) (`gh`), signed in: first launch creates or opens your Kiln repository on GitHub. Managed runs need the official Codex or Claude Code CLI, and video distillation needs [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on PATH.

## Core workflow

Kiln keeps your library in a GitHub repository it manages. Three words cover every state an item can be in:

- **Draft**: what you are editing. Lives only on this machine.
- **Approved**: you reviewed an exact revision. Kiln commits it to your Kiln repository and pushes it to GitHub at once. Only approved revisions can be installed.
- **Installed**: a copy of the approved version sits in an agent's skills folder.

First launch walks through connecting GitHub and creating or opening your Kiln repository; nothing else is available until that is done. Only a repository Kiln created counts. Your own skills repositories, including one that had the Kiln layout added in place, are import sources: their skills come in as drafts to approve.

Setup checks the signed-in GitHub CLI account for `my-kiln` and offers **Use this repository** or **Use something else**. Existing local copies are reused only when their GitHub origin matches and they are Kiln libraries. Connection failures offer a retry; unrelated repositories are never attached.

## Open the app

After installing, start Kiln from its Start Menu or Desktop shortcut on Windows, from Applications on macOS, or from the AppImage, the unpacked tar.gz or your applications menu on Linux. (For builds you made yourself, see [DEVELOPMENT.md](DEVELOPMENT.md#run-a-local-build).)

Closing the window keeps Kiln in the tray (the menu bar on macOS); use **Quit Kiln** there to exit, or Cmd+Q on macOS. Linux desktops without a tray (GNOME without an AppIndicator extension) show no icon: quit from **File → Quit** (press Alt to show the menu bar), and opening Kiln again brings the window back.

The default quick-search shortcut is **Ctrl+Shift+Space** (**Cmd+Shift+Space** on macOS) and can be changed in Settings. Global shortcuts may not work under Wayland on Linux.

See [what changed in 0.19.1](releases/0.19.1.md).

## Set up a library

1. On first launch, sign in with the official `gh` CLI and create a Kiln repository on GitHub (or open one Kiln created earlier). The same screen offers **Import my installed skills** (the folders Codex and Claude Code already read on this machine) and **Import from a skills repository** (a clone or one of your GitHub repositories); everything arrives as drafts with supporting and linked files, and nothing is moved. Folders that only hold other skills (such as `~/.codex/skills/.system`) are not listed on their own; empty or broken folders are. If the skills came from a personal folder Kiln does not manage yet, setup offers **Manage the … folders** so the copies already there show as found instead of "Not installed"; managing a folder only records it, and installs or changes nothing. Two different skills with the same name stay separate items, and the list and the item header show which folder each came from (the full folder is kept on this machine only; the library stores just the folder name). **Settings & repository** has the same tools later, including **Connect a different repository**.
2. In **Settings → Skill & agent locations**, choose **Agents** (`~/.agents/skills`, shared by Codex, Copilot and other clients) and **Claude** (`~/.claude/skills`). Both skill and client-specific agent-definition paths are shown. **Find skills and agents not in the library** imports existing items as drafts and offers safe cleanup of broken links or empty folders. Optional `.codex/skills` and `.copilot/skills` copies are under **Client-specific locations**; Copilot project copies use `.github/skills`. An installed item shows **Installed** in its header. Click it to manage or remove individual copies in **Installs**, where Agents and Claude locations are grouped together and client-specific copies are in a disclosure. See [verified compatibility and sources](SKILL_LOCATIONS.md).
3. Browse **Library** or **Skills**. The lifecycle chips (Captured, Testing, Approved) filter and count items; **Archive** holds rejected and archived items. Right-click any item for status, favourite, install and trash actions. Right-click a collection in the sidebar to delete it; the items inside move to Trash. Items in **Trash** can be restored or deleted permanently.
4. **Test** runs an experiment with Codex or Claude Code (or a manual handoff); output and the agent assessment are saved automatically against the exact revision. **Create skill** asks the chosen agent to draft a SKILL.md from a prompt, image or note using Kiln's bundled writing-for-agents guidance; the draft arrives as a new unapproved skill linked to its source.
5. Every skill shows one toggle per configured location. **Install** copies the approved version into the agent's skills folder (approving the current draft first if needed); new agent sessions see it. **Approve & install** does both for every configured location in one click. **Remove** deletes only that copy. An identical folder Kiln did not create is adopted rather than rewritten; a junction is replaced by a real copy; a differing folder is set aside under Kiln's private data only after you confirm. Project folders are enrolled in **Machines** and installed to from an item's Installs tab. Machines is not reliable yet, so release builds show it as **Coming soon** (see [Machines](#machines)); builds from source still have it.
6. Installed skills are recorded in `workbench/installs.json` inside the library. On another machine, clone the library, turn on the same locations and press **Install everything marked for this machine**, or run `workbench skills sync`. Sync installs the latest locally trusted approved revision, even when a newer draft exists. It never creates an approval; missing or imported-only approvals are reported for review.
7. **Approve** commits that item (and only that item) and pushes it to GitHub in the background; the desktop uses a plain "Approve …" commit message without invoking an agent. Automatic approval publishing commits only the exact reviewed snapshot, excluding earlier private drafts and edits made while publishing. Explicit CLI Git checkpoints still commit all managed working files. If a push fails, the item says so and offers **Retry**; **Settings → Kiln repository** shows anything still waiting.

Editing an item does not need a note: leave **What changed?** empty to use a plain revision note. Desktop saves do not invoke the model.

## Capture

Use the import area or Ctrl+N, paste/drop content or select files, then choose **Analyze and add**. You can also paste or drop anything onto the window to capture it; the capture dialog also takes files.

- **Save only** keeps the original text and attachments immediately without calling an agent or fetching captions.
- **Analyze and add** uses the same analysis as a YouTube video. Kiln preserves your original source and asks your default agent to create reusable prompts, insights, techniques, tools and resources in a collection, linked back to that source.

Unreadable sources and unsupported files are reported instead of guessed. Mixed files stay together on the source item. Failed starts can be retried without creating another copy. Existing captures are not automatically reprocessed.

## Distilling a YouTube video

Paste a bare YouTube link into Add to library and the button becomes **Distill video**. Kiln fetches the captions and metadata with `yt-dlp` the same way the shell `yt` helper does (auto-captions, English first, `~/cookies.txt` when present; nothing else is downloaded), keeps the cleaned transcript as `transcript.md` on the link item, and asks the chosen agent for library entries: ready-to-paste prompts, tools with what they do and their official URL, techniques as numbered steps, resources, and only the insights that change what you would do.

Each entry becomes its own item in a collection named from the video title (Unicode and whitespace normalized, limited to 80 characters; a video ID suffix distinguishes collisions), linked back to the video with a timestamped URL and a one-line description shown under its title. Prompts are stored bare so Copy yields only the prompt. The video item shows the summary, takeaway, entry counts and an **Open** button for the collection. `yt-dlp` must be on PATH.

Distillation keeps a private copy of the CLI transcript in its run folder. It is never attached to the library item, included in a normal library export, or newly published to GitHub. The public video captions remain attached as `transcript.md`.

## Experiments

**Test** opens a provider selector, a **Project / repository** selector and an optional context box. Choose an enrolled project, use **Choose project folder…** for any local repository or directory, or keep **No project — isolated example**. Enrollment is not required to test a folder. The selected directory becomes the actual working directory for Codex or Claude Code; experiments remain read-only, so tasks requiring edits or unavailable tools are reported as uncertain. The last managed experiment’s project is offered again for that item. **Manual handoff instead** keeps your selection and tells you where to start the external session.

The agent saves its actual output and a pass/fail/uncertain assessment. Selected paths and task context stay in machine-private job/run files and the project is shown in the run metadata. Retrying a failed, cancelled or interrupted run preserves its project, context, provider and exact revision, even if you have since edited the item. Missing or unreadable folders are rejected before a run begins. Agent assessments are labelled separately from human judgements. Missing context and unavailable tools must be reported; synthetic tests are not evidence of running against a real codebase. A run never approves or installs the item.

## Agent runs

Kiln runs your installed, signed-in Codex or Claude Code CLI. It uses existing CLI authentication, with unrelated user tool configuration excluded; no API key is requested. Subscription usage limits still apply. Ordinary library editing, approval and installation do not invoke a model.

- **Codex** runs need the native Codex CLI on PATH with `codex login status` reporting ChatGPT. Kiln uses `codex exec --json --output-schema` with a read-only sandbox.
- **Claude Code** runs use `claude -p --output-format stream-json --json-schema` with Read/Glob/Grep and read-only WebFetch/WebSearch tools, none of your settings, hooks or MCP servers, and the client's own sign-in. If a headless run reports an expired session, run `claude` once in a terminal.
- **PATH on macOS and Linux.** Apps opened from the macOS Dock or a Linux launcher get a minimal PATH, so packaged Kiln on those platforms takes PATH from your login shell (nvm, mise, Homebrew and similar setups) and also looks in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin` and `~/.claude/local`.

Capture runs use an isolated working folder; experiments can use a selected local project as their working directory. Capture sends the selected input to the chosen agent; diagnostic logs themselves are local. See the [official non-interactive CLI documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [authentication](https://learn.chatgpt.com/docs/auth).

**Settings → Official agents** chooses the Codex model and reasoning effort from the installed CLI's own catalog; leaving either blank uses the catalog default, and the resolved values are shown on every run. While a run is active the item shows a live activity list (messages, reasoning summaries, commands, web searches) with the thread id and, on completion, the input/cached/output token counts. Up to two runs can be active. Cancel/retry controls and **Run files** expose progress and evidence. Local `agent-jobs` folders retain the structured response and bounded CLI event stream. App exit stops managed subprocesses; interrupted jobs can be retried. Experiments also retain their trial records and output files.

### Agent access warning

Before each agent interaction, a warning explains what is sent, account usage, and access to files and commands. **Agree and continue** starts the operation; **Cancel** sends nothing. **Don't show again** remembers acceptance on this machine. **Settings → Show agent access warnings again** restores the warning.

Capture, distillation and trials request read-only access. Chat retains broad read/write access and can run commands. On macOS and Linux, Codex chat runs in Codex's workspace-write sandbox: it can read what your account can read, but writes only to the library, the chat's working folder and temporary folders. On Windows, where Codex has no such sandbox, Codex chat runs without one. Claude chat allows Bash, Write and Edit and is not confined on any platform; the warning names only the caveats of the platform it is shown on. The instruction to edit library entries through Kiln's CLI is not a security boundary. Ordinary desktop actions such as Install, Save, Approve and Retry are programmatic and do not invoke an agent or show this warning.

## Asking the agent

**Ask the agent** (the speech-bubble button beside Capture) starts a chat with the item you have open and its attachments. For a video, or an entry distilled from one, the agent also gets the video's captions and every entry from that video. The button is disabled when nothing is open, and the agent is instructed to make edits through Kiln's CLI as revisions.

Follow-up messages continue that chat. Switching items starts a separate session, including switching back to an earlier item; **New session** starts over on the same item. Session folders are isolated so simultaneous chats cannot replace one another's context.

**Export conversation…** separately saves a private transcript after an explicit warning about messages, local paths and tool output. Review that file before sharing it. Normal exports remove reserved session attachments and machine-specific source paths, redact private trial inputs and activity details, and exclude approvals whose revision bytes had to be transformed. Kiln does not redact secrets deliberately included in authored prose or arbitrary attachments.

## Library tabs and collections

The **All** tab lists everything newest first; the other tabs are one per kind and appear only when something of that kind exists. Entries distilled from a video are filed under their own kinds, **Insights**, **Techniques**, **Tools** and **Resources**, next to Prompts; a tool or resource with a known URL leads with it, so Open goes there.

**Collections** are renamed, reordered, added and deleted from the sidebar's right-click menu or **Manage collections**. Renaming moves every item in the collection, trashed ones included; because the collection is part of each revision, approved items return to Captured and need approving again. Imported collections can be renamed freely; nothing ties them to their source repository.

## Bulk Library management

Pick several rows the way a file manager does: **Ctrl-click** toggles a row, **Shift-click** extends from the focused row, and **Ctrl+A** picks every filtered result, including rows below the scroll. The count appears next to the search box; Esc or its × clears it. Changing filters, tabs or sections clears the selection too.

Right-click a picked row for the same menu a single item has, applied to all of them: favourites, status, **Remove local copies…**, and trash, restore or permanent deletion. Single-key shortcuts in the menu work on the selection while the list has focus. With two or more rows picked, the detail pane shows a summary instead of one item.

The filter row holds Status and Installed; collections are chosen in the sidebar. **+ Filter** adds Provider, Location, Copy state, Scope and Tag as further pills; each pill's menu counts what choosing a value would show, and its × removes the pill. Provider means native definitions or client-specific copies; shared `.agents/skills` copies use the Agents location. Location, state and scope criteria must match the same copy.

**Remove local copies** previews all detected skill/agent copies of the picked items across configured roots, including client-specific folders and recorded installations under previous names. The filter selects items; the review covers all their locations. Library items, approvals and history remain. Matching managed copies are deleted; other copies move to private backups; links are unlinked without following their targets. Changed or unreadable paths are skipped with an explicit result. Successful removals clear the corresponding desired installs so sync does not recreate them. Completed removal plans are repeatable without touching newly created copies. This is not a full-disk search.

## Custom agents

Agents are Library items alongside skills. In **Settings → Skill & agent locations**, use **Find skills and agents not in the library**. The existing scanner detects both kinds and imports them as drafts. Native YAML and TOML content is retained; only the matching client is offered for installation. Approved definitions use personal or project agent directories, with the same backup and drift checks as skills. General instructions, permissions, hooks, and settings remain under Config files.

Agent formats: [Claude subagents](https://code.claude.com/docs/en/sub-agents), [Copilot custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration), and [Codex standalone agents](https://learn.chatgpt.com/docs/agent-configuration/subagents). Older Codex role files without name and description can be imported as drafts and repaired before installation.

## Config files

**Config files** manages personal and project instructions, permissions, hooks, MCP settings and shell profiles. Built-in entries cover Claude settings and CLAUDE.md, Codex config.toml / hooks.json / AGENTS.md / AGENTS.override.md, Copilot CLI settings / saved permissions / MCP / instructions, and VS Code settings. `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `COPILOT_HOME` are respected for config discovery. Enrolled project folders appear automatically; **Add project folder** discovers project settings, rules, agents and hooks. **Add another file** handles other locations, editor profiles, hook scripts and organization-specific files.

Filter by agent, path or purpose. Missing files have format-appropriate starter templates. Saves validate JSON/TOML syntax (VS Code allows JSON comments), reject stale edits when a file changed on disk, preserve line endings and BOM, and retain 30 private backups with diff and restore. These are syntax checks, not proof that an installed client supports a setting.

Files are edited in their actual locations; config editing does not automatically publish or synchronize them through the library repository. Settings and hooks stay outside the publishable library; only Markdown instructions have **Copy to library**, which copies them in as drafts. Editing never executes hooks. Restart the relevant client/session after changing its configuration; changing settings does not guarantee an already-running agent session has reloaded it. CLI flags, trust requirements and organization policies can override files; Kiln does not calculate effective permissions.

Copilot skill installation and import are supported; built-in Kiln agent runs still use Codex or Claude. Shared skills may already be visible to Copilot, but each client's discovery paths and features differ. References: [Claude settings](https://code.claude.com/docs/en/settings), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-basic), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Copilot CLI configuration](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference), [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference), [VS Code skills](https://code.visualstudio.com/docs/agent-customization/agent-skills).

## Standard repositories

Every new or migrated Kiln library uses the same [versioned layout](REPOSITORY_FORMAT.md), which documents what is portable and what remains private to a machine. App infrastructure lives in `.kiln/` and a pinned GitHub Actions workflow validates data without executing skills. Infrastructure upgrades show a file preview and refuse to overwrite locally modified infrastructure.

## Command-line interface

The CLI uses the same domain code, IDs, approval checks, deployment receipts, and mutation lock as the desktop. From a source checkout (see [DEVELOPMENT.md](DEVELOPMENT.md)):

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

After building, `npm link` makes both `kiln` and `workbench` available through npm's bin directory.

Start with the named collection; read content only for the items you need. Collection names match exactly, including case. Lists return IDs, titles and kinds; `items list --full` returns detailed metadata. Lists include archived/rejected items and exclude trash. `--status` narrows them further. Collection summaries include empty collections with count zero.

Lists return `total` and `nextOffset`; pass `--offset <nextOffset>` for another page. `--limit` defaults to 50 (maximum 500). `items read` accepts 1–100 IDs in one call. Single reads return one object; multiple IDs return `{ items: [...] }` in requested order. Add `--full` to read content and attached files. `--revision` works with one ID only. A failed batch returns an error without partial content.

Other typed operations accept `--input request.json`. Results include `schemaVersion`, `ok`, and `data`; errors use structured stderr and a nonzero exit status. Unknown, misplaced, repeated and valueless options fail before storage is opened. `--library` and `--local` can isolate storage. `KILN_LIBRARY` and `KILN_LOCAL` override defaults; `KILN_DESKTOP_DATA` isolates desktop preferences for tests.

## Updating the installed app

If you installed Kiln from GitHub, update by downloading and running the newer installer from the [releases page](https://github.com/waLLxAck/kiln/releases).

On macOS and Linux, Kiln doesn't update itself: Settings → Updates links to the releases page. Replace `Kiln.app` in Applications with the new one, replace the AppImage file, or `sudo apt install` the new .deb.

Windows builds made from a local checkout can update themselves in the app; see [DEVELOPMENT.md](DEVELOPMENT.md#in-app-updates-for-local-builds).

## Panels and performance logs

Drag the dividers beside the navigation sidebar and skill list to resize them. Widths are saved on this machine. Focus a divider and use arrow keys (20 px), Home, or End for keyboard resizing.

**Settings → Open performance logs** opens the local `logs` folder under Electron's user-data directory (normally `%APPDATA%/kiln-workbench/logs` on Windows, `~/Library/Application Support/kiln-workbench/logs` on macOS and `~/.config/kiln-workbench/logs` on Linux). Isolated profiles use their own logs folder. Nothing is uploaded. Request arguments, skill bodies, and credentials are excluded. What the log records and how to read it after a freeze is in [DEVELOPMENT.md](DEVELOPMENT.md#performance-diagnostics).

## The problems behind the workflow

### “I know I saved something useful. Where did it go?”

Prompts get buried in chats, skills end up in hidden folders, and a video bookmark loses the reason you saved it. Kiln gives related material a collection: the source, extracted ideas, prompt drafts and skills can stay together. Search, kind and status filters, tags and favorites help retrieve it later. Collections can be renamed and reordered; bulk selection makes clearing out a stale library practical.

Existing work does not need to be recreated. Import installed skills, native agent definitions or a skills repository as drafts with their supporting files. Original source files are left in place. Imports do not automatically approve or install anything.

### “Did this prompt work here, or only in someone else’s demo?”

An idea worth trying in a game project may be irrelevant to a backend service. Pick the local project for the experiment and run the exact prompt revision there. The result, limitations and agent assessment stay associated with that revision, separate from the human decision to keep it. Managed experiments request read-only access; tasks that require changes or unavailable tools cannot be presented as proven successes. A manual handoff is available for an external session.

### “Which version did I trust?”

A skill can evolve without losing the version that was reviewed. History and diffs show what changed; approvals refer to an exact immutable snapshot. Further editing produces a new draft. Installation uses approved content, including when a newer unapproved draft exists.

Kiln creates and manages a GitHub repository with a standard library layout for authored content, attachments, revisions and approvals. Approval publishes the reviewed snapshot rather than every private draft. Git controls expose changes, synchronization and conflicts; failed publishing is visible and retryable. Repository validation checks content integrity without executing skills.

### “I changed an agent setting. How do I get back?”

Instructions, permissions, hooks, MCP settings and shell profiles are spread across client-specific files. Config files brings discovered personal files and added project files into one editor, with each file’s purpose and location, validation on save, 30 private backups, comparisons and restoration. See [Config files](#config-files).

### “Which projects still have the old copy?”

Installing a skill is only the start of maintaining it. Kiln shows copies in configured personal locations and enrolled projects, distinguishes managed copies from outside edits, and offers comparisons for differences. Install receipts record the revision and destination. Removal can clear an installed copy while keeping the library item and history; supported rollback operations check for intervening changes.

For another machine, open the Kiln repository there, configure its locations, review any required approvals and sync desired installs. This is local installation on each machine, not remote deployment. Skills and native agent definitions are installed only into compatible client locations, and new client sessions load the copies.

### “There was one good idea in that hour-long talk.”

Distilling a captioned YouTube video creates a collection of reusable entries with timestamped source links and the transcript attached to the source item. Ask the agent about an entry with that source context already available. Plain text, screenshots and files can also be captured for later analysis; Save only preserves the material without calling a model.

## Machines

**Machines** is where project folders are enrolled and every installed copy is checked for drift. It is not reliable yet, so release builds (the downloads) show it as **Coming soon**, with a short note on what it will do, and nothing else in the app links into it: an item's Installs tab offers **Install a specific revision…** for the folders Kiln manages. Personal skill folders are still chosen in **Settings**, and the install toggles show each folder's live state. Builds from source (`npm run dev`, `npm start`) keep the full section; to see it in a release-style build, build with `KILN_SHOW_MACHINES=1` (see [DEVELOPMENT.md](DEVELOPMENT.md)).

## Product boundaries

- The library is local, but desktop onboarding requires a Kiln-created repository connected to GitHub. Approval publishes the reviewed snapshot; this is not an account-free, offline-only product.
- Managed agent runs support Codex and Claude Code. Copilot supports skills and agent-definition import/installation, not built-in experiment execution.
- Automated capture and experiments request read-only access. Item chat has broader file and command access. Agent interactions use the official clients and show a consent notice; normal editing, approval and installation do not invoke a model.
- Local run folders hold private inputs and transcripts. Normal export/publishing excludes reserved session data and machine-specific paths; authored text and arbitrary attachments are not automatically secret-redacted.
- External client hooks can be edited in Config files; Kiln does not execute them itself.
- SSH execution, remote deployment and a remote machine dashboard are not implemented. Windows installers are unsigned and the full Windows release matrix is not certified. macOS builds are ad-hoc signed and not notarized; the macOS and Linux builds are new in 0.18.1; the macOS builds have not been tested on a real Mac, and the Linux build has been tried on one Arch Linux desktop.

This is the local workflow release, with GitHub onboarding and standardized migration. See [implementation and verification](IMPLEMENTATION.md) for what has been checked and what remains.

The marketing site is based on these facts. Its interactive skills panel, capture, test run and approval use sample states and condensed library prompts; they do not connect to the visitor’s files, call a model or claim measured outcomes.

## Notes for older libraries and releases

- When an older library opens, legacy session-bearing revisions are archived in machine-private storage and the current item becomes a cleaned, unapproved draft. Local History can still read the original. Existing remote Git history is not rewritten; material published by an older release remains in that history.
- Libraries distilled before the per-kind tabs (Insights, Techniques, Tools, Resources) are re-filed the first time they open.
- `items list` returned detailed metadata by default before 0.16.0; `--full` restores that shape.
- Updates started from an older Kiln release still follow that release's update flow; the two-step Windows update flow starts after installing 0.8.1.
- Performance fixes in 0.2: theme applies immediately and saves outside the work queue; selected-item installation checks inspect one skill; duplicate read requests are shared; unchanged item metadata and Git status are reused; copied observations do not rebuild the index. GitHub checks are explicit, and import previews distinguish pending changes from already imported skills.
