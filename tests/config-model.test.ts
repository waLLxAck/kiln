import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHook, addRule, checkRule, countSettingsChanges, isClaudeSettings, moveRule, parseSettings, purposeOf, removeHook, removeRule, scopeName, updateHook } from '../apps/desktop/src/configModel';

const settings = (text: string) => { const parsed = parseSettings(text); assert.ok(parsed.ok); return parsed.settings; };
const sample = `{
    "$schema": "https://json.schemastore.org/claude-code-settings.json",
    "model": "opus",
    "permissions": {
        "allow": [
            "Bash(npm test:*)"
        ],
        "deny": [
            "Read(./.env)"
        ],
        "defaultMode": "acceptEdits"
    },
    "hooks": {
        "PostToolUse": [
            {
                "matcher": "Edit|Write",
                "hooks": [
                    { "type": "command", "command": "npm run lint", "timeout": 30 }
                ]
            }
        ]
    },
    "env": { "FOO": "1" }
}
`;

test('permission edits keep unknown keys, key order and the file’s indentation', () => {
  let text = addRule(sample, 'ask', 'Bash(git push:*)');
  const data = JSON.parse(text);
  assert.deepEqual(Object.keys(data), ['$schema', 'model', 'permissions', 'hooks', 'env']);
  // The new list sits between allow and deny, and uses the same four-space indent.
  assert.deepEqual(Object.keys(data.permissions), ['allow', 'ask', 'deny', 'defaultMode']);
  assert.match(text, /\n {8}"ask": \[\n {12}"Bash\(git push:\*\)"\n {8}\]/);
  text = moveRule(text, 'ask', 'allow', 'Bash(git push:*)');
  assert.deepEqual(settings(text).rules, { allow: ['Bash(npm test:*)', 'Bash(git push:*)'], ask: [], deny: ['Read(./.env)'] });
  text = removeRule(text, 'deny', 'Read(./.env)');
  assert.deepEqual(JSON.parse(text).permissions.deny, []);
  assert.equal(JSON.parse(text).permissions.defaultMode, 'acceptEdits');
  assert.deepEqual(settings(text).otherPermissions, ['defaultMode']);
  assert.match(text, /"env": \{ "FOO": "1" \}/);
});

test('permissions are created in an empty settings file', () => {
  const text = addRule('{}\n', 'deny', 'Read(.env)');
  assert.deepEqual(JSON.parse(text), { permissions: { deny: ['Read(.env)'] } });
});

test('rule check catches bad formats and duplicates in any column', () => {
  const rules = { allow: ['Bash(npm test:*)'], ask: [], deny: ['Read(./.env)'] };
  assert.equal(checkRule('Bash(npm run build:*)', rules), null);
  assert.equal(checkRule('mcp__github__create_issue', rules), null);
  assert.equal(checkRule('WebFetch(domain:example.com)', rules), null);
  assert.match(checkRule('npm test', rules)!, /Tool\(pattern\)/);
  assert.match(checkRule('Bash(', rules)!, /Tool\(pattern\)/);
  assert.equal(checkRule('Read(./.env)', rules), 'Already in Deny');
});

test('hook edits add, change and remove rows and keep other hook fields', () => {
  const rows = () => settings(text).hooks!;
  let text = addHook(sample, { event: 'PostToolUse', matcher: 'Edit|Write', command: 'npm run format' });
  assert.equal(JSON.parse(text).hooks.PostToolUse[0].hooks.length, 2, 'joins the group with the same matcher');
  text = addHook(text, { event: 'Stop', matcher: '', command: 'say done' });
  assert.deepEqual(JSON.parse(text).hooks.Stop, [{ hooks: [{ type: 'command', command: 'say done' }] }]);
  const lint = rows().find(row => row.command === 'npm run lint')!;
  text = updateHook(text, lint, { event: 'PostToolUse', matcher: 'Edit|Write', command: 'npm run lint --silent' });
  assert.equal(JSON.parse(text).hooks.PostToolUse[0].hooks[0].timeout, 30);
  const edited = rows().find(row => row.command === 'npm run lint --silent')!;
  text = updateHook(text, edited, { event: 'PreToolUse', matcher: 'Bash', command: 'npm run lint --silent' });
  assert.deepEqual(JSON.parse(text).hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint --silent', timeout: 30 }] }]);
  for (const row of [...rows()].reverse()) text = removeHook(text, row);
  assert.deepEqual(JSON.parse(text).hooks, {});
  assert.match(text, /"hooks": \{\}/);
});

test('invalid JSON and unexpected shapes are reported, not edited', () => {
  const broken = parseSettings('{\n  "permissions": {\n    "allow": [\n  }\n}');
  assert.ok(!broken.ok); assert.match(broken.error, /line 4/);
  assert.ok(!parseSettings('[]').ok);
  const odd = settings('{"permissions": {"allow": "Bash"}, "hooks": {"Stop": "x"}}');
  assert.equal(odd.rules, null); assert.match(odd.rulesProblem!, /permissions.allow/);
  assert.equal(odd.hooks, null); assert.ok(odd.hooksProblem);
});

test('change count treats a move or an edit as one change', () => {
  const before = settings(sample);
  assert.equal(countSettingsChanges(before, settings(moveRule(sample, 'allow', 'ask', 'Bash(npm test:*)'))), 1);
  const row = before.hooks![0];
  assert.equal(countSettingsChanges(before, settings(updateHook(sample, row, { ...row, command: 'x' }))), 1);
  assert.equal(countSettingsChanges(before, settings(addRule(addRule(sample, 'deny', 'Bash(rm:*)'), 'ask', 'Bash(git push:*)'))), 2);
});

test('files are classified by purpose, and Claude settings files are recognised', () => {
  assert.equal(purposeOf({ kind: 'claude', path: '/h/.claude/CLAUDE.md' }), 'instructions');
  assert.equal(purposeOf({ kind: 'copilot', path: '/p/.github/mcp.json' }), 'mcp');
  assert.equal(purposeOf({ kind: 'copilot', path: '/h/.copilot/mcp-config.json' }), 'mcp');
  assert.equal(purposeOf({ kind: 'agents', path: '/p/.mcp.json' }), 'mcp');
  assert.equal(purposeOf({ kind: 'codex', path: '/h/.codex/hooks.json' }), 'hooks');
  assert.equal(purposeOf({ kind: 'copilot', path: '/p/.github/hooks/session.json' }), 'hooks');
  assert.equal(purposeOf({ kind: 'codex', path: '/h/.codex/config.toml' }), 'settings');
  assert.equal(purposeOf({ kind: 'powershell', path: 'C:\\Users\\me\\profile.ps1' }), 'profile');
  assert.ok(isClaudeSettings({ kind: 'claude', path: '/h/.claude/settings.json' }));
  assert.ok(isClaudeSettings({ kind: 'claude', path: '/p/.claude/settings.local.json' }));
  assert.ok(isClaudeSettings({ kind: 'claude', path: '/custom/dir/settings.json', key: 'claude-settings' }));
  assert.ok(!isClaudeSettings({ kind: 'copilot', path: '/h/.copilot/settings.json' }));
  assert.ok(!isClaudeSettings({ kind: 'claude', path: '/h/.claude.json' }));
  assert.equal(scopeName('Project · /home/me/orders-api'), 'orders-api');
  assert.equal(scopeName('Project · C:\\code\\app\\'), 'app');
  assert.equal(scopeName(undefined), 'Personal');
});
