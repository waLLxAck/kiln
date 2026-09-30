import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from '../packages/agent/service';
import { distillPrompt, distillResult, distillSchema, entryTypeInfo, entryTypes, insertInstruction, keepSelected, promptInputs, readInstruction, selectedEntryTypes, targetLine } from '../packages/agent/distill';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { instructionChoices } from '../apps/desktop/src/configModel';
import type { HomeFile } from '../packages/home/service';

const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-distill-types-')); return new Workbench(path.join(root, 'library'), path.join(root, 'private')); };
const wait = async (service: AgentService) => { for (let i = 0; i < 100 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(service.running, 0); };
const entry = (type: string, extra: Record<string, unknown> = {}) => ({ type, title: `A ${type}`, description: `When a ${type} helps.`, content: `The ${type}.`, url: '', timestamp: '', tags: ['review'], ...extra });
const enumOf = (schema: object) => ((schema as { properties: { entries: { items: { properties: { type: { enum: string[] } } } } } }).properties.entries.items.properties.type.enum);
const entryProperties = (schema: object) => Object.keys((schema as { properties: { entries: { items: { properties: object } } } }).properties.entries.items.properties);

test('the distill prompt describes and the schema allows only the selected entry types', () => {
  const all = distillPrompt();
  for (const type of entryTypes) assert.ok(all.includes(entryTypeInfo[type].guidance), `${type} is described when every type is on`);
  assert.doesNotMatch(all, /return only these types/);
  assert.ok(all.includes(promptInputs));

  const some = distillPrompt(['insight', 'technique']);
  assert.ok(some.includes(entryTypeInfo.technique.guidance) && some.includes(entryTypeInfo.insight.guidance));
  for (const type of ['prompt', 'tool', 'resource', 'instruction'] as const) assert.ok(!some.includes(entryTypeInfo[type].guidance), `${type} is not described`);
  assert.ok(!some.includes(promptInputs), 'placeholder advice only accompanies prompts');
  assert.match(some, /personal library of techniques and insights\./);
  assert.match(some, /return only these types/);
  assert.doesNotMatch(some, /target \(/);
  assert.deepEqual(enumOf(distillSchema(['insight', 'technique'])), ['technique', 'insight']);
  assert.ok(!entryProperties(distillSchema(['insight'])).includes('target'));

  const instructions = distillPrompt(['instruction']);
  assert.match(instructions, /standing instructions \(CLAUDE\.md, AGENTS\.md, \.github\/copilot-instructions\.md or Cursor rules\)/);
  assert.match(instructions, /Steps a person carries out, and a task to run once, are not instructions/);
  assert.match(instructions, /target \(for instruction entries/);
  const schema = distillSchema(['instruction']);
  assert.deepEqual(enumOf(schema), ['instruction']);
  assert.ok(entryProperties(schema).includes('target'));
  // Codex requires every property: no defaults or optional fields in what the model answers.
  assert.doesNotMatch(JSON.stringify(schema), /"default"/);
  for (const types of [entryTypes, ['prompt'] as const]) {
    const s = distillSchema(types) as unknown as { properties: { entries: { items: { properties: object; required: string[] } } } };
    assert.deepEqual([...s.properties.entries.items.required].sort(), Object.keys(s.properties.entries.items.properties).sort());
  }
});

test('the selection defaults to every type, ignores unknown types and never ends up empty', () => {
  assert.deepEqual(selectedEntryTypes({}), [...entryTypes]);
  assert.deepEqual(selectedEntryTypes({ distillOff: ['tool', 'resource', 'skill-from-a-newer-build'] }), ['prompt', 'technique', 'insight', 'instruction']);
  assert.deepEqual(selectedEntryTypes({ distillOff: [...entryTypes] }), [...entryTypes]);
  const result = distillResult.parse({ collection: 'C', summary: 'S', takeaway: 'T', skipped: 'Small talk.', entries: [entry('prompt'), entry('tool'), entry('insight')] });
  const kept = keepSelected(result, ['prompt', 'insight']);
  assert.deepEqual(kept.result.entries.map(e => e.type), ['prompt', 'insight']);
  assert.equal(kept.dropped, 1);
  assert.match(kept.result.skipped, /^Small talk\. 1 entry of types turned off in Settings left out\.$/);
  assert.equal(keepSelected(result, entryTypes).result, result);
});

test('distillation asks for the types chosen in Settings and files only those', async () => {
  const wb = fixture();
  try {
    wb.saveDistillTypes({ types: ['prompt', 'insight'] });
    let prompt = '', schema: object = {};
    const service = new AgentService(wb, () => {}, async input => {
      prompt = input.prompt; schema = input.schema!;
      return { collection: 'Reading', summary: 'An article.', takeaway: 'Review twice.', skipped: '', entries: [entry('prompt'), entry('technique'), entry('insight'), entry('instruction')] };
    }, async () => []);
    const { item } = service.capture({ text: 'Notes on reviewing code.', files: {} });
    await wait(service);
    const job = service.list()[0];
    assert.equal(job.status, 'completed', job.error);
    assert.deepEqual(job.entryTypes, ['prompt', 'insight']);
    assert.ok(!prompt.includes(entryTypeInfo.technique.guidance) && prompt.includes(entryTypeInfo.insight.guidance));
    assert.deepEqual(enumOf(schema), ['prompt', 'insight']);
    assert.deepEqual(job.createdItemIds!.map(id => wb.getItem(id).kind), ['prompt', 'insight']);
    assert.deepEqual(wb.analyses(item.id)[0].counts, { prompt: 1, insight: 1 });
    assert.match(wb.analyses(item.id)[0].skipped, /2 entries of types turned off in Settings left out/);
  } finally { wb.close(); }
});

test('an instruction entry becomes an instruction item with its target in the footer', async () => {
  const wb = fixture();
  try {
    const snippet = '## Testing\n\n- Run `npm test` before saying a change is done.';
    const service = new AgentService(wb, () => {}, async () => ({ collection: 'Agent habits', summary: 'A talk on agent setup.', takeaway: 'Write rules down.', skipped: '', entries: [
      entry('instruction', { title: 'Run the tests before finishing', content: snippet, tags: ['testing', 'instruction'], target: { scope: 'project', files: ['CLAUDE.md', 'AGENTS.md'], section: 'under “## Testing”' } }),
      entry('technique'),
    ] }), async () => []);
    const { item } = service.capture({ text: 'https://example.com/agent-habits', files: {} });
    await wait(service);
    const job = service.list()[0];
    assert.equal(job.status, 'completed', job.error);
    const [id] = job.createdItemIds!;
    const created = wb.getItem(id), content = wb.getRevision(id).content;
    assert.equal(created.kind, 'instruction');
    assert.equal(created.origin?.itemId, item.id);
    assert.deepEqual(created.tags, ['testing'], 'the entry type is not repeated as a tag');
    assert.equal(content, `${snippet}\n\n---\nTarget: Project · CLAUDE.md, AGENTS.md · under “## Testing”\n\nFrom “https://example.com/agent-habits”: https://example.com/agent-habits`);
    assert.deepEqual(readInstruction(content), { snippet, target: { scope: 'project', files: ['CLAUDE.md', 'AGENTS.md'], section: 'under “## Testing”' } });
    // The technique beside it keeps the plain source footer.
    assert.match(wb.getRevision(job.createdItemIds![1]).content, /\n---\nFrom “/);
    assert.doesNotMatch(wb.getRevision(job.createdItemIds![1]).content, /Target:/);
  } finally { wb.close(); }
});

test('instruction footers read back, and snippets go under the heading their target names', () => {
  assert.equal(targetLine({ scope: '', files: [], section: '' }), '');
  assert.equal(targetLine({ scope: 'either', files: ['AGENTS.md'], section: '' }), 'Target: Personal or project · AGENTS.md');
  assert.deepEqual(readInstruction('- Keep commits small.'), { snippet: '- Keep commits small.', target: null });
  assert.deepEqual(readInstruction('- Keep commits small.\n\n---\nFrom “Talk”: https://x.test'), { snippet: '- Keep commits small.', target: null });
  assert.deepEqual(readInstruction('Rule\n\n---\nTarget: Personal · .github/copilot-instructions.md · a new “## Git” section · at the end\nFrom “Talk”').target, { scope: 'personal', files: ['.github/copilot-instructions.md'], section: 'a new “## Git” section · at the end' });
  // A horizontal rule inside the snippet is not mistaken for the footer.
  assert.equal(readInstruction('- One\n\n---\n\n- Two\n\n---\nTarget: Project · AGENTS.md').snippet, '- One\n\n---\n\n- Two');

  const file = '# Rules\n\n## Testing\n\n- Use vitest.\n\n```sh\n## not a heading\n```\n\n## Git\n\n- Rebase.\n';
  const placed = insertInstruction(file, '## Testing\n\n- Run the tests first.', 'under “## Testing”');
  assert.equal(placed.heading, 'Testing');
  assert.equal(placed.text, '# Rules\n\n## Testing\n\n- Use vitest.\n\n```sh\n## not a heading\n```\n\n- Run the tests first.\n\n## Git\n\n- Rebase.\n');
  assert.equal(insertInstruction(file, '- Sign commits.', 'the “Git” section').text, '# Rules\n\n## Testing\n\n- Use vitest.\n\n```sh\n## not a heading\n```\n\n## Git\n\n- Rebase.\n\n- Sign commits.\n');
  assert.deepEqual(insertInstruction(file, '## Style\n\n- Tabs.', 'a new “## Style” section'), { text: `${file}\n## Style\n\n- Tabs.\n`, heading: '' });
  assert.deepEqual(insertInstruction('', '- First rule.'), { text: '- First rule.\n', heading: '' });
});

test('settings default every type on, read old and damaged files, and keep at least one type', () => {
  const wb = fixture();
  try {
    const file = path.join(wb.local, 'settings.json');
    assert.deepEqual(wb.settings().distillOff, []);
    // A 0.22.0 settings file: no distillOff, and an experiments map that is ignored.
    fs.writeFileSync(file, JSON.stringify({ shortcut: 'Alt+K', launchAtLogin: false, theme: 'dark', agentProvider: 'claude', experiments: { captureDialog: true } }));
    assert.equal(wb.settings().theme, 'dark'); assert.deepEqual(wb.settings().distillOff, []);
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', distillOff: 'tool' }));
    assert.deepEqual(wb.settings().distillOff, [], 'a malformed list does not break Settings');
    fs.writeFileSync(file, JSON.stringify({ distillOff: ['tool', 'skill-from-a-newer-build'] }));
    assert.deepEqual(wb.settings().distillOff, ['tool']);
    fs.writeFileSync(file, JSON.stringify({ distillOff: [...entryTypes] }));
    assert.deepEqual(wb.settings().distillOff, [], 'every type off reads as every type on');

    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', codexModel: 'gpt-x' }));
    const router = new Router(wb, { composer: null });
    const saved = router.call('settings.distill', { types: ['instruction', 'prompt', 'unknown'] }) as ReturnType<Workbench['settings']>;
    assert.deepEqual(selectedEntryTypes(saved), ['prompt', 'instruction']);
    assert.equal(saved.theme, 'dark'); assert.equal(saved.codexModel, 'gpt-x');
    assert.throws(() => wb.saveDistillTypes({ types: [] }), /at least one entry type/);
    assert.throws(() => wb.saveDistillTypes({ types: ['unknown'] }), /at least one entry type/);
    assert.throws(() => wb.saveSettings({ ...wb.settings(), distillOff: [...entryTypes] }), /at least one entry type/);
    // Saving other preferences keeps the selection.
    wb.saveSettings({ ...wb.settings(), theme: 'light' });
    assert.deepEqual(selectedEntryTypes(wb.settings()), ['prompt', 'instruction']);
  } finally { wb.close(); }
});

test('Add to… lists instruction files, the ones the target names first and in its scope', () => {
  const file = (key: string, filePath: string, scope = 'Personal'): HomeFile => ({ key, kind: 'claude', label: filePath.split('/').at(-1)!, description: '', path: filePath, scope, exists: true, size: 0, modifiedAt: null, hash: null, removable: false });
  const files = [
    file('claude-global', '/home/me/.claude/CLAUDE.md'), file('agents-home', '/home/me/AGENTS.md'), file('claude-settings', '/home/me/.claude/settings.json'),
    file('p-agents', '/work/app/AGENTS.md', 'Project · /work/app'), file('p-claude', '/work/app/CLAUDE.md', 'Project · /work/app'), file('p-copilot', '/work/app/.github/copilot-instructions.md', 'Project · /work/app'),
  ];
  const keys = (target: Parameters<typeof instructionChoices>[1]) => instructionChoices(files, target).map(c => `${c.file.key}${c.suggested ? '*' : ''}`);
  assert.deepEqual(keys({ scope: 'project', files: ['CLAUDE.md', 'AGENTS.md'], section: '' }), ['p-agents*', 'p-claude*', 'claude-global', 'agents-home', 'p-copilot']);
  assert.deepEqual(keys({ scope: 'personal', files: ['CLAUDE.md'], section: '' }), ['claude-global*', 'agents-home', 'p-agents', 'p-claude', 'p-copilot']);
  assert.deepEqual(keys({ scope: 'either', files: ['.github/copilot-instructions.md'], section: '' }), ['p-copilot*', 'claude-global', 'agents-home', 'p-agents', 'p-claude']);
  assert.deepEqual(keys(null), ['claude-global', 'agents-home', 'p-agents', 'p-claude', 'p-copilot']);
});
