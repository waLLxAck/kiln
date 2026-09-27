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
- [Library, query bar and collections](#library-query-bar-and-collections)
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
| Prompt editing | Keep Markdown and attachments, fill in `{{variable}}` placeholders when copying (all optional; anything left blank stays as `{{name}}`), inspect revision history and diffs, and retain provenance when deriving new items. |
| Experiments | Choose a local project/repository or an isolated example, then test an exact revision through Codex or Claude Code. Or prepare a manual handoff with a project, task, rubric and optional variable values. Keep output, limitations and pass/fail/uncertain assessments with that revision. Agent assessments and human judgements are distinct. |
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

The left rail follows the same path. **Library** holds everything live; under **Stages**, **Drafts**, **Testing** and **Approved** show items by status and **Installed** shows skills and agents with at least one copy on this machine, each with a count. Choosing a stage filters the library; choosing a collection clears the stage. Collections, **Archive** and **Trash** come next, then the tools: **Experiments**, **Config files**, **Machines**, **Activity** and **Settings & repository**.

The search field in the middle of the top bar (**Ctrl+K**) opens the quick-search window for items and commands. The thin status bar along the bottom shows the repository and branch with where it stands against GitHub ("everything on GitHub", "N not on GitHub yet" or "N approvals failed to publish"; click it for Settings), the agent runs (click for the list with each item and how long it has run; click a run to open its item), and the version with **Download** or **Restart** when an update is ready.

Setup checks the signed-in GitHub CLI account for `my-kiln` and offers **Use this repository** or **Use something else**. Existing local copies are reused only when their GitHub origin matches and they are Kiln libraries. Connection failures offer a retry; unrelated repositories are never attached.

## Open the app

After installing, start Kiln from its Start Menu or Desktop shortcut on Windows, from Applications on macOS, or from the AppImage, the unpacked tar.gz or your applications menu on Linux. (For builds you made yourself, see [DEVELOPMENT.md](DEVELOPMENT.md#run-a-local-build).)

Closing the window keeps Kiln in the tray (the menu bar on macOS); use **Quit Kiln** there to exit, or Cmd+Q on macOS. Linux desktops without a tray (GNOME without an AppIndicator extension) show no icon: quit from **File → Quit** (press Alt to show the menu bar), and opening Kiln again brings the window back.

The default quick-search shortcut is **Ctrl+Shift+Space** (**Cmd+Shift+Space** on macOS) and can be changed in Settings. Global shortcuts may not work under Wayland on Linux.

See [what changed in 0.19.1](releases/0.19.1.md).

## Set up a library

1. On first launch, sign in with the official `gh` CLI and create a Kiln repository on GitHub (or open one Kiln created earlier). The same screen offers **Import my installed skills** (the folders Codex and Claude Code already read on this machine) and **Import from a skills repository** (a clone or one of your GitHub repositories); everything arrives as drafts with supporting and linked files, and nothing is moved. Folders that only hold other skills (such as `~/.codex/skills/.system`) are not listed on their own; empty or broken folders are. If the skills came from a personal folder Kiln does not manage yet, setup offers **Manage the … folders** so the copies already there show as found instead of "Not installed"; managing a folder only records it, and installs or changes nothing. Two different skills with the same name stay separate items, and the list and the item header show which folder each came from (the full folder is kept on this machine only; the library stores just the folder name). **Settings & repository** has the same tools later, including **Connect a different repository**.
2. In **Settings → Skill & agent locations**, choose **Agents** (`~/.agents/skills`, shared by Codex, Copilot and other clients) and **Claude** (`~/.claude/skills`). Both skill and client-specific agent-definition paths are shown. **Find skills and agents not in the library** imports existing items as drafts and offers safe cleanup of broken links or empty folders. Optional `.codex/skills` and `.copilot/skills` copies are under **Client-specific locations**; Copilot project copies use `.github/skills`. An installed item shows **Installed** in its header. Click it to manage or remove individual copies in **Installs**, where Agents and Claude locations are grouped together and client-specific copies are in a disclosure. See [verified compatibility and sources](SKILL_LOCATIONS.md).
3. Browse **Library**, or a stage such as **Approved** in the rail; type `kind:skill` in the query bar for skills only. **Archive** holds rejected and archived items. Right-click any item for status, favourite, install, move and trash actions. Right-click a collection in the sidebar to add a subfolder, rename or delete it, and drag it to nest or reorder it; deleting asks whether its items stay in the library or move to Trash. Items in **Trash** can be restored or deleted permanently.
4. **Test** runs an experiment with Codex or Claude Code (or a manual handoff); output and the agent assessment are saved automatically against the exact revision. **Create skill** asks the chosen agent to draft a SKILL.md from a prompt, image or note using Kiln's bundled writing-for-agents guidance; the draft arrives as a new unapproved skill linked to its source.
5. Every skill shows one toggle per configured location. **Install** copies the approved version into the agent's skills folder (approving the current draft first if needed); new agent sessions see it. **Approve & install** does both for every configured location in one click. **Remove** deletes only that copy. An identical folder Kiln did not create is adopted rather than rewritten; a junction is replaced by a real copy; a differing folder is set aside under Kiln's private data only after you confirm. Project folders are enrolled in **Machines** and installed to from an item's Installs tab. Machines is not reliable yet, so release builds show it as **Coming soon** (see [Machines](#machines)); builds from source still have it.
6. Installed skills are recorded in `workbench/installs.json` inside the library. On another machine, clone the library, turn on the same locations and press **Install everything marked for this machine**, or run `workbench skills sync`. Sync installs the latest locally trusted approved revision, even when a newer draft exists. It never creates an approval; missing or imported-only approvals are reported for review.
7. **Approve** commits that item (and only that item) and pushes it to GitHub in the background; the desktop uses a plain "Approve …" commit message without invoking an agent. Automatic approval publishing commits only the exact reviewed snapshot, excluding earlier private drafts and edits made while publishing. Explicit CLI Git checkpoints still commit all managed working files. If a push fails, the item says so and offers **Retry**; **Settings → Kiln repository** shows anything still waiting.

Editing an item does not need a note: leave **What changed?** empty to use a plain revision note. Desktop saves do not invoke the model.

## Capture

The composer at the top of the library ("Paste, drop or type anything to keep it…") takes text, links and files. Click it, press **Ctrl+N** or **Capture**, or paste or drop anything onto the window from any section: Kiln switches to the library and puts it in the composer. The upload button beside the field picks files. Kiln reads what it was given and offers one main action, run with **Ctrl+Enter**:

- **A bare YouTube link**: **Distill video** (see [Distilling a YouTube video](#distilling-a-youtube-video)), or **Save link only**.
- **Another link**: **Analyze page**, or **Save link**.
- **Text**: **Save as draft**, or **Analyze with** your agent. `{{variables}}` in the text are listed.
- **Files**: each file shows with its size (images with a preview); **Save N files**, or **Analyze with** your agent. Files: 25 MB in total.

**Agent** picks Claude Code or Codex for this capture (the default comes from Settings). **Save only** turns every action into a plain save: the original text and attachments are kept at once without calling an agent or fetching captions. A saved item is highlighted in the list.

Analyzing keeps your original material as a **source** and asks the agent to create reusable prompts, insights, techniques, tools and resources in a collection, each linked back to that source. **Recent captures** under the composer shows analyses running now and those finished in the last half hour, with their step and time, then **Open collection** or **Open** when done. A saved-only item can be analysed later with **More → Analyze as a source**.

See [Sources](#sources) for how the material and everything made from it stay connected.

Unreadable sources and unsupported files are reported instead of guessed. Mixed files stay together on the source item. Failed starts can be retried without creating another copy. Existing captures are not automatically reprocessed.

## Sources

A source is the material an analysis read: a pasted chat, a page, files, or a video. It is not a prompt, so it has no Copy, Test, Approve or Create skill. `kind:source` in the query bar lists them, with how many items were made from each in the Status column. A source's page has:

- **Overview**: the analysis runs (model, effort, tokens, steps, summary, takeaway, what was skipped), a short list of what was made, and the original material.
- **Made**: every item made from it, grouped by kind, each with the collection it is filed in now. **Show in library** filters the library to them with a `from:` token.
- **Original**: the material and its attached files, editable like any item.
- **History**: its revisions.

**Analyze again** runs a new analysis; new entries are added beside the earlier ones. Every entry shows **From "<source>"** under its title, which opens the source. The link is kept on the entry, so moving entries, renaming collections or deleting a collection never breaks it. A `from:` token in the query bar shows what one source produced across collections.

The run's steps and CLI session stay on the machine that ran it. A summary of each completed analysis (provider, model, effort, tokens, summary, takeaway, skipped notes, counts and the items it created) is kept in the library under `workbench/analyses/`, so it shows on other machines and in exports. Chatting about a source, or about an entry made from one, gives the agent the source material (a video's transcript) and the list of sibling entries.

Material analysed before sources existed is filed as a source the next time the library opens: anything with a distillation note in its history, or a video with its transcript. Approved items are left as they are, because changing the kind creates a new revision; Kiln shows a warning for them instead.

## Distilling a YouTube video

Paste a bare YouTube link into the capture composer and its main action becomes **Distill video**. Kiln fetches the captions and metadata with `yt-dlp` the same way the shell `yt` helper does (auto-captions, English first, `~/cookies.txt` when present; nothing else is downloaded), keeps the cleaned transcript as `transcript.md` on the video's source item, and asks the chosen agent for library entries: ready-to-paste prompts, tools with what they do and their official URL, techniques as numbered steps, resources, and only the insights that change what you would do.

Each entry becomes its own item in a collection named from the video title (Unicode and whitespace normalized; a video ID suffix distinguishes collisions), linked back to the video with a timestamped URL and a one-line description shown under its title. Prompts are stored bare so Copy yields only the prompt. The video's source page shows the summary, takeaway, entry counts and everything made from it. `yt-dlp` must be on PATH.

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

## Library, query bar and collections

The library is a table with one line per item: its kind, title and a one-line description, the collection (hidden inside a collection), the status (**Draft**, **Testing** or **Approved**; "+ newer draft" when you edited an approved item, whose approved revision is still what installs; a GitHub mark shows whether an approval reached GitHub), where it is installed ("2 of 3" personal folders with one dot per folder, "1 changed" in the warning colour when a copy was edited outside Kiln, project copies after; a dash for kinds that cannot be installed), the last test (verdict and project) and when it was updated. Sources show how many items were made from them instead of a status (see [Sources](#sources)). Two items with one title show where each came from.

Click a row to open the item. It takes the whole page, with a bar above it: **← Library** (or the stage or collection you came from), its position such as "3 of 13" and arrows to step through the list (**Alt+↑** and **Alt+↓** work too). **Esc** goes back to the list where you left it, with the row still highlighted. **↑** and **↓** move through the rows and **Enter** opens one. Hovering a row shows **Copy**, **Test** (opens the item with the run dialog) and **Install ▾** (one entry per skill folder, checked where a copy is).

**The query bar** above the table finds things. Free text searches titles, content and tags. Filters are tokens: type a facet and a value (`kind:skill`) or pick from the suggestions, grouped by facet, each with how many items it would show. Facets are `kind:`, `status:` (draft, testing, approved, rejected, archived), `state:` (installed, not installed, changed outside Kiln, managed by Kiln, external copy, link or junction), `in:` (a skill folder: Shared Agents, Claude, Codex-specific, Copilot-specific, personal or in a project), `is:favourite`, `tag:`, `from:` (a source), `collection:`, `provider:` (native definitions or client-specific copies; shared `.agents/skills` copies use `in:`) and `scope:` (personal or project). Two tokens of one facet match either value; different facets must all match; `in:`, `scope:`, `provider:` and the copy states must hold for the same copy (**state: not installed** with an `in:` token means "not in that folder"). Remove a token with its × or Backspace. **Ctrl+F** focuses the bar. When nothing matches, the list names the narrowest token and **Remove it** brings back the most items.

Under the bar, **All** clears the query and **Favourites** shows starred items. **Save this view** names the current tokens and text as a pill of its own (kept on this machine; its × deletes it). **Group** puts the list under collapsible headings by collection, kind or status. Each view (the library, each stage, each collection, Archive and Trash) remembers its own query, order, highlighted row and open item.

**Collections** are folders. The **+** beside COLLECTIONS makes a **New Folder** at once with its name selected, so you type the name straight into the sidebar: Enter or clicking away saves it, Esc keeps "New Folder". Right-click a collection for **New subfolder** (made the same way inside it), **Rename** (in place; F2 works too) and **Delete collection…**. **Drag** a collection onto another to nest it there, onto the top or bottom edge of a row to put it before or after that row (moving it to that row's parent if needed), or onto the COLLECTIONS heading to lift it to the top level. **Manage collections** shows the same tree with the same drag, rename and new-folder actions, plus arrows to reorder from the keyboard. The sidebar tree can be collapsed, and choosing a collection shows its subfolders' items too. Moving or renaming a collection takes its subfolders and every item in them along, trashed ones included. Imported collections can be renamed freely; nothing ties them to their source repository.

Collection names and nested paths have no application-level character limit. Older builds could hide items with collection paths longer than 80 characters and report a library warning; that validation error did not delete the files. Open the same library in an updated build on each affected machine to load those entries again without truncating names or changing revisions and approvals.

**Move to collection…** on an item's right-click menu (or on a selection) files items in another collection, a new one, or none. Items outside every collection stay in the whole library and appear under **Unfiled**. Deleting a collection offers **Keep items**, which moves its items and subfolders up one level (to the parent, or out of every collection for a top-level one), or **Move items to trash**, which trashes them with their subfolders' items; restoring one brings the collection back.

Organising never creates a revision: where an item is filed is kept on the item, not in its content, so approved items stay approved and installed copies keep matching. Changing only the collection in the editor is a move too.

**Sort** beside Group orders the list: **Recently added** (the default everywhere), **Recently updated**, **Most copied** (copies made from Kiln), **Most used** (copies, opens, tests and agent use Kiln has seen), **Title A–Z**, or **Custom order**, the hand-arranged order that the up and down arrows beside Sort change (without grouping). Clicking a column heading sorts by it too. Each view remembers its own order. Inside a collection, its **sources** always come first, sorted among themselves; across the whole library they mix in with everything else.

## Bulk Library management

Pick several rows the way a file manager does: **Ctrl-click** toggles a row, **Shift-click** extends from the highlighted row, and **Ctrl+A** (or **Select all**) picks every row the query shows, including rows below the scroll. With two or more picked, a bar above the table shows how many and of which kinds, with **Move to collection…**, **Status ▾**, favourites, **Remove local copies…** and **Move to trash** (in Trash: **Restore from trash** and **Delete permanently…**). Esc or its × clears the selection; so does changing the query, stage, collection or section.

Right-click a picked row for the same menu a single item has, applied to all of them. Single-key shortcuts in the menu work on the focused row, or on the selection, while the list has focus.

Narrow the list first with the query bar: for example `state:installed provider:copilot` picks the items with a Copilot-specific copy.

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
npm run cli -- collections create --name "Game Design/Puzzles"
npm run cli -- items move <id1> <id2> --collection "Game Design/Puzzles"
npm run cli -- collections delete --name "Old ideas" --keep-items
npm run cli -- items list --kind source
npm run cli -- items list --from <source id>
npm run cli -- --library "C:\path\to\library" github status
npm run cli -- --library "C:\path\to\library" deploy installations
npm run cli -- --library "C:\path\to\library" skills sync
npm run cli -- --library "C:\path\to\library" library export --file "C:\backups\kiln.json"
```

After building, `npm link` makes both `kiln` and `workbench` available through npm's bin directory.

Start with the named collection; read content only for the items you need. Collection names match exactly, including case. Lists return IDs, titles and kinds; `items list --full` returns detailed metadata. Lists include archived/rejected items and exclude trash. `--status` narrows them further. Collection summaries include empty collections with count zero; `count` is the items directly inside, `total` adds subfolders, and `unfiled` counts items outside every collection. `items list --collection "Name" --recursive` includes subfolders; `--unfiled` lists items outside every collection.

Agents organise the library with the same commands as the desktop: `collections create --name`, `collections rename --from --to` (subfolders and items move with it; a path nests it), `collections delete --name` with either `--keep-items` (items and subfolders move up one level) or `--trash-items`, and `items move <id...> --collection "Name"` or `--unfiled` for 1–500 items. Neither option is a default. None of these create revisions, so approvals and installed copies are unaffected.

`items list --kind <kind>` narrows a list to one kind, and `--from <id>` to the items made from one item, wherever they are filed. Reading a source returns `madeFrom`, the items made from it.

Lists return `total` and `nextOffset`; pass `--offset <nextOffset>` for another page. `--limit` defaults to 50 (maximum 500). `items read` accepts 1–100 IDs in one call. Single reads return one object; multiple IDs return `{ items: [...] }` in requested order. Add `--full` to read content and attached files. `--revision` works with one ID only. A failed batch returns an error without partial content.

Other typed operations accept `--input request.json`. Results include `schemaVersion`, `ok`, and `data`; errors use structured stderr and a nonzero exit status. Unknown, misplaced, repeated and valueless options fail before storage is opened. `--library` and `--local` can isolate storage. `KILN_LIBRARY` and `KILN_LOCAL` override defaults; `KILN_DESKTOP_DATA` isolates desktop preferences for tests.

## Updating the installed app

Kiln 0.20.0 and later check the [releases page](https://github.com/waLLxAck/kiln/releases) for new versions 15 seconds after starting and then every 30 minutes. Each check is one small request to GitHub. When a new version is out, a download button appears at the bottom of the sidebar and in Settings → Updates.

- **Windows, the Linux AppImage and the .deb:** **Download** fetches the update in the background while you keep working. **Restart to update** then installs it and reopens Kiln. The .deb asks for your administrator password. Nothing downloads until you click, and closing Kiln doesn't install anything.
- **macOS and the Linux tar.gz:** **Get <version>** opens the release page. Replace `Kiln.app` in Applications, or unpack the new tar.gz over the old folder. macOS only lets apps signed with an Apple Developer ID replace themselves, and Kiln's macOS builds aren't signed that way yet.

Settings → Updates also has **Check now** and **Stop checking**. Versions before 0.20.0 don't check GitHub: download 0.20.0 once from the releases page, and later versions arrive in the app.

Windows builds made from a local checkout can update themselves in the app; see [DEVELOPMENT.md](DEVELOPMENT.md#in-app-updates-for-local-builds).

## Panels and performance logs

Drag the divider beside the navigation sidebar to resize it. The width is saved on this machine. Focus a divider and use arrow keys (20 px), Home, or End for keyboard resizing.

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
