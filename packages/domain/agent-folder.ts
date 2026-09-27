import type { ProviderId, Target } from '../protocol/schema';

/** Where a client keeps agent definitions. Separate from agent-format so the renderer can use it without the YAML and TOML parsers. */
export const agentFolder = (provider: ProviderId, scope: Target['scope'] = 'personal') => provider === 'copilot' ? (scope === 'personal' ? '.copilot/agents' : '.github/agents') : `.${provider}/agents`;
