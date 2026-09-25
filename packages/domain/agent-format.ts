import { parse as yaml } from 'yaml';
import { parse as toml } from 'smol-toml';
import type { Authoring, ProviderId, Target } from '../protocol/schema';

export const agentFolder = (provider: ProviderId, scope: Target['scope'] = 'personal') => provider === 'copilot' ? (scope === 'personal' ? '.copilot/agents' : '.github/agents') : `.${provider}/agents`;
export function agentMetadata(content: string, provider: ProviderId): Record<string, unknown> {
  const value = provider === 'codex' ? toml(content) : yaml(content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Add an agent definition with name and description.');
  return value as Record<string, unknown>;
}
export function validateAgent(value: Pick<Authoring, 'agent' | 'content' | 'files'>): string[] {
  if (!value.agent) return ['Choose the agent client and filename.'];
  const { provider, filename } = value.agent;
  const problems: string[] = [];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:md|toml)$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(filename) || !(provider === 'codex' ? filename.endsWith('.toml') : filename.endsWith('.md'))) problems.push('Use a plain .toml filename for Codex or .md filename for Claude and Copilot.');
  if (Object.keys(value.files).length) problems.push('Agent definitions are single files. Keep supporting resources in skills.');
  try {
    const meta = agentMetadata(value.content, provider);
    for (const key of provider === 'codex' ? ['name', 'description', 'developer_instructions'] : provider === 'claude' ? ['name', 'description'] : ['description']) {
      if (typeof meta[key] !== 'string' || !(meta[key] as string).trim()) problems.push(`Add the agent’s ${key}.`);
    }
    if (provider === 'claude' && typeof meta.name === 'string' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name)) problems.push('Claude agent names must use lowercase words separated by hyphens.');
  } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  return problems;
}
