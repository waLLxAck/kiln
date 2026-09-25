import fs from 'node:fs';
import path from 'node:path';
import { digest, noLinks } from '../storage/files';

export type ConfigKind = 'claude' | 'agents' | 'codex' | 'copilot' | 'vscode';
export type ConfigEntry = { key: string; kind: ConfigKind; label: string; description: string; path: string; removable: boolean; scope: string; template: string; instruction: boolean };
export function configCatalog(home: string, projects: string[], env: NodeJS.ProcessEnv): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  const add = (key: string, kind: ConfigKind, root: string, relative: string, description: string, scope = 'Personal', template?: string) => {
    const file = path.join(root, relative), instruction = file.endsWith('.md');
    entries.push({ key, kind, label: relative, description, path: file, scope, removable: false, instruction, template: template ?? (instruction ? '# Instructions\n\n' : file.endsWith('.json') ? '{}\n' : '# Configuration\n') });
  };
  const discover = (kind: ConfigKind, root: string, relative: string, suffix: RegExp, description: string, scope: string) => {
    const folder = path.join(root, relative);
    try {
      noLinks(folder);
      if (!fs.existsSync(folder)) return;
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isFile() && suffix.test(entry.name)) add(`file-${digest(path.join(folder, entry.name)).slice(0, 24)}`, kind, folder, entry.name, description, scope);
      }
    } catch { /* Missing or inaccessible optional directories do not hide the fixed entries. */ }
  };
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  const copilot = env.COPILOT_HOME || path.join(home, '.copilot');
  add('claude-global', 'claude', claude, 'CLAUDE.md', 'Personal Claude instructions. @path imports another instruction file.');
  add('agents-home', 'agents', home, 'AGENTS.md', 'Home-directory instructions. Discovery depends on the client and working directory; this is not automatically global for every agent.');
  add('codex-global', 'codex', codex, 'AGENTS.md', 'Personal Codex instructions; AGENTS.override.md takes precedence when present.');
  add('codex-override', 'codex', codex, 'AGENTS.override.md', 'Overrides personal AGENTS.md when non-empty.');
  add('claude-settings', 'claude', claude, 'settings.json', 'Claude permissions, session hooks, plugins and other personal settings.');
  add('claude-state', 'claude', home, '.claude.json', 'Claude-managed sign-in, MCP and project trust state. Prefer the official client for account changes.');
  add('codex-settings', 'codex', codex, 'config.toml', 'Codex approvals, sandbox, models, MCP servers and developer instructions. Project and session overrides can take precedence.');
  add('codex-hooks', 'codex', codex, 'hooks.json', 'Codex session and tool hooks. Supported events and trust requirements depend on the installed client.', 'Personal', '{\n  "hooks": {}\n}\n');
  add('copilot-global', 'copilot', copilot, 'copilot-instructions.md', 'Personal instructions for Copilot CLI. IDE support differs.');
  add('copilot-settings', 'copilot', copilot, 'settings.json', 'Copilot CLI settings, permissions and inline hooks. Older clients stored settings in config.json.');
  add('copilot-state', 'copilot', copilot, 'config.json', 'Legacy settings and CLI-managed account/plugin state. Prefer the official client for account changes.');
  add('copilot-permissions', 'copilot', copilot, 'permissions-config.json', 'Saved tool and directory permissions per project. Close Copilot sessions before changing this file.');
  add('copilot-mcp', 'copilot', copilot, 'mcp-config.json', 'Personal MCP servers for Copilot CLI.');
  add('copilot-lsp', 'copilot', copilot, 'lsp-config.json', 'Personal language-server configuration for Copilot CLI.');
  if (env.APPDATA) add('vscode-settings', 'vscode', env.APPDATA, 'Code/User/settings.json', 'VS Code user settings, including Copilot access and tool settings. Named profiles and other editors can be added separately.');
  discover('codex', codex, '.', /\.config\.toml$/, 'Named Codex configuration profile.', 'Personal');
  discover('codex', codex, 'rules', /\.rules$/, 'Codex command execution rules.', 'Personal');
  discover('claude', claude, 'rules', /\.md$/, 'Claude instruction rules.', 'Personal');
  discover('copilot', copilot, 'hooks', /\.json$/, 'Copilot personal hooks.', 'Personal');
  for (const root of projects) {
    const scope = `Project · ${root}`, prefix = `project-${digest(root).slice(0, 16)}`;
    const files: [ConfigKind, string, string][] = [
      ['agents', 'AGENTS.md', 'Project instructions for clients that support AGENTS.md.'],
      ['codex', 'AGENTS.override.md', 'Overrides AGENTS.md in this directory for Codex.'],
      ['claude', 'CLAUDE.md', 'Claude project instructions.'],
      ['claude', '.claude/CLAUDE.md', 'Additional Claude project instructions.'],
      ['claude', '.claude/settings.json', 'Shared project permissions and session hooks.'],
      ['claude', '.claude/settings.local.json', 'Personal project overrides. Keep this file out of Git.'],
      ['codex', '.codex/config.toml', 'Project Codex settings; loaded only for trusted projects.'],
      ['codex', '.codex/hooks.json', 'Project Codex hooks; client trust requirements apply.'],
      ['agents', '.mcp.json', 'Project MCP servers for clients supporting this file.'],
      ['copilot', '.github/copilot-instructions.md', 'Repository-wide Copilot instructions.'],
      ['copilot', '.github/copilot/settings.json', 'Copilot CLI shared project settings and inline hooks.'],
      ['copilot', '.github/copilot/settings.local.json', 'Copilot CLI personal project overrides. Keep out of Git.'],
      ['copilot', '.github/mcp.json', 'Copilot CLI project MCP servers.'],
      ['copilot', '.github/hooks/hooks.json', 'Copilot repository hooks. CLI and cloud agent events differ.'],
      ['vscode', '.vscode/settings.json', 'VS Code workspace settings, including Copilot configuration.'],
      ['vscode', '.vscode/mcp.json', 'VS Code workspace MCP servers.'],
    ];
    files.forEach(([kind, relative, description], i) => add(`${prefix}-${i}`, kind, root, relative, description, scope, relative === '.github/hooks/hooks.json' ? '{\n  "version": 1,\n  "hooks": {}\n}\n' : undefined));
    for (const [kind, relative, suffix] of [['copilot', '.github/hooks', /\.json$/], ['copilot', '.github/instructions', /\.instructions\.md$/], ['claude', '.claude/rules', /\.md$/], ['codex', '.codex/rules', /\.rules$/]] as const) discover(kind, root, relative, suffix, 'Project customization file. See the file for its conditions and scope.', scope);
  }
  return entries.filter((entry, i) => entries.findIndex(other => other.path === entry.path) === i);
}
