/** Pure helpers for the code editor: which language a file is, and its line breaks. */

export type CodeLanguage = 'markdown' | 'json' | 'jsonc' | 'yaml' | 'toml' | 'shell' | 'powershell' | 'python' | 'javascript' | 'typescript' | 'plain';

/**
 * The editor language for a file name or path. JSON gets comments (VS Code's "JSON with comments") for `.jsonc`,
 * VS Code and dev-container settings, tsconfig/jsconfig, or when the caller knows the file allows them.
 */
export function languageFor(name: string, options: { comments?: boolean } = {}): CodeLanguage {
  const lower = name.toLowerCase().replaceAll('\\', '/'), base = lower.slice(lower.lastIndexOf('/') + 1);
  if (/\.(md|markdown|mdx)$/.test(base)) return 'markdown';
  if (base.endsWith('.jsonc') || (base.endsWith('.json') && (options.comments || /(^|\/)\.(vscode|devcontainer)\//.test(lower) || /^(ts|js)config.*\.json$/.test(base) || base === 'devcontainer.json'))) return 'jsonc';
  if (/\.(json|json5)$/.test(base)) return 'json';
  if (/\.ya?ml$/.test(base)) return 'yaml';
  if (base.endsWith('.toml')) return 'toml';
  if (/\.(sh|bash|zsh)$/.test(base) || ['.bashrc', '.bash_profile', '.bash_aliases', '.profile', '.zshrc', '.zprofile', '.zshenv'].includes(base)) return 'shell';
  if (/\.ps[md]?1$/.test(base)) return 'powershell';
  if (base.endsWith('.py')) return 'python';
  if (/\.(js|mjs|cjs|jsx)$/.test(base)) return 'javascript';
  if (/\.(ts|mts|cts|tsx)$/.test(base)) return 'typescript';
  return 'plain';
}

/** The language of an item's main content: Codex agents are TOML, links and references are plain text, the rest Markdown. */
export const itemLanguage = (item: { kind: string; agent?: { provider: string } | null }): CodeLanguage =>
  item.kind === 'agent' && item.agent?.provider === 'codex' ? 'toml' : ['link', 'reference'].includes(item.kind) ? 'plain' : 'markdown';

/**
 * The line break the editor must keep so an untouched file reads back byte for byte: none when the text has no carriage
 * returns (the editor's default, which also tidies pasted Windows text), CRLF when every break is CRLF, and LF for a file
 * that mixes them, so the stray carriage returns stay where they are.
 */
export function lineSeparatorFor(text: string): '\r\n' | '\n' | null {
  if (!text.includes('\r')) return null;
  return !/(^|[^\r])\n/.test(text) && !/\r(?!\n)/.test(text) ? '\r\n' : '\n';
}
