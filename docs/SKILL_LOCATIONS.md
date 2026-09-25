# Skill locations and client compatibility

Checked 8 September 2026. The source-linked compatibility list displayed in Settings is maintained in `packages/providers/skill-locations.ts`.

Kiln shows physical installation locations: **Agents** (`.agents/skills`) and **Claude** (`.claude/skills`). These are not exclusive access boundaries. For example, [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills) reads personal `.agents/skills` even without `.copilot/skills`. [VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills) also reads personal `.claude/skills`. An absent CLI executable or native directory is not evidence that a skill is unavailable.

## Verified native readers

Personal and project shared directories are documented by Codex, Copilot CLI, Copilot in VS Code, Cursor, Gemini CLI, OpenCode, Amp, Roo Code, Crush, Kimi Code CLI, Goose, Zed Agent and Warp. OpenClaw reads the project directory; its personal shared directory depends on the default state directory. Each client has a primary-source link and qualification in the Settings list. No inference is made about remote/cloud workers inheriting local personal skills.

The [Agent Skills implementation guidance](https://agentskills.io/client-implementation/adding-skills-support) distinguishes discovery from the SKILL.md format. Supporting the format alone does not prove a client searches this directory. Runtime loading can depend on version, trust, permissions, disabled skills and precedence.

## Wider installer convention

The [Vercel skills installer registry](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) additionally routes project installations through `.agents/skills` for Antigravity, Antigravity CLI, Cline, Deep Agents, Dexto, Firebender, Loaf, Replit and PromptScript. Its Universal target also uses that directory. This is evidence about installation routing, not verified automatic loading of personal shared skills by every client; global destinations vary. These tools are not presented as confirmed personal readers in Settings. This audit is dated and is not a claim to cover every future harness.

## Kiln behavior

- Settings lists the skill path and the explicitly named client agent-definition path. Native agent definitions retain their format; there is no implied universal `.agents/agents` convention.
- Shared and Claude installation buttons stay visible. Codex-specific and Copilot-specific copies appear in one disclosure with exact paths and comparison status. Discovery checks all four standard skill locations beneath configured homes/projects, deduplicating paths.
- Existing Codex target IDs, receipts and desired-install tokens still mean `.agents/skills`, preserving previous installs. Optional native Codex targets carry `skillFolder: ".codex/skills"` and the distinct desired token `codex-native`. Older Kiln versions do not understand that new token; use this release on machines syncing native copies.
- Missing targets are not enrolled automatically. Imported skills and agent definitions remain drafts. No copy is duplicated merely to make a client's badge green.
- Broken links remain visible/removable even when their destination is gone. Discovery can remove broken links and truly empty folders, rechecking at removal time. Nonempty folders and working links are preserved. Removing one location never follows links to delete another location's files.
