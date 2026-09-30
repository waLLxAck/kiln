# Kiln user guide

This guide covers everything the [README](../README.md) summarises. Together they are the product reference for the app and the [marketing site](https://wallxack.github.io/kiln/). For building, testing and releasing Kiln, see [DEVELOPMENT.md](DEVELOPMENT.md).

- [What Kiln offers](#what-kiln-offers)
- [Installing](#installing)
- [Core workflow](#core-workflow)
- [Open the app](#open-the-app)
- [Set up a library](#set-up-a-library)
- [The item page](#the-item-page)
- [Capture](#capture)
- [Distilling a YouTube video](#distilling-a-youtube-video)
- [Experiments](#experiments)
- [Agent runs](#agent-runs)
- [Asking the agent](#asking-the-agent)
- [Library, query bar and collections](#library-query-bar-and-collections)
- [Model invocation and session start](#model-invocation-and-session-start)
- [Usage](#usage)
- [Bulk Library management](#bulk-library-management)
- [Custom agents](#custom-agents)
- [Config files](#config-files)
- [Standard repositories](#standard-repositories)
- [Command-line interface](#command-line-interface)
- [Features added in 0.22.0](#features-added-in-0220)
- [Updating the installed app](#updating-the-installed-app)
- [Panels and performance logs](#panels-and-performance-logs)
- [The problems behind the workflow](#the-problems-behind-the-workflow)
- [Product boundaries](#product-boundaries)
- [Notes for older libraries and releases](#notes-for-older-libraries-and-releases)

## What Kiln offers

What ships today:

| Capability | What you can do today |
| --- | --- |
| Capture | Paste or drop text, links, images and files; save the original immediately or ask an agent to analyze it. Use the tray and configurable global [quick search](#quick-search) to copy, fill in variables and run app actions. |
| Source analysis | Turn captured material into prompts, insights, techniques, tools and resources, grouped in a collection and linked to their source. |
| YouTube distillation | Fetch captions and metadata with `yt-dlp`, retain the transcript, and extract reusable entries with timestamped source links. |
| Library organization | Search, filter by kind/status/provider/location/tags, favorite items, manage collections, select in bulk, archive, trash and restore. Duplicate copies of a skill are flagged and consolidated into one. |
| Prompt editing | Keep Markdown and attachments, fill in `{{variable}}` placeholders when copying (all optional; anything left blank stays as `{{name}}`), inspect revision history and diffs, and retain provenance when deriving new items. |
| Experiments | Choose a local project/repository or an isolated example, then test an exact revision through Codex or Claude Code. Or prepare a manual handoff with a project, task, rubric and optional variable values. Keep output, limitations and pass/fail/uncertain assessments with that revision. Mark an agent's run as passed or failed yourself; your verdict sits beside the agent's assessment, never over it. Re-test the current revision or ask the agent to improve the item from a result. |
| Run visibility | See live activity, model, reasoning effort, elapsed time and token usage; cancel or retry runs and inspect local evidence. Up to two managed runs can be active. |
| Item conversations | Ask an agent about an item and its attachments, including source-video context; continue a private session or explicitly export its transcript. |
| Skill authoring | Ask an agent to turn a prompt, image or note into a new SKILL.md draft using bundled writing guidance, with a link back to the source revision. |
| Custom agents | Import and manage native Codex, Claude Code and Copilot agent definitions; install approved definitions into compatible client locations. |
| Review and approval | Approve an exact revision. Publish that reviewed snapshot to your Kiln GitHub repository, with visible progress and retry for failed publishing. New edits become drafts. |
| Installation | Install approved skills and agent definitions into personal locations or any project folder. Inspect copies, drift and receipts; update copies behind the approved revision, remove copies, roll back supported deployments, and sync desired installs on another machine. |
| Imports and portability | Import existing installed skills or skills repositories as drafts. Export/import authored library data and attachments, including empty custom collections. Imported approvals require local review. |
| Configuration editor | Discover and edit agent instructions, settings, permissions, MCP configuration, hooks and shell profiles. Validate supported syntax, compare backups, restore versions and detect stale edits. |
| Git and GitHub | Create or open a Kiln repository, inspect changes, checkpoint, synchronize and resolve conflicts. GitHub access uses the official `gh` CLI. |
| CLI | Script collections, items, experiments, approvals, installation and library operations through structured JSON results and the same domain code as the desktop. |
| Desktop preferences | Choose theme and agent defaults, resize panels, configure quick search and startup behavior, inspect local performance logs, and, on Windows, prepare/restart into a newer installer. |
| Usage | See which skills your agents used on this machine (uses, trend, last use, projects), installed skills nobody uses, used skills that aren't in the library or approved (import them in one click), and tokens with an estimated cost by model, project, month and Kiln run, all read locally from Claude Code's and Codex's session logs. |
| Features added in 0.22.0 | Keeping outside edits, a code editor, background GitHub sync, run notifications and a run queue, and keyboard navigation and undo. Always on. |

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

The search field in the middle of the top bar (**Ctrl+K**) opens the quick-search window for items and commands. The thin status bar along the bottom shows the repository and branch with where it stands against GitHub (see [Sync with GitHub](#sync-with-github)), the agent runs (see [Agent runs](#agent-runs)), **Session start** with roughly what each agent loads when a new session starts (see [Model invocation and session start](#model-invocation-and-session-start)), and the version with **Download** or **Restart** when an update is ready.

Setup checks the signed-in GitHub CLI account for `my-kiln` and offers **Use this repository** or **Use something else**. Existing local copies are reused only when their GitHub origin matches and they are Kiln libraries. Connection failures offer a retry; unrelated repositories are never attached.

## Open the app

After installing, start Kiln from its Start Menu or Desktop shortcut on Windows, from Applications on macOS, or from the AppImage, the unpacked tar.gz or your applications menu on Linux. (For builds you made yourself, see [DEVELOPMENT.md](DEVELOPMENT.md#run-a-local-build).)

Closing the window keeps Kiln in the tray (the menu bar on macOS); use **Quit Kiln** there to exit, or Cmd+Q on macOS. Linux desktops without a tray (GNOME without an AppIndicator extension) show no icon: quit from **File → Quit** (press Alt to show the menu bar), and opening Kiln again brings the window back.

The default quick-search shortcut is **Ctrl+Shift+Space** (**Cmd+Shift+Space** on macOS) and can be changed in Settings. Global shortcuts may not work under Wayland on Linux.

See [what changed in 0.24.0](releases/0.24.0.md).

## Quick search

Quick search is a small window for using your library without opening Kiln. Open it with the global shortcut above, **Ctrl+K** in Kiln, or **Quick search** in the tray menu.

One box searches two lists. **Items** matches titles, descriptions, content and tags, best match first (the same ranking as the library's search), with title matches highlighted; it shows the first 30 and says so when there are more. A typo such as "reveiw" still finds "code-review", marked "No exact matches — showing close matches". **Actions** covers **Capture…**, **Install everything marked for this machine**, **Go to** Library, Machines, Config files, Activity, Experiments, Settings, Archive or Trash, **New collection**, **Check for updates**, **Toggle theme**, and **Ask the agent about** the last item you highlighted; the ones matching what you type are listed under the items, and typing `>` lists only the actions (`>sett` narrows them). With nothing typed, your most used items come first. Typing a command's words ("go sett") selects it.

The right side previews the highlighted item. A prompt with `{{variables}}` shows a field for each: the preview fills in as you type, and what you copy is exactly that text. Blank fields stay as `{{name}}`, and the saved template is unchanged.

| Key | Does |
|---|---|
| ↑ / ↓ | Move through items and actions |
| Enter | Copy the item (prompts, skills, images and other pasteable kinds), confirmed by a brief "Copied"; open a link in the browser; open a source in Kiln. Runs a highlighted action. Pressed straight after typing, it waits for the results and acts on the top one. |
| Ctrl+Enter | Open the item in Kiln |
| Shift+Enter | Test it: opens it in Kiln with a new experiment |
| Tab | The item's actions: fill in variables, copy, open in Kiln, test, ask the agent, open the stored file or link. Esc goes back. |
| Esc | Close quick search |

The footer shows the keys for the highlighted row, and each one can be clicked. Quick search hides when you click elsewhere, and opening it again brings back your last search, selected, so typing replaces it.

## Set up a library

1. On first launch, sign in with the official `gh` CLI and create a Kiln repository on GitHub (or open one Kiln created earlier). The same screen offers **Import my installed skills** (the folders Codex and Claude Code already read on this machine) and **Import from a skills repository** (a clone or one of your GitHub repositories); everything arrives as drafts with supporting and linked files, and nothing is moved. Folders that only hold other skills (such as `~/.codex/skills/.system`) are not listed on their own; empty or broken folders are. If the skills came from a personal folder Kiln does not manage yet, setup offers **Manage the … folders** so the copies already there show as found instead of "Not installed"; managing a folder only records it, and installs or changes nothing. Two different skills with the same name stay separate items, and the list and the item header show which folder each came from (the full folder is kept on this machine only; the library stores just the folder name). **Settings & repository** has the same tools later, including **Connect a different repository**.
2. In **Settings → Skill & agent locations**, choose **Agents** (`~/.agents/skills`, shared by Codex, Copilot and other clients) and **Claude** (`~/.claude/skills`). Both skill and client-specific agent-definition paths are shown. **Find skills and agents not in the library** imports existing items as drafts and offers safe cleanup of broken links or empty folders. Optional `.codex/skills` and `.copilot/skills` copies are under **Client-specific locations**; Copilot project copies use `.github/skills`. The **Installs** section of an item's rail shows one toggle per personal location; copies anywhere else, such as project copies under **Projects**, are listed with one action each; client-specific copies are in a disclosure. See [verified compatibility and sources](SKILL_LOCATIONS.md).
3. Browse **Library**, or a stage such as **Approved** in the rail; type `kind:skill` in the query bar for skills only. **Archive** holds rejected and archived items. Right-click any item for status, favourite, install, move and trash actions. Right-click a collection in the sidebar to add a subfolder, rename or delete it, and drag it to nest or reorder it; deleting asks whether its items stay in the library or move to Trash. Items in **Trash** can be restored or deleted permanently.
4. **Test** opens the experiments grid, where you run an experiment with Codex or Claude Code (or a manual handoff); output and the agent assessment are saved automatically against the exact revision. **Create skill** asks the chosen agent to draft a SKILL.md from a prompt, image or note using Kiln's bundled writing-for-agents guidance; the draft arrives as a new unapproved skill linked to its source.
5. Every skill shows one toggle per configured location. **Install** copies the approved version into the agent's skills folder (approving the current draft first if needed); new agent sessions see it. **Approve & install** does both for every configured location in one click. **Remove** deletes only that copy. An identical folder Kiln did not create is adopted rather than rewritten; a junction is replaced by a real copy; a differing folder is set aside under Kiln's private data only after you confirm. **Install into project…** in the item's Installs section installs into any project folder (see [Installing into projects](#installing-into-projects)), and [Machines](#machines) shows every copy on this machine in one matrix.
6. Installed skills are recorded in `workbench/installs.json` inside the library. On another machine, clone the library, turn on the same locations and press **Install everything marked for this machine**, or run `workbench skills sync`. Sync installs the latest locally trusted approved revision, even when a newer draft exists. It never creates an approval; missing or imported-only approvals are reported for review.
7. **Approve** commits that item (and only that item) and pushes it to GitHub in the background; the desktop uses a plain "Approve …" commit message without invoking an agent. Automatic approval publishing commits only the exact reviewed snapshot, excluding earlier private drafts and edits made while publishing. Explicit CLI Git checkpoints still commit all managed working files. If a push fails, the item's Approval section says so and offers **Retry**; **Settings → Kiln repository** shows anything still waiting.

### Sync with GitHub

Kiln checks your Kiln repository on GitHub shortly after it starts, every five minutes and when you come back to the window. It never asks you to sign in and never slows other actions; without a connection the status bar simply says **Offline**. Its repository segment (`owner/name · branch · state`) says **Up to date**, **N new on GitHub** with **Pull** beside it, **N waiting to push**, **publishing N…** or **N failed to publish**. Click it to see what is on its way, **Retry** anything that failed, **Push now**, or **Check now**; **Repository settings** opens Settings. **Settings → Kiln repository** shows the same state in words ("1 new on GitHub · checked 2 min ago"), and its **Fetch**, **Pull** and **Merge from GitHub** buttons do the same as the status bar.

**Pull** brings GitHub's changes in while your drafts stay exactly as they are; only if GitHub changed an item you also have a draft of does Kiln stop and name it, so you can approve or discard that draft first. If this machine and GitHub both have new commits, Kiln offers **Merge from GitHub**, which also works while you have drafts of other items. Moving, reordering or favouriting approved items, changing collections and choosing where approved skills are installed are pushed to GitHub on their own a moment later, as one commit; drafts never go with them, but the names of all your collections do. When you resolve a conflict by taking a side that was approved, it stays approved.

Kiln does its Git work one step at a time: approvals, organisation commits, fetches and pulls wait for each other instead of racing.

Editing an item does not need a note: leave **What changed?** empty to use a plain revision note. Desktop saves do not invoke the model.

## The item page

Opening an item shows one page: a compact header, the content, and a rail on the right (below the content when the window is narrow). The content grows with the window up to a comfortable width, with text kept at a readable line length. Each fact and action appears once, in one place.

- **Header**: kind and collection (click the collection to open it), title with its status badge, the description across the full width, and one line with **From "…"** (the source or item it was made from; click to open it) and when it was last updated. A favourite star sits beside the actions. One primary button offers the next step: **Resolve N changed copies** when a copy was edited outside Kiln, **Test** for an untested draft, **Approve** when the current revision passed a test (**Approve & install** for a skill nobody has installed, **Approve & update installs** for one Kiln has installed), **Update installs (N)** when copies Kiln installed are behind the approved revision, **Install** for an approved skill nobody has installed, **Open link** or **Open file** for links and files, and **Copy** otherwise (a prompt is copied even before it is tested; variables are asked for first). The **⋯** menu holds only what the page doesn't already show: Copy (when it isn't the primary button), Approve & install or Install in every location, Create skill, Analyze as a source, Ask the agent, Open stored file or link, **Add a file…**, **Copy item ID** (for support or scripts; ids aren't shown on the page), Move to draft, testing, rejected or archived, and Move to trash. Edit is on the content, Approve and Install into project… in the rail, and Open tests and Open history in the rail's Tests and History sections. An item in Trash offers **Restore**, and **Delete permanently…** in the menu.
- **Content**: the text itself, formatted, with front-matter as a small property table (who may invoke a skill reads in words: **Model can invoke: no (you only)** for `disable-model-invocation`, **You can invoke: no (model only)** for `user-invocable: false`) and `{{variables}}` highlighted; **Raw** shows the exact text. Click the text (or **Edit**) to edit it in place, in a code editor with line numbers, highlighting (Markdown with front-matter, JSON, YAML, TOML, shell and PowerShell) and find and replace: inside the editor **Ctrl+F** finds (instead of opening the query bar), **Ctrl+H** replaces and **Ctrl+S** saves. Title, collection, tags, source and licence are edited with it. One bar stays at the top while you edit: **Unsaved changes**, **What changed?**, **Save revision** (Ctrl+S) and **Discard**; everything becomes one new unapproved revision. For a skill, Kiln checks SKILL.md as you type and lists what would block approval above the text, each with **Line N** to jump to it (**SKILL.md checks pass** otherwise). Your edits are kept privately on this machine until you save or discard them, so switching items or restarting loses nothing; such items show **unsaved** in the library, and **Discard** asks before throwing the draft away (opening the editor without changing anything leaves no draft, and **Done** closes it). If the item changed elsewhere meanwhile, Kiln says so and keeps your draft; with no edits yet, the editor simply follows the new revision. Above the content are validation warnings, other copies of the item (see [Duplicates](#duplicates)) and running agent runs; images show in a gallery you can enlarge. Below it, **Files** lists bundled files and attachments (Preview, Open, Remove, and **Add a file**); it is hidden when there are none, and **⋯ → Add a file…** opens it. **Edit** opens a text file right under its row, in the same draft; **Add a file** takes a relative path and either starts a **New text file** in the draft or bundles one from disk with **Choose file…** (a new revision at once, like Remove, so both wait until the draft is saved or discarded). Binary files, and files over 512 KB or not UTF-8, are kept exactly as they are.
- **Rail**, each section collapsible: **Approval** (the approved revision, the draft newer than it when there is one, publish state with **Retry**, the evidence, **Approve** or **Unapprove**, and every approval under **See all**; Approve isn't repeated here when it is already the header's primary button); **Installs** for skills, agents and instruction files (**Invoked by** with the model-invocation switch for a skill, see [Model invocation and session start](#model-invocation-and-session-start); a toggle per personal location, other copies with their state and one action, project copies under **Projects**, **Keep** for a copy changed outside Kiln, **Install into project…**, and **Other machines…**; the count says how many copies changed or have an update); **Tests** (the last two results and **Open tests**); **History** (the last three events and **Open history**); **Provenance** (the source URL, the licence when one is set, and the capture date); **Organisation** (move to a collection, add or remove tags). Tags are part of the revision, so changing them saves a new draft; while you edit, both are changed in the editor instead and saved with your draft.

**Open tests** (or the header's **Test**) swaps the content for the item's experiments grid; **Open history** swaps it for the history timeline. **← Content** goes back.

**History** is one timeline, newest first, grouped by day: revisions saved (note, who made it, hash), test runs (verdict, project, provider and model), approvals and approvals removed, publishes to GitHub (commit), installs (with **Review rollback**), removals and rollbacks, and copies changed outside Kiln (with **Compare** and **Resolve…**). Chips filter it to Revisions, Tests, Approvals or Installs, and long histories load in pages with **Show more**. Tick one revision to compare it with the current draft, or two to compare them; each revision offers **Restore as new draft** and, once approved, **Install this revision…**. Restoring library content does not change installed files. A test run keeps **Record result** and **Copy handoff** until it has a result, then **View local evidence**; each can be deleted.

**Keep these changes** brings a copy edited in its folder (or a different copy of the same skill) into Kiln. It is offered in Compare, in the location dialog, as **Keep** on the copy in the Installs section, and in the Machines cell for this machine. Kiln saves the folder's SKILL.md and supporting files (or the agent file) as a new draft of the same item, noted "Kept changes from the … copy", and leaves the folder as it is; the item keeps its own title, description and tags. Then **Approve & install** (**Approve & update installs** when Kiln has installed it elsewhere too) approves that draft and treats the folder as the installed copy without rewriting it, and updates the other copies Kiln installed. If the item changed in the meantime, nothing is overwritten: Kiln reloads it so you can compare and keep again. A folder holding entries the importer skips (`.git`, `node_modules`, `__pycache__`, `.DS_Store`) can be kept, but it won't match the kept revision exactly, so Kiln warns and doesn't offer to approve and adopt it.

For a source, the page shows the source in place of the content and keeps the same header and rail, without the Approval and Tests sections (see [Sources](#sources)).

### Updating installed copies

A copy Kiln installed that hasn't changed since, but is behind the approved revision, reads **update available**: its location toggle says **Update**, a project copy's row has an **Update** button, and the Installs count says how many have one. Either opens the copy's dialog with **Update** (and **Remove**). **Update installs (N)** in the header updates every such copy of the item; for a passing draft of an installed skill the header offers **Approve & update installs**, which approves exactly the revision you are looking at first. In Machines, a cell's **Update to …** and **Update all outdated** do the same. Every update goes through the same safety rules: copies edited outside Kiln, different copies Kiln didn't install and links are never overwritten, and the message names each copy it skipped and why. A copy is only updated where the approved revision installs to the same folder, and the install receipt keeps the previous files for rollback. Start a new agent session to pick up the change.

### Duplicates

The same skill often arrives twice: imported from two folders, a `research (1)` copy, or a version from someone else. Kiln flags items of the same kind that have the same text, or the same name (the SKILL.md `name` or the title, ignoring case and "(1)" or "copy") with mostly the same text. Archived, rejected and trashed items and sources are left out. Flagged items show a small copies count beside their title in the library, `is:duplicate` in the query bar lists them, and the item page says **N other copies of this skill** (with *same text and files*, *same text, other files* or *similar text*), each copy a link, with two actions:

- **Consolidate…** shows the copies side by side: collection, tags, status, where each is installed on this machine, tests, use, and when it was updated. Choose the copy to **Keep** (Kiln suggests the approved one, then one it installed, a favourite, the most used, the newest) and, with **Use this text**, whose text and bundled files it keeps. Pick the result's collection and tags (every copy's tags by default; an approved kept item keeps its own, since new tags make a new revision). A diff shows the kept text against each other copy, with the bundled files that differ, and a line under it says what will happen. **Consolidate** keeps that item (a changed text or tags save one new draft revision, "Consolidated from …"; its approval stays with the revision it named) and moves the others to **Trash**, where they read **merged into …**. The kept item takes over their favourite, their use counts, the installs marked for them (`installs.json` and marks for other machines) and the copies Kiln installed for them on this machine, so those copies show as its own; afterwards Kiln offers **Update them** for any that hold another version, through the usual update and its safety rules (copies edited outside Kiln are never overwritten). Approvals and tests stay with the items they were about, and nothing is approved. **Undo** in the toast, or **Ctrl+Z**, puts everything back while nothing has changed since; restoring a merged copy from Trash also brings it back as its own item.
- **Not duplicates** stops flagging this item with its copies. The mark is stored in the library (`workbench/distinct.json`) and reaches your other machines with the background sync; **Undo** takes it back.

Consolidating published copies is published too: when every copy was approved and pushed, the merged ones go to the trash on GitHub as well, so other machines see one item.

### Installing into projects

**Install into project…** (in the Installs section for skills and agent definitions) opens one dialog. Pick a project from one list — folders you installed into, ran experiments in, or added in Config files — or **Choose folder…** for any folder, then where the skill goes: **Agents** (`.agents/skills`, read by Codex, Copilot and most other clients), **Claude** (`.claude/skills`) or **Copilot** (`.github/skills`). Agent definitions go to their client's project folder. The preview shows the exact destination and whether a copy is already there; installing works like a personal install (a draft is approved first, and a different folder already there is set aside, not deleted, after you confirm). The folder becomes one of your projects on first install. Project copies are listed under **Projects** in the Installs section with **Update**, **Remove** or **Compare**, and are that machine's **Projects** columns in [Machines](#machines). They stay on this machine; other machines don't repeat them. A project with no Kiln copies left can be forgotten with **Forget** in the dialog; its files are untouched. The same project list is offered when you test an item. Installing an earlier approved revision, or an instruction file, is **Install this revision…** in History or **Install an approved revision…** in an instruction's Installs section.

## Capture

Capture is a dialog that opens over whatever you are looking at: press **Capture** in the top bar or **Ctrl+N**, choose **Capture…** in [quick search](#quick-search), or paste or drop anything onto the window outside a text field. What you pasted or dropped is already in it. The field ("Paste, drop or type anything to keep it…") takes text, links and files; the upload button beside it picks files, and pasting or dropping onto the dialog adds more. Kiln reads what it was given and offers one main action, run with **Ctrl+Enter**:

- **A bare YouTube link**: **Distill video** (see [Distilling a YouTube video](#distilling-a-youtube-video)), or **Save link only**.
- **Another link**: **Analyze page**, or **Save link**.
- **Text**: **Save as draft**, or **Analyze with** your agent. `{{variables}}` in the text are listed.
- **Files**: each file shows with its size (images with a preview); **Save N files**, or **Analyze with** your agent. Files: 25 MB in total.

**Agent** picks Claude Code or Codex for this capture (the default comes from Settings). **Save only** turns every action into a plain save: the original text and attachments are kept at once without calling an agent or fetching captions. Saving closes the dialog; a saved item is highlighted in the library list. **Esc**, the × or a click outside closes the dialog without saving, and what you typed or added is still there the next time you open it.

Analyzing keeps your original material as a **source** and asks the agent to create reusable prompts, insights, techniques, tools and resources in a collection, each linked back to that source. **Recent captures** under the field shows analyses running now and those finished in the last half hour, with their step and time, then **Open collection** or **Open** when done. The same runs are in the status bar's agent runs list wherever you are, where a finished analysis offers **Open collection** (or **Open**) too. A saved-only item can be analysed later with **⋯ → Analyze as a source**.

See [Sources](#sources) for how the material and everything made from it stay connected.

Unreadable sources and unsupported files are reported instead of guessed. Mixed files stay together on the source item. Failed starts can be retried without creating another copy. Existing captures are not automatically reprocessed.

## Sources

A source is the material an analysis read: a pasted chat, a page, files, or a video. It is not a prompt, so it has no Copy, Test, Approve or Create skill. `kind:source` in the query bar lists them, with how many items were made from each in the Status column. A source's page is built around what was made from it:

- **Header**: the item page's header, with **Open original** for a page or video. Under it, one line says what kind of material it is (YouTube, Web page, Text or Files) with the channel, duration and published date for a video. The capture date is in the rail's Provenance.
- **Summary**: the latest analysis's takeaway, and its summary when that differs from the description. Under the actions, one muted line names the provider, model, effort, tokens, how long it took and when, with **Run files** when the run happened on this machine. **Analysis details** (or **All n analyses**) replaces that line with every run: its steps, session, counts and what was skipped. A run in progress shows its live card with Cancel and, when it fails, Retry.
- **Actions**: **Analyze again** runs a new analysis; new entries are added beside the earlier ones (for material with no URL this is the page's only Analyze button; the header doesn't repeat it). **Ask about this source** opens the agent chat about it. **Show transcript** (videos) opens the transcript beside the page, or above it in a narrow window; each timestamp opens the video at that point, skipped parts are greyed, and a small kind icon marks where an entry was made (click it to jump to the entry).
- **Timeline** (videos): the length of the video with minute ticks, chapter marks and a marker for each entry at its minute, coloured by kind. Parts the analysis says it skipped are shaded when its note gives times (for example "2:05 to 3:10"). Hover a marker to see the entry and highlight its row; click it to scroll there.
- **Made from this**: every item made from it, grouped by minute under the chapter it falls in (or by kind for sources without minutes), each with its description and, when it is filed away from the source's own collection, the collection it is in now (click to open it). Click an entry's title to open it; **Keep** stars it into Favourites, and **Archive** moves it to Archive with an Undo. Archived entries collapse into **Archived (n)** with **Restore**. **Show in library** filters the library to them with a `from:` token.
- **Original material**: the material as raw text or formatted, and its images. **Edit** opens the editor. Its files (a video's `transcript.md` among them) are listed once under **Files** below, like any item's; the transcript opens with **Show transcript**, so its file has no second preview. Provenance and tags are in the rail.

Every entry shows **From "<source>"** under its title, which opens the source. The link is kept on the entry, so moving entries, renaming collections or deleting a collection never breaks it. A `from:` token in the query bar shows what one source produced across collections.

The run's steps and CLI session stay on the machine that ran it. A summary of each completed analysis (provider, model, effort, tokens, summary, takeaway, skipped notes, counts and the items it created) is kept in the library under `workbench/analyses/`, so it shows on other machines and in exports. Chatting about a source, or about an entry made from one, gives the agent the source material (a video's transcript) and the list of sibling entries.

Material analysed before sources existed is filed as a source the next time the library opens: anything with a distillation note in its history, or a video with its transcript. Approved items are left as they are, because changing the kind creates a new revision; Kiln shows a warning for them instead.

## Distilling a YouTube video

Paste a bare YouTube link into Capture and its main action becomes **Distill video**. Kiln fetches the captions and metadata with `yt-dlp` the same way the shell `yt` helper does (auto-captions, English first, `~/cookies.txt` when present; nothing else is downloaded), keeps the cleaned transcript as `transcript.md` on the video's source item, and asks the chosen agent for library entries: ready-to-paste prompts, tools with what they do and their official URL, techniques as numbered steps, resources, and only the insights that change what you would do.

Each entry becomes its own item in a collection named from the video title (Unicode and whitespace normalized; a video ID suffix distinguishes collisions), linked back to the video with a timestamped URL and a one-line description (listed under it on the source page, and the row's tooltip in the library). Prompts are stored bare so Copy yields only the prompt. The video's source page shows the summary and takeaway, a timeline of the video with each entry at the minute it came from and the skipped parts shaded, the entries grouped by minute to keep or archive, and the transcript with links to each minute (see [Sources](#sources)). `yt-dlp` must be on PATH.

Distillation keeps a private copy of the CLI transcript in its run folder. It is never attached to the library item, included in a normal library export, or newly published to GitHub. The public video captions remain attached as `transcript.md`.

## Experiments

**Test** opens the item's experiments as a grid. Each row is a revision that has been tested, newest first, plus the current revision even if it is untested. Rows show the short hash, revision note, date and author, marked **Current** and **Approved**. Each column is a project: the folder's name with its path underneath, **Isolated example** for runs without a project, **Manual** for manual handoffs, and **Unknown project** for runs whose project this machine cannot resolve. Kiln keeps a run's project only in the machine-private job record of the machine that ran it, so runs from elsewhere, or with a deleted job record, land under Unknown project. Each cell shows the latest verdict chip (pass, fail or uncertain), **Waiting for result** for a prepared manual handoff, a spinner with the live step while a run is active, or **Queued** while it waits for a free run slot. When you have marked an agent's run yourself, a small person mark with a tick or a cross sits beside its chip. A small **+N** counts earlier runs in the same cell.

**Running from the grid.** Hover an empty cell and click **Run**. A run bar opens above the grid with the provider, the project fixed by the column, an optional **What should it try?** box, **Run**, and **Manual handoff instead**. An empty cell on an earlier revision tests that exact revision. **Add project…** adds a column for one of your projects (the same list the Test dialogs and **Install into project…** offer), the isolated example or any folder picked with **Choose folder…**. Enrollment is not required to test a folder. **Run current revision on…** starts the current revision on any project column, and **Run options…** opens the full dialog: provider, **Project / repository** selector, **Choose project folder…**, context and **Manual handoff instead**. The last managed experiment's project is offered again there. The full dialog also has a **Revision** picker: the current revision by default, or one of the recent ones, which is tested exactly as it was. When an item has nothing tested yet, the run bar is already open with a project choice. Only one experiment per item is active at a time, running or queued. Experiments and skill drafts may take up to 15 minutes before Kiln stops them.

**Result panel.** Selecting a cell shows the verdicts first: **Agent's assessment**, and beside it **Your verdict** with **Mark as passed** and **Mark as failed**, or **Your result** for a manual handoff. Your verdict is kept as a record of its own, so the agent's assessment never changes; mark again to change your mind. Only the current revision can be judged; a verdict you gave stays visible after the item is edited. Where you gave one, your verdict is what counts for approval and on the Experiments page. The assessment note follows, then the output, read from this machine's run folder when you open the cell. **Run details** is folded away and lists provider, model, effort, elapsed time, tokens, steps, session, test case and rubric, with **Run files** and **Trial folder**.

Actions:

- **Approve this revision** appears when the selected cell is the current revision, it passed (by your verdict, or the agent's when you gave none) and the revision isn't approved yet.
- **Re-test current revision**, on a run of an earlier revision, runs the item as it is now with the same agent, project and context. For a run from another machine, whose project and context this machine doesn't know, it opens the full dialog.
- **Run again** (or **Retry with …** after a failure) repeats the run with its exact provider, project, context and revision, even if you have edited the item since.
- **Improve with agent** opens the docked chat about the item with a message already typed in: the run's verdicts, the agent's note and an excerpt of its output. Edit it and send it, or close the chat. The chat also sees the item's five most recent experiments.
- **Record result** and **Copy handoff** complete a prepared manual handoff. **Delete experiment** removes the trial, and your verdict on it, from the lists.

While a run is active, the panel shows its live activity and **Cancel run**; a queued run can be cancelled there before it starts.

**The Experiments page** (in the rail's tools) lists every experiment in the library, grouped by item and then by the revision it tested (**Current** or **Earlier revision**, with **Approved** where it applies), newest first, each with a tally such as “2 passed · 1 failed”. **All**, **Pass**, **Fail** and **Uncertain** filter by the verdict that counts, with how many each would show. Each row has the chip and your mark, the provider, the project, the finding's first line and the date, with **Record result** for a prepared handoff and a delete button. Click an item's name to open its experiments grid.

The selected directory becomes the actual working directory for Codex or Claude Code. Experiments remain read-only, so tasks requiring edits or unavailable tools are reported as uncertain. Missing or unreadable folders are rejected before a run begins. Selected paths and task context stay in machine-private job/run files. Agent assessments are labelled separately from human judgements. Missing context and unavailable tools must be reported; synthetic tests are not evidence of running against a real codebase. A run never approves or installs the item.

## Agent runs

Kiln runs your installed, signed-in Codex or Claude Code CLI. It uses existing CLI authentication, with unrelated user tool configuration excluded; no API key is requested. Subscription usage limits still apply. Ordinary library editing, approval and installation do not invoke a model.

- **Codex** runs need the native Codex CLI on PATH with `codex login status` reporting ChatGPT. Kiln uses `codex exec --json --output-schema` with a read-only sandbox.
- **Claude Code** runs use `claude -p --output-format stream-json --json-schema` with Read/Glob/Grep and read-only WebFetch/WebSearch tools, none of your settings, hooks or MCP servers, and the client's own sign-in. If a headless run reports an expired session, run `claude` once in a terminal.
- **PATH on macOS and Linux.** Apps opened from the macOS Dock or a Linux launcher get a minimal PATH, so packaged Kiln on those platforms takes PATH from your login shell (nvm, mise, Homebrew and similar setups) and also looks in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.bun/bin` and `~/.claude/local`.

Capture runs use an isolated working folder; experiments can use a selected local project as their working directory. Capture sends the selected input to the chosen agent; diagnostic logs themselves are local. See the [official non-interactive CLI documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [authentication](https://learn.chatgpt.com/docs/auth).

**Settings → Official agents** chooses the Codex model and reasoning effort from the installed CLI's own catalog; leaving either blank uses the catalog default, and the resolved values are shown on every run. While a run is active the item shows a live activity list (messages, reasoning summaries, commands, web searches) with the thread id and, on completion, the input/cached/output token counts. Two runs go at once; further runs wait their turn as **Queued** and start by themselves. Cancel/retry controls and **Run files** expose progress and evidence. Local `agent-jobs` folders retain the structured response and bounded CLI event stream. App exit stops managed subprocesses; interrupted jobs can be retried. Experiments also retain their trial records and output files.

The status bar's runs segment says how many runs are running and queued, and with which agent ("2 running · 1 queued · Claude Code"), or how many finished in the last 30 minutes. Click it for every active run and those that finished in the last 30 minutes, each with the model, elapsed time and current step, plus **Open** and **Cancel** (a queued run can be cancelled before it starts; one that had not started when Kiln closed is marked interrupted and can be retried). When an experiment, distillation, skill draft or chat reply finishes while Kiln is in front, a toast says what finished ("Experiment passed · …", "Run failed · …") with **Open result**, which opens the item on its tests for experiments, its content for analyses and drafts, or the chat for replies. While Kiln is hidden or behind another window you get a desktop notification instead; click it to jump straight to the result.

### Agent access warning

Before each agent interaction, a warning explains what is sent, account usage, and access to files and commands. For the chat it is shown once each time Kiln starts, before your first message. **Agree and continue** starts the operation; **Cancel** sends nothing. **Don't show again** remembers acceptance on this machine. **Settings → Show agent access warnings again** restores the warning.

Capture, distillation and trials request read-only access. Chat retains broad read/write access and can run commands. On macOS and Linux, Codex chat runs in Codex's workspace-write sandbox: it can read what your account can read, but writes only to the library, the chat's working folder and temporary folders. On Windows, where Codex has no such sandbox, Codex chat runs without one. Claude chat allows Bash, Write and Edit and is not confined on any platform; the warning names only the caveats of the platform it is shown on. The instruction to edit library entries through Kiln's CLI is not a security boundary. Ordinary desktop actions such as Install, Save, Approve and Retry are programmatic and do not invoke an agent or show this warning.

## Asking the agent

**Ask the agent** (the speech-bubble button beside Capture) opens a chat panel docked on the right, beside the item you have open, so you can read both. The button is disabled when nothing is open. **Esc** or the × closes the panel. Drag the panel's left edge to make it wider or narrower (or focus the edge and use the arrow keys); Kiln remembers the width.

- **Ask Claude Code ▾** at the top picks which CLI answers in this chat: Claude Code or Codex. It starts on the default from Settings. A session stays on the CLI it started with, so switching after the first message starts a new session.
- Each item keeps its conversation. Closing the panel, opening another item or restarting Kiln brings the same conversation back when you return to the item. **New session** starts a fresh one about the same item. The clock button (with the number of sessions) lists the earlier sessions about this item by their first message, with the date and the CLI; pick one to reopen it and carry on where it stopped.
- The chips under the header show what goes with each message: the open item and its short revision, the **Video transcript** or **Source material** when the item is a source or was made from one (click it to open the source), and **N entries from this source**. These always go along and cannot be removed.
- **+ Add context**, the @ button, or typing **@** in the message searches your library for other items. Each one becomes a chip (× removes it), and its current content goes with your next message only.
- Replies are formatted text. Library items the agent names become links that open the item, and file paths are highlighted. **Activity · N steps** expands to show every step the CLI took. The line under each reply gives the model, time, tokens and session, with **Run files** to open the run folder.
- The agent edits items with Kiln's CLI, so every edit is a new revision. After each reply, a **Changed by the agent** card lists every item whose revision changed while it ran. The card shows the old → new revision, the revision notes and a line diff; **View changes** opens the before-and-after comparison full size and names anything else that changed (title, tags, bundled files…). **Keep** closes the card. **Undo** restores the previous revision as a new draft, the same way History does, and refreshes the item. Undo is disabled if the item changed again after the reply; use History instead. Items the agent created are listed under **Added by the agent** with **Open**. Kiln finds these by comparing revisions from before and after the reply, so an edit you make yourself while the agent is running shows up here too.

Write in the box at the bottom and press **Ctrl+Enter** or **Send**. While a reply runs, **Cancel** stops it. When two other runs are already going, your message waits as **Queued** and starts by itself; **Cancel** drops it. Follow-up messages continue that session. The agent answers one message per item at a time, so while a reply runs in one session of an item the others wait. Conversations stay private on this machine. Session folders are isolated so simultaneous chats cannot replace one another's context.

**⋯ → Export conversation…** saves a private transcript to a separate file after an explicit warning about messages, local paths and tool output. Review that file before sharing it. Normal exports remove reserved session attachments and machine-specific source paths, redact private trial inputs and activity details, and exclude approvals whose revision bytes had to be transformed. Kiln does not redact secrets deliberately included in authored prose or arbitrary attachments.

## Library, query bar and collections

The library is a table with one line per item: the collection (hidden inside a collection), the kind and title (with a star for favourites; hover a row for its description), the status (**Draft**, **Testing** or **Approved**; "+ newer draft" when you edited an approved item, whose approved revision is still what installs; a GitHub mark shows whether an approval reached GitHub), where it is installed ("2 of 3" personal folders with one dot per folder, "1 changed" in the warning colour when a copy was edited outside Kiln, "1 update" and a filled dot in the accent colour when a copy Kiln installed is behind the approved revision (project copies count too), "1 unmanaged" and a ringed dot for a copy that is there but Kiln did not install (an identical copy it found, or a link), project copies after; a dash for kinds that cannot be installed), who may invoke a skill (**Invoked by**: **Model & you**, **You only**, or **Mixed** when the agents' flags differ; one click switches it, see [Model invocation and session start](#model-invocation-and-session-start)), the last test (verdict and project) and when it was updated. Sources show how many items were made from them instead of a status (see [Sources](#sources)). Two items with one title show where each came from beside the title.

**Columns** can be put in any order: drag a column heading sideways and a line shows where it will land (a drag never sorts). Right-click the headings for **Move left** and **Move right** on that column, which also work from the keyboard (focus a heading with Tab, then the menu key or **Shift+F10**), **Hide column** for any column but Title (hidden columns are listed in the same menu with **Show …**), and **Reset columns** to go back to Collection, Title, Status, Invoked by, Installed, Last test, Updated at their default widths, all shown. **Widths** change by dragging the edge of a heading (hover the header to see the edges). Title always takes the space left over, so each other column has its edge on the side away from Title, and dragging an edge of Title resizes the column beside it. Double-click an edge to fit the column to its content, or use **Reset width** in the heading menu. From the keyboard, Tab to an edge: **←** and **→** move it 16px, **Home** and **End** make the column as narrow or as wide as it goes. A column never gets narrower than its label and chips need, and grows only while Title has room, so the table never scrolls sideways; a narrower window shrinks the columns and gives your widths back when there is room. The order, widths and hidden columns are kept on this machine. Invoked by shows only while a skill is listed. As the window narrows, Last test gives way first, then Installed, Invoked by and Collection.

Click a row to open the item. It takes the whole page, with a bar above it: **← Library** (or the stage or collection you came from), its position such as "3 of 13" and arrows to step through the list (**Alt+↑** and **Alt+↓** work too), and **Refresh** to re-read the library and installed copies. **Esc** goes back to the list where you left it, with the row still highlighted and focused. Hovering a row shows **Copy**, **Test** (opens the item with the run dialog) and **Install ▾** (one entry per skill folder, checked where a copy is).

**From the keyboard**, with a row focused: **↑** and **↓** move through the rows, **Home** and **End** jump to the first and last, **Page Up** and **Page Down** move a screenful, and **Shift** with any of them extends the selection from the open row, like Shift-click. **Enter** opens the focused item and puts focus on its main action (with several rows picked, on the bulk bar). Type the first letters of a title to jump to it. Letters that are shortcuts for the row (O, C, F, E, W, S, A, L, M, R, D, 1–4; see the right-click menu) still run the shortcut, so hold **Shift** for the first letter when a title starts with one; while you keep typing (under a second between keys), every letter extends the title. Menus open with their first entry focused: the arrows, Home and End move, **Enter** or **Space** runs an entry, its letter runs it at once, and **Esc** or **Tab** closes the menu and goes back to where you were. The menu key or **Shift+F10** opens a row's menu under it. Press **?** anywhere outside a text field to see every shortcut.

**Ctrl+Z** (Cmd+Z on macOS) undoes the last library action, up to 20 of them: moving to or restoring from the trash, status changes and archiving (including a swipe), favourites, and moves between collections, from the list, the bulk bar, the Move dialog or a drag or the item page (its star, **⋯ → Move to …**, **Move to trash** and **Restore**), plus consolidating duplicates and marking them as not duplicates. A toast names each action with its own **Undo**. An undo leaves alone any item you have changed since, and says so. Deleting permanently still asks first and cannot be undone. Inside a text field or the editor, Ctrl+Z undoes typing there instead.

**The query bar** above the table finds things. Free text searches titles, descriptions, content and tags. The list stays on screen while you type (a spinner shows a search on its way) and follows renames and edits. Results come best match first (a title match counts more than one in the tags, description or body) and the Sort pill says **Relevance**; pick another order to override it for this search, and clearing the search goes back to the view's own order. A typo such as "reveiw" still finds "code-review", with "No exact matches — showing close matches" under the bar. Filters are tokens: type a facet and a value (`kind:skill`) or pick from the suggestions, grouped by facet, each with how many items it would show. Facets are `kind:`, `status:` (draft, testing, approved, rejected, archived), `state:` (installed, not installed, changed outside Kiln, managed by Kiln, external copy, link or junction), `in:` (a skill folder: Shared Agents, Claude, Codex-specific, Copilot-specific, personal or in a project), `is:favourite`, `is:duplicate` (items with another copy in the library, see [Duplicates](#duplicates)), `is:model-invoked` (skills a model may invoke on its own, whose descriptions load in every new session) and `is:user-only` (skills only you can invoke), `tag:`, `from:` (a source), `collection:`, `provider:` (native definitions or client-specific copies; shared `.agents/skills` copies use `in:`) and `scope:` (personal or project). Two tokens of one facet match either value; different facets must all match; `in:`, `scope:`, `provider:` and the copy states must hold for the same copy (**state: not installed** with an `in:` token means "not in that folder"). Remove a token with its × or Backspace. **Ctrl+F** focuses the bar. When nothing matches, the list names the narrowest token and **Remove it** brings back the most items.

Under the bar, **All** clears the query and **Favourites** shows starred items. **Save this view** names the current tokens and text as a pill of its own (kept on this machine; its × deletes it). **Group** puts the list under collapsible headings by collection, kind or status. Each view (the library, each stage, each collection, Archive and Trash) remembers its own query, order, highlighted row and open item.

**Collections** are folders. The **+** beside COLLECTIONS makes a **New Folder** at once with its name selected, so you type the name straight into the sidebar: Enter or clicking away saves it, Esc keeps "New Folder". Right-click a collection for **New subfolder** (made the same way inside it), **Rename** (in place; F2 works too) and **Delete collection…**. **Drag** a collection onto another to nest it there, onto the top or bottom edge of a row to put it before or after that row (moving it to that row's parent if needed), or onto the COLLECTIONS heading to lift it to the top level. **Manage collections** shows the same tree with the same drag, rename and new-folder actions, plus arrows to reorder from the keyboard. The sidebar tree can be collapsed, and choosing a collection shows its subfolders' items too. Moving or renaming a collection takes its subfolders and every item in them along, trashed ones included. Imported collections can be renamed freely; nothing ties them to their source repository.

Collection names and nested paths have no application-level character limit. Older builds could hide items with collection paths longer than 80 characters and report a library warning; that validation error did not delete the files. Open the same library in an updated build on each affected machine to load those entries again without truncating names or changing revisions and approvals.

**Move to collection…** on an item's right-click menu (or on a selection) files items in another collection, a new one, or none. You can also **drag rows** onto a collection in the sidebar, or onto **Unfiled** (shown while you drag, even when nothing is unfiled); dragging a picked row takes the whole selection. Start the drag by moving up or down, or from the row's icon, since a sideways drag is a swipe that archives. Items outside every collection stay in the whole library and appear under **Unfiled**. Deleting a collection offers **Keep items**, which moves its items and subfolders up one level (to the parent, or out of every collection for a top-level one), or **Move items to trash**, which trashes them with their subfolders' items; restoring one brings the collection back.

Organising never creates a revision: where an item is filed is kept on the item, not in its content, so approved items stay approved and installed copies keep matching. Changing only the collection in the editor is a move too.

**Sort** beside Group orders the list: **Recently added** (the default everywhere), **Recently updated**, **Most copied** (copies made from Kiln), **Most used** (copies, opens, tests and agent use Kiln has seen), **Title A–Z**, or **Custom order**, the hand-arranged order that the up and down arrows beside Sort change (without grouping). Clicking a column heading sorts by it too, and the heading shows the direction; while a search orders by relevance, no heading is marked. Each view remembers its own order. Inside a collection, its **sources** always come first, sorted among themselves; across the whole library they mix in with everything else.

## Model invocation and session start

Every skill a model may invoke on its own costs context in every new session: its name and description sit in the list the agent gets at startup, used or not. A skill only you can invoke (by typing `/name` in Claude Code or Copilot, `$name` in Codex) costs nothing until you call it. So when you wonder whether a skill is worth keeping, you can keep it and stop it loading.

**Invoked by** says which it is: **Model & you**, **You only**, or **Mixed** when the agents' flags differ (for example a skill imported with only Claude's flag). The switch is the same one-click control in the library column, beside each skill in Machines, in the item page's Installs section and on each skill in the Session start breakdown; hover it for which agents may invoke it and roughly how many tokens its description adds. Clicking **Model & you** or **Mixed** makes it **You only**; clicking **You only** lets the model invoke it again.

The switch lives in the skill itself, so every agent that reads the folder sees it:

- `disable-model-invocation: true` in SKILL.md's front-matter, for Claude Code, Copilot CLI and Copilot in VS Code;
- `policy: allow_implicit_invocation: false` in the skill's `agents/openai.yaml`, for Codex (Kiln adds the file when needed and removes it again if nothing else is in it).

Nothing else in the files changes: key order, comments, quoting and line endings stay as they were. The change is saved as a new revision ("Model invocation turned off"). When the current revision is approved, Kiln checks that only the flag changed and approves the new revision itself (as **Kiln**, carrying over the earlier approval's scope and evidence; it is pushed to GitHub like any approval), then updates the copies it installed, exactly as [Updating installed copies](#updating-installed-copies) does: copies edited outside Kiln, different copies and links are skipped and named in the message. The installed copy then equals the approved revision, so it still reads installed and matching. On a draft newer than the approval, the switch edits the draft and installed copies keep the approved revision until you approve it. Start a new agent session to pick up the change. Two limits: claude.ai uploads refuse unknown front-matter keys, so a skill with `disable-model-invocation` can't be uploaded there as it is; and a value written over several lines is left for you to edit by hand.

**Session start** in the status bar estimates, per agent, what the model gets before your first prompt: `Session start Claude ≈ 3.1k · Codex ≈ 2.4k · Copilot ≈ 1.9k`. Click it for the breakdown, with **No project** (personal files only) or one of your projects (or **Another folder…**), which adds that project's instruction files and skills:

- **Skill descriptions**: every skill the agent lists, largest first, with its folder and tokens; skills left out (you-only, turned off in Claude's `skillOverrides` or Codex's `[[skills.config]]`, or a name found twice) are under **N not loaded** with the reason. Skills in your library open with a click and carry the switch, so you can cut bloat here and watch the number drop.
- **Instruction files**: `CLAUDE.md` with the files it imports and `.claude/rules`, Claude's auto memory for the project, `AGENTS.md` for Codex (up to its 32 KiB limit), and Copilot's instruction files.
- **SessionStart hooks** with their commands. Kiln never runs them, so their output isn't counted.
- **MCP servers** by name; their tool definitions aren't counted.
- What can't be known: the system prompt (no agent publishes its size), plugin skills and Codex's built-in skills.

Numbers are estimates: characters divided by 3.5 for Claude Code and by 4 for Codex and Copilot CLI. Each agent also caps the list (Claude Code at 1% of the context window, Codex at 2%); the breakdown says how. The sources for all of this are in [SKILL_INVOCATION.md](SKILL_INVOCATION.md). The estimate is read again when the library or its installs change; only files that changed are re-read.

## Usage

**Usage** in the rail shows which skills your agents actually used on this machine and roughly what the sessions cost, read from Claude Code's and Codex's own session logs. Nothing calls an API and nothing is uploaded. Pick **7 days**, **30 days**, **90 days** or **All time**; every number on the page is for that period.

The first visit reads every log, which can take a few seconds for gigabytes of logs; the page fills in as it goes (**Reading session logs… 40%**). After that Kiln reads only what was added, so opening Usage again takes a moment. The refresh button reads whatever the agents logged since.

**Skills** has one row per skill: **Uses**, **Trend** against the period before, a bar per day for the last 30 days, **Last used**, **Days** with a use, **Projects** (the repository each session ran in; hover for the list), and **Attributed** tokens and estimated dollars. Click a column header to sort. A skill in your library opens with a click; one that isn't reads **not in library**, and when its folder is still there, **Import** brings it in as a draft through the usual import. The chips filter the rows: **Not in library**, **Not approved** (in your library, used, but not approved), and **Installed, unused**: library skills with a copy on this machine and no use in the period, oldest use first (a candidate to remove, or to turn model invocation off; see [Model invocation and session start](#model-invocation-and-session-start)).

A skill's page says **Used 12× in 30 days** under its title (or when it was last used); hover it for active days and projects, click it for Usage. It shows once Usage has read the logs.

How uses are found:

- **Claude Code** (`~/.claude/projects/`, or under `CLAUDE_CONFIG_DIR`; subagents' logs count toward their session): each time the model loads a skill with its Skill tool, and each time you type `/name` for a skill. Both are logged, with the skill's folder.
- **Codex** (`~/.codex/sessions/`, or under `CODEX_HOME`): a skill you name with `$name` is logged with its path. A skill the agent picks itself isn't logged as such, so Kiln counts the agent reading a `…/skills/<name>/SKILL.md` and marks those uses **inferred** (hover the count). A read in the same turn as a `$name` use counts once.

A use maps to a library item by the folder Kiln installed it to, then by the skill's name (its folder name, SKILL.md `name` or title). A use copied into a forked Codex session counts once.

**Spend** shows tokens and an estimated dollar figure, grouped by **Model**, **Project**, **Harness** or **Month** (months are always all time), and Kiln's own agent runs (tests, captures, distillations, chats) by kind or by item. Columns are **Input** (not from a cache), **Cache read**, **Cache write**, **Output** (reasoning included; hover for how much), **Est. $** and a bar for each row's share. **Attributed** on Skills splits each session's tokens evenly among the skills used in it, so it is an attribution, not a measurement.

Dollar figures are **estimates** at API list prices, from a small table in `packages/usage/prices.ts` (**Price table** under Spend shows it, with the date it was checked). With a subscription (Claude Pro or Max, ChatGPT Plus or Pro) you pay a flat fee, so the figure is what the same tokens would cost on the API, not money spent. Models without a price (Codex's models, for now) show tokens only, marked **+** in totals that leave them out. Edit a row, or add one for a model the logs show, and **Save prices**: overrides are kept on this machine; **Restore defaults** drops them. Kiln's own runs also appear in the session logs when the CLI saved a session.

**Privacy.** Usage data stays on this machine. Kiln keeps only counts, skill names and folders, project folders, models and days in `usage/` inside the library's machine-private folder; message text is never copied, and nothing is written to your Kiln repository or published.

## Bulk Library management

Pick several rows the way a file manager does: **Ctrl-click** toggles a row, **Shift-click** extends from the highlighted row, and **Ctrl+A** (or **Select all**) picks every row the query shows, including rows below the scroll. **Shift** with the arrows, Home, End or the Page keys picks from the keyboard. With two or more picked, a bar above the table shows how many and of which kinds, with **Move to collection…**, **Status ▾**, favourites, **Remove local copies…** and **Move to trash** (in Trash: **Restore from trash** and **Delete permanently…**). Changes to many items show their progress ("Moving 120 of 300 to Trash…", "Deleting 12 of 40…"), and one **Ctrl+Z** undoes the whole change. Esc or its × clears the selection; so does changing the query, stage, collection or section.

Right-click a picked row for the same menu a single item has, applied to all of them. Single-key shortcuts in the menu work on the focused row, or on the selection, while the list has focus.

Narrow the list first with the query bar: for example `state:installed provider:copilot` picks the items with a Copilot-specific copy.

**Remove local copies** previews all detected skill/agent copies of the picked items across configured roots, including client-specific folders and recorded installations under previous names. The filter selects items; the review covers all their locations. Library items, approvals and history remain. Matching managed copies are deleted; other copies move to private backups; links are unlinked without following their targets. Changed or unreadable paths are skipped with an explicit result. Successful removals clear the corresponding desired installs so sync does not recreate them. Completed removal plans are repeatable without touching newly created copies. This is not a full-disk search.

## Custom agents

Agents are Library items alongside skills. In **Settings → Skill & agent locations**, use **Find skills and agents not in the library**. The existing scanner detects both kinds and imports them as drafts. Native YAML and TOML content is retained; only the matching client is offered for installation. Approved definitions use personal or project agent directories, with the same backup and drift checks as skills. General instructions, permissions, hooks, and settings remain under Config files.

Agent formats: [Claude subagents](https://code.claude.com/docs/en/sub-agents), [Copilot custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration), and [Codex standalone agents](https://learn.chatgpt.com/docs/agent-configuration/subagents). Older Codex role files without name and description can be imported as drafts and repaired before installation.

## Config files

**Config files** manages personal and project instructions, permissions, hooks, MCP settings and shell profiles. Built-in entries cover Claude settings and CLAUDE.md, Codex config.toml / hooks.json / AGENTS.md / AGENTS.override.md, Copilot CLI settings / saved permissions / MCP / instructions, and VS Code settings. `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `COPILOT_HOME` are respected for config discovery. Enrolled project folders appear automatically; **Add project folder** discovers project settings, rules, agents and hooks. **Add another file** handles other locations, editor profiles, hook scripts and organization-specific files. Both buttons sit at the bottom of the file tree.

The left pane is a tree grouped by agent (Claude Code, Codex, GitHub Copilot, VS Code, Shared, Shell profiles, Added by you), then by scope (Personal, then each project folder), with one line per file: a purpose icon, the name, and its size and date. Files that do not exist yet fold into **N not created** under each agent; expand it and use **Create** to write a starter template, or open the file to preview the template, then choose **Create from template** or **Start empty**. The filter field matches agent, project, name, path or purpose (every word must match), and the purpose chips (Instructions, Permissions & settings, Hooks, MCP) narrow the tree further. Arrow keys move between rows. A dot marks a file with unsaved changes.

The right pane shows the file's agent, scope and purpose, its name and full path, and these actions: **N backups** (the private versions Kiln kept; each has **Compare**, which shows the differences from the current text, and **Restore**, which keeps the replaced version as a backup too and is available once unsaved edits are saved or discarded), **Show in folder**, **Open** (the default app for the file type; not offered for shell profiles), **Copy to library** for Markdown instruction files, and **Remove from list** for files you added. CLAUDE.md files also list their `@path` imports; click one to open it.

Claude Code settings files (personal `settings.json`, and a project's `.claude/settings.json` and `.claude/settings.local.json`) open with a **Permissions · Hooks · Raw** switch. **Permissions** shows `permissions.allow`, `ask` and `deny` as three columns of rule chips. Type a rule under a column and press Enter to add it; Kiln checks the `Tool` or `Tool(pattern)` format and refuses a rule that is already in any column. Click a chip (or right-click it) to move it to another column, copy it or delete it. Other permission settings such as `defaultMode` are kept and edited in Raw. **Hooks** lists each hook command as an event / matcher / command row that you can add, edit and remove. **Raw** is the JSON text. All three edit the same text: structured changes keep unknown keys, key order and the file's indentation. When the raw JSON is invalid, Permissions and Hooks are switched off until it is fixed. Raw and every other file open in the code editor: line numbers, highlighting for the file's language (JSON, TOML, YAML, Markdown, shell, PowerShell), and **Ctrl+F** / **Ctrl+H** to find and replace inside it.

Edits collect in an unsaved bar (**N changes · Discard · Save**, or Ctrl+S). Drafts survive a restart. Saves validate JSON/TOML syntax (VS Code allows JSON comments) and show any error in the bar. They also reject stale edits when a file changed on disk, preserve line endings and BOM, and keep 30 private backups. These are syntax checks, not proof that an installed client supports a setting.

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
npm run cli -- --library "C:\path\to\library" skills invocation <id> --model off
npm run cli -- --library "C:\path\to\library" context start --project "C:\code\my-game"
npm run cli -- --library "C:\path\to\library" usage skills --days 30
npm run cli -- --library "C:\path\to\library" library export --file "C:\backups\kiln.json"
```

After building, `npm link` makes both `kiln` and `workbench` available through npm's bin directory.

Start with the named collection; read content only for the items you need. Collection names match exactly, including case. Lists return IDs, titles and kinds; `items list --full` returns detailed metadata. Lists include archived/rejected items and exclude trash. `--status` narrows them further. Collection summaries include empty collections with count zero; `count` is the items directly inside, `total` adds subfolders, and `unfiled` counts items outside every collection. `items list --collection "Name" --recursive` includes subfolders; `--unfiled` lists items outside every collection.

Agents organise the library with the same commands as the desktop: `collections create --name`, `collections rename --from --to` (subfolders and items move with it; a path nests it), `collections delete --name` with either `--keep-items` (items and subfolders move up one level) or `--trash-items`, and `items move <id...> --collection "Name"` or `--unfiled` for 1–500 items. Neither option is a default. None of these create revisions, so approvals and installed copies are unaffected.

`items duplicates` lists the groups of likely copies, each with its match and the copies' IDs, titles, collections, statuses and revisions. `items consolidate --input request.json` consolidates one group: `{ "keep": id, "expect": revision, "merge": [{ "id", "expect" }], "content": id?, "tags": [...]?, "collection": "..."? }`, where `content` names the copy whose text and files are kept (the kept one by default) and every `expect` must still be that item's current revision. It returns an `undo` object for `items unconsolidate --input`. `items distinct --input '{ "ids": [id, id] }'` marks items as not duplicates (`"distinct": false` takes it back).

`skills invocation <id> --model on|off [--expect <revision>]` flips the model-invocation switch as the desktop does (see [Model invocation and session start](#model-invocation-and-session-start)): it returns whether anything changed, `approval` (`carried` or `draft`) and what happened to installed copies, and waits for the approval to reach GitHub. `context start [--project <folder>]` returns the session-start estimate for each agent, with every skill, file, hook and MCP server it counted.

`usage scan` reads new session-log entries into the usage cache; `usage report [--days 30]`, `usage skills` and `usage spend` scan first, then return the [Usage](#usage) page's data (`--days 0` for all time): skill rows with `uses`, `previous`, `lastUsed`, `activeDays`, `projects`, `signals` (`tool`, `slash`, `explicit`, `inferred`), `attributed` tokens and `importable`, the `unused` installed skills, and `spend` by model, project, harness, month and Kiln run, with `cost` as an estimate. `usage item <id>` returns one skill's counts from the cache. `usage prices` returns the price table; `--input` with `{ "set": { "<model>": { "input", "cached", "cacheWrite", "cacheWrite1h", "output" } } }` (dollars per million tokens) saves this machine's overrides.

`items list --kind <kind>` narrows a list to one kind, and `--from <id>` to the items made from one item, wherever they are filed. Reading a source returns `madeFrom`, the items made from it.

Lists return `total` and `nextOffset`; pass `--offset <nextOffset>` for another page. `--limit` defaults to 50 (maximum 500). `items read` accepts 1–100 IDs in one call. Single reads return one object; multiple IDs return `{ items: [...] }` in requested order. Add `--full` to read content and attached files. `--revision` works with one ID only. A failed batch returns an error without partial content.

Other typed operations accept `--input request.json`. Results include `schemaVersion`, `ok`, and `data`; errors use structured stderr and a nonzero exit status. Unknown, misplaced, repeated and valueless options fail before storage is opened. `--library` and `--local` can isolate storage. `KILN_LIBRARY` and `KILN_LOCAL` override defaults; `KILN_DESKTOP_DATA` isolates desktop preferences for tests.

## Features added in 0.22.0

Kiln 0.22.0 shipped ten changes behind switches in Settings. They are now part of Kiln and always on; the switches are gone, and a switch saved by 0.22.0 is ignored. Each is described in this guide where it lives.


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

Installing a skill is only the start of maintaining it. Kiln shows copies in configured personal locations and your projects, marks copies behind the approved revision as **update available**, distinguishes managed copies from outside edits, and offers comparisons for differences. Install receipts record the revision and destination. Removal can clear an installed copy while keeping the library item and history; supported rollback operations check for intervening changes.

For another machine, open the Kiln repository there, configure its locations, review any required approvals and sync desired installs. This is local installation on each machine, not remote deployment. Skills and native agent definitions are installed only into compatible client locations, and new client sessions load the copies.

### “There was one good idea in that hour-long talk.”

Distilling a captioned YouTube video creates a collection of reusable entries with timestamped source links and the transcript attached to the source item. Ask the agent about an entry with that source context already available. Plain text, screenshots and files can also be captured for later analysis; Save only preserves the material without calling a model.

## Machines

**Machines** shows what is installed where on this machine, in every build. The top line says **This machine · name · platform** (the computer's name). Beside it, **Add a machine · Coming soon**: seeing your other computers and installing to them from here is not ready yet. To set up another computer today, clone the library there and press **Install everything marked for this machine** in Settings (see [Set up a library](#set-up-a-library)).

- **Matrix.** Rows are skills and agents with their approved revision (and a **newer draft** marker), and for a skill the model-invocation switch (see [Model invocation and session start](#model-invocation-and-session-start)); columns are this machine's locations, grouped Personal and Projects.
- **Filters.** The chips above the matrix are its legend, each with how many cells are in that state: ✓ **Installed**, ⚠ **Changed outside Kiln**, ↑ **Outdated** (an older approved revision), ◉ **Not managed** (found, but Kiln didn't install it), dashed ↓ **Marked** (in the library's personal installs but not installed here yet; shown only when there are some), ○ **Not installed**, and hatched **Can't install** (approve first, or the location isn't read by the agent's client). Click a chip to show only the items with a cell in that state; chosen chips add up (installed *or* not managed), and the row's other cells fade so the matching ones stand out. A chip with nothing in it can't be chosen. **Model can invoke**, after them, shows only the skills a model may invoke on its own (the library's `is:model-invoked`). **All** clears the chips and **Needs attention** chooses Changed outside Kiln, Outdated and Not managed. Below them, **Filter by name** narrows the rows by title (Esc clears it), **All locations / Personal / Projects** shows or hides the column groups, and **All kinds / Skills / Agents** appears when the library has both. While anything is filtered, the toolbar says how many items are shown with **Clear filters** beside it. Machines remembers the filters until you change them.
- **Cells.** Click one for its state, revision and folder: **Install…**, **Remove**, **Compare…**, **Review…** for changed or unmanaged copies, **Keep these changes** for a changed or different copy (see [The item page](#the-item-page)), **Update to** the approved revision, **Open folder**.
- **Bulk actions**, at the end of the filter row. **Update all outdated** updates Kiln's unchanged copies to the latest approval (edited, different and linked copies are skipped and named; see [Updating installed copies](#updating-installed-copies)), and **Install everything marked for this machine** installs the library's personal installs (`workbench/installs.json`). Both install approved revisions only; anything unapproved or without a matching location is reported. They act on the whole machine, not only the rows the filters show.
- **Locations on this machine** lists enrolled folders with their install receipts, **Stop managing**, **Check drift** (live checks with Compare) and **Recover interrupted installs**. **Add project…** opens the project dialog without an item: pick a project or any folder and a location (Agents, Claude or Copilot) to add its column without installing anything; projects also appear after the first **Install into project…**. Personal locations are set up in **Settings**.

Nothing about this machine is shared: Kiln doesn't write machine reports to your repository. The CLI's `machines status` shows this machine as Machines does; `skills sync` installs the library's personal installs.

## Product boundaries

- The library is local, but desktop onboarding requires a Kiln-created repository connected to GitHub. Approval publishes the reviewed snapshot; this is not an account-free, offline-only product.
- Managed agent runs support Codex and Claude Code. Copilot supports skills and agent-definition import/installation, not built-in experiment execution.
- Automated capture and experiments request read-only access. Item chat has broader file and command access. Agent interactions use the official clients and show a consent notice; normal editing, approval and installation do not invoke a model.
- Local run folders hold private inputs and transcripts. Normal export/publishing excludes reserved session data and machine-specific paths; authored text and arbitrary attachments are not automatically secret-redacted.
- External client hooks can be edited in Config files; Kiln does not execute them itself.
- Usage reads Claude Code's and Codex's session logs on this machine only; Copilot's aren't read, other machines' use isn't combined, and a Codex skill the agent chose itself is inferred from a SKILL.md read. Dollar figures are estimates from list prices, not billing.
- SSH execution and remote deployment are not implemented, and Machines manages this machine only; each computer installs from its own clone of the library. Windows installers are unsigned and the full Windows release matrix is not certified. macOS builds are ad-hoc signed and not notarized; the macOS and Linux builds are new in 0.18.1; the macOS builds have not been tested on a real Mac, and the Linux build has been tried on one Arch Linux desktop.

This is the local workflow release, with GitHub onboarding and standardized migration. See [implementation and verification](IMPLEMENTATION.md) for what has been checked and what remains.

The marketing site is based on these facts. Its interactive skills panel, capture, test run and approval use sample states and condensed library prompts; they do not connect to the visitor’s files, call a model or claim measured outcomes.

## Notes for older libraries and releases

- When an older library opens, legacy session-bearing revisions are archived in machine-private storage and the current item becomes a cleaned, unapproved draft. Local History can still read the original. Existing remote Git history is not rewritten; material published by an older release remains in that history.
- Libraries distilled before the per-kind tabs (Insights, Techniques, Tools, Resources) are re-filed the first time they open.
- `items list` returned detailed metadata by default before 0.16.0; `--full` restores that shape.
- Updates started from an older Kiln release still follow that release's update flow; the two-step Windows update flow starts after installing 0.8.1.
- Performance fixes in 0.2: theme applies immediately and saves outside the work queue; selected-item installation checks inspect one skill; duplicate read requests are shared; unchanged item metadata and Git status are reused; copied observations do not rebuild the index. GitHub checks are explicit, and import previews distinguish pending changes from already imported skills.
