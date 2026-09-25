import type { ProviderId, Target } from '../protocol/schema';

export type SkillLocation = 'agents' | 'claude' | 'codex' | 'copilot';
export const skillLocationLabel: Record<SkillLocation, string> = { agents: 'Agents', claude: 'Claude', codex: 'Codex-specific', copilot: 'Copilot-specific' };
/** Existing Codex targets have always written .agents/skills. Keep their paths and receipts unchanged. */
export const skillLocation = (target: Pick<Target, 'provider' | 'skillFolder'>): SkillLocation => target.skillFolder === '.codex/skills' ? 'codex' : target.provider === 'codex' ? 'agents' : target.provider;
export const locationFolder = (location: SkillLocation, scope: Target['scope'] = 'personal') => location === 'copilot' && scope === 'project' ? '.github/skills' : `.${location}/skills`;
export const targetSkillsFolder = (target: Pick<Target, 'provider' | 'scope' | 'skillFolder'>) => locationFolder(skillLocation(target), target.scope);
export const primarySkillLabel = (provider: ProviderId) => provider === 'codex' ? 'Agents' : provider === 'claude' ? 'Claude' : 'Copilot-specific';

export const compatibilityChecked = '2026-09-08';
export const sharedSkillReaders = [
  { name: 'Codex', url: 'https://learn.chatgpt.com/docs/build-skills', note: 'Personal and project .agents/skills; repository ancestors are searched.' },
  { name: 'GitHub Copilot CLI', url: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills', note: 'Personal and project .agents/skills. Separate .copilot/skills and .github/skills are optional.' },
  { name: 'Copilot in VS Code', url: 'https://code.visualstudio.com/docs/agent-customization/agent-skills', note: 'Personal and project .agents/skills; also reads .claude/skills.' },
  { name: 'Cursor', url: 'https://cursor.com/docs/skills', note: 'Personal and project .agents/skills. Personal shared skills are not automatically copied to cloud or remote workers.' },
  { name: 'Gemini CLI', url: 'https://geminicli.com/docs/cli/using-agent-skills/', note: 'Personal and workspace .agents/skills aliases. Workspace trust and skill settings apply.' },
  { name: 'OpenCode', url: 'https://opencode.ai/docs/skills', note: 'Personal and project .agents/skills and .claude/skills; permissions can hide skills.' },
  { name: 'Amp', url: 'https://ampcode.com/docs/customize/skills', note: 'Personal and project .agents/skills; other locations can take precedence.' },
  { name: 'Roo Code', url: 'https://docs.roocode.com/features/skills', note: 'Personal and project .agents/skills; Roo-specific locations take precedence.' },
  { name: 'Crush', url: 'https://github.com/charmbracelet/crush#agent-skills', note: 'Personal and project .agents/skills; also reads .claude/skills.' },
  { name: 'Kimi Code CLI', url: 'https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html', note: 'Personal and project .agents/skills alongside Kimi-specific directories.' },
  { name: 'OpenClaw', url: 'https://docs.openclaw.ai/tools/skills', note: 'Project .agents/skills; personal .agents/skills only with the default state directory.' },
  { name: 'Goose', url: 'https://github.com/block/goose/blob/main/crates/goose/src/skills/mod.rs', note: 'Personal and project .agents/skills are canonical skill locations.' },
  { name: 'Zed Agent', url: 'https://zed.dev/docs/ai/skills', note: 'Personal and worktree .agents/skills; flat layout only, project trust required.' },
  { name: 'Warp', url: 'https://docs.warp.dev/agents/capabilities/skills/', note: 'Personal and project .agents/skills are recommended; also reads client-specific directories.' },
] as const;
