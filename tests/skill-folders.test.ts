import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Provider, Target } from '../packages/protocol/schema';
import { unmanagedSourceFolders } from '../apps/desktop/src/skill-folders';

const providers = (['codex', 'claude', 'copilot'] as const).map(id => ({ id, personalRoot: '/home/ada' })) as Provider[];
const target = (provider: Target['provider'], extra: Partial<Target> = {}) => ({ id: provider, name: provider, provider, root: '/home/ada', scope: 'personal', profile: 'Personal', machine: 'local', ...extra }) as Target;

test('imported skills point at the personal folders Kiln does not manage yet, once each', () => {
  const paths = ['/home/ada/.claude/skills/review', '/home/ada/.claude/skills/deploy', '/home/ada/.agents/skills/notes', '/home/ada/.codex/skills/.system/skill-creator', '/home/ada/elsewhere/skill'];
  assert.deepEqual(unmanagedSourceFolders(paths, providers, []).map(f => [f.location, f.folder]), [['agents', '/home/ada/.agents/skills'], ['claude', '/home/ada/.claude/skills']],
    'nested .system skills and folders outside the personal locations are not offered');
  assert.deepEqual(unmanagedSourceFolders(paths, providers, [target('claude')]).map(f => f.location), ['agents'], 'a managed folder is not offered again');
  assert.deepEqual(unmanagedSourceFolders(['/home/ada/.codex/skills/review'], providers, [target('codex')]).map(f => [f.location, f.native]), [['codex', true]], 'the Codex-specific folder is separate from Agents');
  assert.deepEqual(unmanagedSourceFolders(['C:\\Users\\Ada\\.claude\\skills\\review'], [{ id: 'claude', personalRoot: 'C:\\Users\\Ada' } as Provider], []).map(f => f.location), ['claude'], 'Windows paths');
  assert.deepEqual(unmanagedSourceFolders([], providers, []), []);
});
