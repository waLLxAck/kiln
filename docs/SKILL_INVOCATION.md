# Skill invocation and what loads at session start

Checked 28 September 2026. Sources are official documentation, plus `openai/codex` source pinned at commit `44fe510c` where the Codex docs are silent. The Codex docs have moved: `developers.openai.com/codex/*` redirects to `learn.chatgpt.com/docs/*`. Kiln's implementation is `packages/domain/invocation.ts` (the switch) and `packages/home/session-start.ts` (the estimate).

Kiln shows whether the model may invoke each skill on its own and lets you turn that off with one click. A skill the model can invoke costs context in every new session: its name and description sit in the listing the harness builds at startup, whether or not it is ever used. A skill only you can invoke costs nothing until you call it by name. Kiln also estimates what each harness loads when a session starts on this machine.

## Summary

| Client | "Only you can invoke it" | Where it lives | Left out of the model's context? |
|---|---|---|---|
| Claude Code | `disable-model-invocation: true` | SKILL.md front-matter | Yes, documented |
| Copilot CLI | `disable-model-invocation: true` | SKILL.md front-matter | Not documented |
| Copilot in VS Code | `disable-model-invocation: true` | SKILL.md front-matter | "Auto-loaded by Copilot: No"; the catalog itself is not documented |
| Codex | `policy.allow_implicit_invocation: false` | `agents/openai.yaml` in the skill folder | Yes (bundled reference and source) |
| Agent Skills standard | none defined | – | The client guide says to hide such skills |

Codex does not read `disable-model-invocation`, and no other client documents reading `agents/openai.yaml`. Kiln therefore writes both when you turn model invocation off.

## Claude Code

### Invocation fields

