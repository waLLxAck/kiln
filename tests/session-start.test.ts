import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStartMeter, type HarnessContext } from '../packages/home/session-start';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { HomeFiles } from '../packages/home/service';

// What each harness loads when a session starts, estimated from files on this machine; nothing is run.
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (name: string, description: string, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\nBody that never loads at start.\n`;
function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-session-start-'));
  const h = path.join(root, 'home'), project = path.join(root, 'work', 'game');
  write(path.join(h, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'Review a change before merging.', 'when_to_use: Asked to review.\n'));
  write(path.join(h, '.claude', 'skills', 'release', 'SKILL.md'), skill('release', 'Cut a release.', 'disable-model-invocation: true\n'));
  write(path.join(h, '.claude', 'skills', 'notes', 'SKILL.md'), skill('notes', 'Take meeting notes.'));
  write(path.join(h, '.claude', 'commands', 'deploy.md'), '---\ndescription: Deploy the app.\n---\nRun the deploy.\n');
  write(path.join(h, '.claude', 'CLAUDE.md'), '# Personal\nSee @~/.claude/extra.md and `@not-an-import`.\n');
  write(path.join(h, '.claude', 'extra.md'), 'Imported text.\n');
  write(path.join(h, '.claude', 'rules', 'always.md'), 'Always rule.\n');
  write(path.join(h, '.claude', 'rules', 'scoped.md'), '---\npaths: ["src/**"]\n---\nOnly for src.\n');
  write(path.join(h, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { notes: 'name-only' }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] }] } }));
  write(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, projects: { [project]: { mcpServers: { local: {} } } } }));
  write(path.join(h, '.agents', 'skills', 'review', 'SKILL.md'), skill('review', 'Review a change before merging.'));
  write(path.join(h, '.agents', 'skills', 'review', 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  write(path.join(h, '.agents', 'skills', 'draw', 'SKILL.md'), skill('draw', 'Draw a diagram.'));
  write(path.join(h, '.agents', 'skills', 'old', 'SKILL.md'), skill('old', 'An old skill.'));
  write(path.join(h, '.codex', 'AGENTS.md'), 'Codex personal.\n');
  write(path.join(h, '.codex', 'config.toml'), '[[skills.config]]\nname = "old"\nenabled = false\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
  write(path.join(h, '.codex', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'codex-hello' }] }] } }));
  write(path.join(h, '.copilot', 'skills', 'draw', 'SKILL.md'), skill('draw', 'Draw a diagram.'));
  write(path.join(h, '.copilot', 'copilot-instructions.md'), 'Copilot personal.\n');
  write(path.join(h, '.copilot', 'hooks', 'start.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'copilot-hello' }] } }));
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  write(path.join(project, 'CLAUDE.md'), 'Project Claude.\n');
  write(path.join(project, 'AGENTS.md'), 'Project agents.\n');
  write(path.join(project, '.agents', 'skills', 'level', 'SKILL.md'), skill('level', 'Design a level.'));
  write(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { figma: {} } }));
  return { root, home: h, project, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const harness = (result: { harnesses: HarnessContext[] }, id: string) => result.harnesses.find(h => h.id === id)!;
const row = (h: HarnessContext, name: string) => h.skills.rows.find(r => r.name === name)!;

test('Claude Code: listed skills with when_to_use, you-only and overridden skills, CLAUDE.md with imports and rules, hooks and MCP', () => {
  const f = home();
  try {
    const meter = new SessionStartMeter({ home: f.home, env: {} });
    const claude = harness(meter.measure(), 'claude');
    assert.equal(claude.present, true);
    assert.equal(row(claude, 'review').listed, true);
    assert.equal(row(claude, 'review').chars, '- review: Review a change before merging. Asked to review.'.length);
    assert.equal(row(claude, 'review').tokens, Math.ceil(row(claude, 'review').chars / 3.5));
    assert.equal(row(claude, 'release').listed, false); assert.match(row(claude, 'release').reason!, /disable-model-invocation/); assert.equal(row(claude, 'release').tokens, 0);
    assert.equal(row(claude, 'notes').listed, true); assert.match(row(claude, 'notes').reason!, /Name only/); assert.equal(row(claude, 'notes').chars, '- notes'.length);
    assert.equal(row(claude, 'deploy').where, '~/.claude/commands', 'legacy commands are listed like skills');
    assert.deepEqual(claude.instructions.files.map(file => [file.label, file.note ?? '']), [['~/.claude/CLAUDE.md', ''], ['~/.claude/extra.md', 'imported by ~/.claude/CLAUDE.md'], ['~/.claude/rules/always.md', 'rule']]);
    assert.deepEqual(claude.hooks.rows, [{ command: 'echo hello', source: '~/.claude/settings.json', matcher: 'startup' }]);
    assert.deepEqual(claude.mcp.rows.map(s => s.name), ['github']);
    assert.equal(claude.tokens, claude.skills.tokens + claude.instructions.tokens);
    assert.ok(claude.unknown.some(u => /System prompt/.test(u)));

    const withProject = harness(meter.measure({ project: f.project }), 'claude');
    assert.ok(withProject.instructions.files.some(file => file.path === path.join(f.project, 'CLAUDE.md')));
    assert.ok(!withProject.instructions.files.some(file => file.path === path.join(f.project, 'AGENTS.md')), 'AGENTS.md only without a CLAUDE.md');
    assert.deepEqual(withProject.mcp.rows.map(s => s.name), ['github', 'local', 'figma']);
  } finally { f.close(); }
});

test('Codex: implicit invocation off and config-disabled skills are left out; AGENTS.md from the repository root; the path is part of each entry', () => {
  const f = home();
  try {
    const codex = harness(new SessionStartMeter({ home: f.home, env: {} }).measure({ project: f.project }), 'codex');
    assert.equal(row(codex, 'review').listed, false); assert.match(row(codex, 'review').reason!, /allow_implicit_invocation/);
    assert.equal(row(codex, 'old').listed, false); assert.match(row(codex, 'old').reason!, /config\.toml/);
    const draw = row(codex, 'draw'), file = path.join(f.home, '.agents', 'skills', 'draw', 'SKILL.md');
    assert.equal(draw.chars, `- draw: Draw a diagram. (file: ${file})`.length);
    assert.equal(row(codex, 'level').scope, 'project');
    assert.deepEqual(codex.instructions.files.map(x => x.path), [path.join(f.home, '.codex', 'AGENTS.md'), path.join(f.project, 'AGENTS.md')]);
    assert.deepEqual(codex.hooks.rows.map(h => h.command), ['codex-hello']);
    assert.deepEqual(codex.mcp.rows.map(s => s.name), ['docs']);
  } finally { f.close(); }
});

test('Copilot CLI: its own and the shared folder, a name found twice counted once, instructions and sessionStart hooks', () => {
  const f = home();
  try {
    const copilot = harness(new SessionStartMeter({ home: f.home, env: {} }).measure({ project: f.project }), 'copilot');
    const draws = copilot.skills.rows.filter(r => r.name === 'draw');
    assert.equal(draws.length, 2); assert.equal(draws.filter(r => r.listed).length, 1); assert.match(draws[1].reason!, /counted once/);
    assert.equal(row(copilot, 'review').listed, true, 'Codex’s openai.yaml means nothing to Copilot');
    assert.ok(copilot.instructions.files.some(x => x.path === path.join(f.project, 'CLAUDE.md')) && copilot.instructions.files.some(x => x.path === path.join(f.project, 'AGENTS.md')));
    assert.deepEqual(copilot.hooks.rows.map(h => h.command), ['copilot-hello']);
  } finally { f.close(); }
});

test('files are read once per change: a second measure reads nothing, an edit is picked up', () => {
  const f = home();
  const original = fs.readFileSync;
  let reads = 0;
  try {
    const meter = new SessionStartMeter({ home: f.home, env: {} });
    meter.measure({ project: f.project });
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { reads++; return original(...args); }) as typeof fs.readFileSync;
    meter.measure({ project: f.project });
    assert.equal(reads, 0);
    write(path.join(f.home, '.claude', 'skills', 'review', 'SKILL.md'), skill('review', 'Review a change before merging, much more carefully.'));
    const claude = harness(meter.measure(), 'claude');
    assert.equal(reads, 1);
    assert.equal(row(claude, 'review').chars, '- review: Review a change before merging, much more carefully.'.length);
  } finally { (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = original; f.close(); }
});

test('turning model invocation off in the library takes the skill out of the listing the harnesses get', () => {
  const f = home();
  const wb = new Workbench(path.join(f.root, 'library'), path.join(f.root, 'private'));
  try {
    const router = new Router(wb, { composer: null, home: new HomeFiles({ home: f.home, privateRoot: path.join(f.root, 'private') }) });
    const claudeTarget = wb.enroll({ name: 'Claude skills', root: f.home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    const codexTarget = wb.enroll({ name: 'Codex skills', root: f.home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    const item = wb.create({ title: 'triage', kind: 'skill', content: skill('triage', 'Triage incoming bug reports by severity and owner.') });
    for (const target of [claudeTarget, codexTarget]) router.installSkill({ itemId: item.id, targetId: target.id, confirm: true });
    const before = router.call('context.sessionStart', {}) as ReturnType<SessionStartMeter['measure']>;
    assert.equal(row(harness(before, 'claude'), 'triage').listed, true);
    assert.equal(row(harness(before, 'codex'), 'triage').listed, true);
    router.setInvocation({ itemId: item.id, model: false });
    const after = router.call('context.sessionStart', {}) as ReturnType<SessionStartMeter['measure']>;
    for (const id of ['claude', 'codex']) {
      assert.equal(row(harness(after, id), 'triage').listed, false, id);
      assert.ok(harness(after, id).tokens < harness(before, id).tokens, `${id} drops`);
    }
  } finally { wb.close(); f.close(); }
});