[Skills](https://code.claude.com/docs/en/skills#control-who-invokes-a-skill): `disable-model-invocation: true` means "Only you can invoke the skill"; `user-invocable: false` means "Only Claude can invoke the skill."

| Front-matter | You can invoke | Claude can invoke | When loaded into context |
|---|---|---|---|
| (default) | Yes | Yes | "Description always in context, full skill loads when invoked" |
| `disable-model-invocation: true` | Yes | No | "Description not in context, full skill loads when you invoke" |
| `user-invocable: false` | No | Yes | "Description always in context, full skill loads when invoked" |

- [Skills](https://code.claude.com/docs/en/skills): "**Hide individual skills** by adding `disable-model-invocation: true` to their frontmatter. This removes the skill from Claude's context entirely." And: "If Claude tries anyway, Claude Code blocks the call".
- [Context window](https://code.claude.com/docs/en/context-window): "Skills with `disable-model-invocation: true` are not in this list. They stay completely out of context until you invoke them with `/name`."
- [Skills](https://code.claude.com/docs/en/skills): `disable-model-invocation` "Also prevents the skill from being preloaded into subagents… Default: `false`."
- Booleans are read loosely: "Boolean fields accept `yes`, `no`, `on`, `off`, `1`, and `0` in any letter case, in addition to `true` and `false`." Kiln reads them the same way.
- Unknown keys are harmless: "Claude Code ignores a field it doesn't recognize without reporting an error."
- `user-invocable: false` does not save context; Kiln shows it as it is and does not change it.

Caveat: claude.ai uploads, the Skills API and `package_skill.py` accept only "`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`"; anything else "fails with a hard error instead of ignoring the field" ([Skills](https://code.claude.com/docs/en/skills#using-skill-frontmatter-outside-claude-code)). A skill with `disable-model-invocation` cannot be uploaded to claude.ai as it is.

### The skill listing

- [Skills](https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short): "Claude Code loads a listing of skill names and descriptions into context… The listing always contains every skill name". The exact format is not documented.
- Budget: "The budget scales at 1% of the model's context window. When the listing overflows, Claude Code drops descriptions starting with the skills you invoke least". Per entry: "each entry's combined text is capped at 1,536 characters regardless of budget." `when_to_use` is "Appended to `description` in the skill listing and counts toward the 1,536-character cap."
- Settings: `skillListingBudgetFraction` (default `0.01`) and `skillListingMaxDescChars` (default `1536`) in the [settings reference](https://code.claude.com/docs/en/settings-reference#skilllistingmaxdescchars); `SLASH_COMMAND_TOOL_CHAR_BUDGET` fixes a character count.
- [Skills](https://code.claude.com/docs/en/skills#find-unused-skills): "Every skill in the skill listing adds to your context on every turn, whether or not Claude ever uses it." `/doctor` and `/context` report the listing's cost.
- Legacy command files in `.claude/commands/` take the same front-matter ([Skills](https://code.claude.com/docs/en/skills#where-skills-live)).

### Settings that hide skills

- [`skillOverrides`](https://code.claude.com/docs/en/settings-reference#skilloverrides): `"on"`, `"name-only"` ("Claude sees the skill by name without its description"), `"user-invocable-only"` ("Claude doesn't see the skill, but you can still type `/name`") and `"off"`. "Overrides don't apply to plugin skills." The estimate honours these in `~/.claude/settings.json` and a project's `.claude/settings.json` and `.claude/settings.local.json`.
- Permission rules can deny the Skill tool, or `Skill(name)` for one skill. Kiln does not read them.

### Where skills live

`~/.claude/skills/<name>/SKILL.md`, `.claude/skills/…`, nested `.claude/skills` folders, `--add-dir`, plugins and managed settings ([Skills](https://code.claude.com/docs/en/skills#where-skills-live)). Not `.agents/skills`: [Memory](https://code.claude.com/docs/en/memory#agents-md) says Claude Code does not read "anything under a `.agents/` directory".

### What else loads at session start

- **CLAUDE.md** ([Memory](https://code.claude.com/docs/en/memory)): "Claude reads them at the start of every session." `~/.claude/CLAUDE.md`, `./CLAUDE.md` or `./.claude/CLAUDE.md`, `./CLAUDE.local.md`; "CLAUDE.md and CLAUDE.local.md files in the directory hierarchy above the working directory are loaded at launch. Files in subdirectories load on demand". Up to 4 MiB per file.
- **Imports**: "Imported files are expanded and loaded into context at launch", "a maximum depth of four hops."
- **Rules**: "Rules without `paths` frontmatter are loaded at launch with the same priority as `.claude/CLAUDE.md`." `~/.claude/rules/` applies everywhere.
- **AGENTS.md**: "By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in your working directory or above it" (v2.1.277+).
- **Auto memory** ([Memory](https://code.claude.com/docs/en/memory#auto-memory)): "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation." The folder is `~/.claude/projects/<project>/memory/`; Kiln derives `<project>` from the path with every other character replaced by `-`, which is observed, not documented.
- **SessionStart hooks** ([Hooks](https://code.claude.com/docs/en/hooks#sessionstart-decision-control)): "Claude Code adds stdout it treats as plain text to Claude's context"; output is "capped at 10,000 characters".
- **MCP** ([MCP](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)): "Only tool names and server instructions load at session start"; tool search is on by default.
- **Output styles** ([Output styles](https://code.claude.com/docs/en/output-styles)) add instructions for every response.
- **System prompt**: no published size. The [context window](https://code.claude.com/docs/en/context-window) simulation's 4,200 tokens are labelled "illustrative".

## OpenAI Codex

### The switch: `agents/openai.yaml`

[Build skills](https://learn.chatgpt.com/docs/build-skills) documents the file "to configure UI metadata…, to set invocation policy, and to declare tool dependencies":

```yaml
policy:
  allow_implicit_invocation: false
```

"`allow_implicit_invocation` (default: `true`): When `false`, Codex won't implicitly invoke the skill based on user prompt; explicit `$skill` invocation still works."

It also leaves the listing: the bundled [`openai_yaml.md`](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/skills/src/assets/samples/skill-creator/references/openai_yaml.md) says "When false, the skill is not injected into the model context by default, but can still be invoked explicitly via `$skill`". The source agrees ([`host.rs`](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/ext/skills/src/provider/host.rs#L147): `if !skill.allows_implicit_invocation() { entry = entry.hidden_from_prompt(); }`).

SKILL.md: "must include `name` and `description`". The parser reads only `name`, `description` and `metadata.short-description` ([`parser.rs`](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/skills/src/parser.rs)), so `disable-model-invocation` means nothing to Codex.

### The skill listing

- [Build skills](https://learn.chatgpt.com/docs/build-skills): "the initial list also includes each skill's file path… this list uses at most 2% of the model's context window, or 8,000 characters when the context window is unknown. If many skills are installed, Codex shortens skill descriptions first."
- Line format ([`render.rs`](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/ext/skills/src/render.rs#L263)): `- {name}: {description} ({locator_kind}: {locator})`, `file` for local skills; descriptions are cut at 1,024 characters.
- Locations: `.agents/skills` "in every directory from your current working directory up to the repository root", `~/.agents/skills`, `/etc/codex/skills` and bundled system skills. `~/.codex/skills` is not in the docs but the source still reads it as a "Deprecated user skills location" ([`host_roots.rs`](https://github.com/openai/codex/blob/44fe510ce3ee61c8ef623adcbf89b901c73ddd61/codex-rs/ext/skills/src/host_roots.rs#L96)).
- Disabling without deleting: `[[skills.config]]` with `path` (or `name`) and `enabled = false` in `~/.codex/config.toml` ([Build skills](https://learn.chatgpt.com/docs/build-skills)). The estimate honours it.

### What else loads at session start

- **AGENTS.md** ([AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md)): `~/.codex/AGENTS.override.md`, else `AGENTS.md`; then from the project root down to the working directory, "at most one file per directory", stopping at `project_doc_max_bytes` ("32 KiB by default"). The advanced config page calls that limit per file; Kiln applies it to the project files combined, as the guide says.
- **Hooks** ([Hooks](https://learn.chatgpt.com/docs/hooks)): `~/.codex/hooks.json`, `config.toml`, and the project's `.codex/` equivalents. SessionStart: "Plain text on `stdout` is added as extra developer context", limited to "roughly 2,500 tokens" per message by default.
- **MCP** ([MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)): `[mcp_servers.*]` in `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Whether tool definitions load at start is not documented.
- **System prompt**: no published size.

## GitHub Copilot

- **Copilot CLI** ([CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#skills-reference)): `user-invocable` ("Whether users can invoke the skill with `/SKILL-NAME`. Default: `true`") and `disable-model-invocation` ("Prevent the agent from automatically invoking this skill. Default: `false`"). Whether such a skill stays in the model's catalog is not documented. Locations: `.github/skills/`, `.agents/skills/`, `.claude/skills/` in the project; `~/.copilot/skills/` and `~/.agents/skills/` personally (not `~/.claude/skills`). Instructions: `CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `.github/instructions/**/*.instructions.md` and `.github/copilot-instructions.md` in the Git root and working directory, plus `~/.copilot/copilot-instructions.md`, "all are merged". Hooks: `sessionStart` "can inject `additionalContext`" ([Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)). No skills budget is documented.
- **VS Code** ([Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)): `disable-model-invocation: true` "require[s] manual invocation through the `/` slash command only" ("Auto-loaded by Copilot: No"). It reads `.github/skills/`, `.claude/skills/`, `.agents/skills/` and the personal `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, so a flag written for Claude reaches VS Code as well. Kiln does not estimate VS Code sessions.

## Agent Skills standard

The [specification](https://agentskills.io/specification) has no invocation field (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`). "**Metadata** (~100 tokens): The `name` and `description` fields are loaded at startup for all skills". The [client guide](https://agentskills.io/client-implementation/adding-skills-support): "Each skill adds roughly 50-100 tokens to the catalog", and clients should exclude a skill that "has opted out of model-driven activation (e.g., via a `disable-model-invocation` flag)" and "**Hide filtered skills entirely** from the catalog".

## The shared `.agents/skills` folder

Codex, Copilot CLI and VS Code read it (see above); Claude Code does not. Consequences:

- A SKILL.md flag reaches every client that understands it: in `.agents/skills` that is Copilot CLI and VS Code together; they cannot differ within one folder.
- `agents/openai.yaml` is Codex-only, "an extended, product-specific config intended for the machine/harness to read".
- The Claude folders are shared too: `~/.claude/skills` is also read by VS Code, and a project's `.claude/skills` by Copilot CLI and VS Code.

## Estimating tokens

- Anthropic ([Glossary](https://platform.claude.com/docs/en/about-claude/glossary)): "For Claude, a token approximately represents 3.5 English characters". Newer models "use a newer tokenizer. The same input text produces approximately 30 percent more tokens" ([Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)).
- OpenAI ([Key concepts](https://developers.openai.com/api/docs/concepts)): "1 token is approximately 4 characters". Codex itself estimates 4 bytes per token (`APPROX_BYTES_PER_TOKEN`).

## Kiln behaviour

- **The switch edits the skill.** Turning model invocation off sets `disable-model-invocation: true` at the end of SKILL.md's front-matter and `policy.allow_implicit_invocation: false` in `agents/openai.yaml` (creating the file when needed). Turning it on removes those lines (an explicit `false` in SKILL.md stays), then an emptied `policy:` block and a file left empty. Nothing else changes: key order, comments, quoting, line endings and a byte-order mark are kept. A value written over several lines, or `policy` as a one-line mapping, is refused with a message to edit it by hand.
- **Approval.** The change is a new revision ("Model invocation turned off"). When the current revision is approved on this machine, Kiln checks that the two revisions are identical once the flag lines are taken out of both (every bundled file included) and records an approval of the new one as reviewer `Kiln`, with the earlier approval's scope, evidence and waived checks and `carriedFrom` naming it. It is committed and pushed like any approval. A draft newer than the approval is edited and stays a draft.
- **Installed copies** are then updated through the usual update: Kiln's unchanged copies get the new approved revision; edited, unmanaged and linked copies are skipped and named. Installed bytes equal the approved revision, so drift checks need nothing special.
- **Session-start estimate.** Per harness: the skills it lists (entry text as above, left out when the flag, `skillOverrides` or `[[skills.config]]` say so; a name found twice is counted once), instruction files (Claude imports resolved up to four hops), SessionStart hooks listed but never run, MCP servers counted but not sized, and what cannot be known. Tokens are characters ÷ 3.5 for Claude Code and ÷ 4 for Codex and Copilot CLI, shown as estimates. Plugin skills, Codex's system skills, the system prompt and hook output are not counted.
