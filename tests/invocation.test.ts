import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_POLICY_FILE, flagOnlyChange, invocationSummary, listingChars, readInvocation, setClaudeInvocation, setCodexInvocation, setModelInvocation } from '../packages/domain/invocation';
import type { Authoring } from '../packages/protocol/schema';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const text = (base64: string | undefined) => base64 === undefined ? undefined : Buffer.from(base64, 'base64').toString('utf8');
const skill = '---\nname: careful-review\n# keep this comment\ndescription: "Review a change: correctness first."\nallowed-tools: Read, Grep\n---\n\n# Procedure\nRead it.\n';
const authoring = (content: string, files: Record<string, string> = {}): Authoring => ({ title: 'careful-review', kind: 'skill', description: '', tags: ['review'], collection: 'Code', source: '', licence: 'Unknown', content, files });

test('reading: no flags means the model may invoke it; each client reads its own switch', () => {
  assert.deepEqual(readInvocation({ content: skill, files: {} }), { claude: true, codex: true });
  assert.deepEqual(readInvocation({ content: skill.replace('allowed-tools', 'disable-model-invocation: true\nallowed-tools'), files: {} }), { claude: false, codex: true });
  assert.deepEqual(readInvocation({ content: skill, files: { [CODEX_POLICY_FILE]: b64('policy:\n  allow_implicit_invocation: false\n') } }), { claude: true, codex: false });
  assert.equal(readInvocation({ content: skill.replace('allowed-tools', 'disable-model-invocation: false\nallowed-tools'), files: {} }).claude, true);
  // Claude Code also reads yes/on/1 in any case as true; Codex parses its file strictly.
  for (const value of ['yes', 'On', '1', '"TRUE"']) assert.equal(readInvocation({ content: skill.replace('allowed-tools', `disable-model-invocation: ${value}\nallowed-tools`), files: {} }).claude, false, value);
  assert.equal(readInvocation({ content: skill, files: { [CODEX_POLICY_FILE]: b64('policy:\n  allow_implicit_invocation: "false"\n') } }).codex, true);
  assert.equal(invocationSummary({ claude: true, codex: true }), 'model');
  assert.equal(invocationSummary({ claude: false, codex: false }), 'user');
  assert.equal(invocationSummary({ claude: false, codex: true }), 'mixed');
});

test('SKILL.md: off adds one line at the end of the front-matter and keeps every other byte; on takes it out again', () => {
  const off = setClaudeInvocation(skill, false);
  assert.equal(off, skill.replace('allowed-tools: Read, Grep\n---', 'allowed-tools: Read, Grep\ndisable-model-invocation: true\n---'));
  assert.equal(setClaudeInvocation(off, false), off, 'idempotent');
  assert.equal(setClaudeInvocation(off, true), skill, 'round trip gives the original bytes');
  assert.equal(setClaudeInvocation(skill, true), skill, 'already on: unchanged');
});

test('SKILL.md: CRLF line endings, a byte-order mark and an existing value are respected', () => {
  const crlf = '\uFEFF' + skill.replace(/\n/g, '\r\n');
  const off = setClaudeInvocation(crlf, false);
  assert.ok(off.startsWith('\uFEFF---\r\n'));
  assert.ok(off.includes('allowed-tools: Read, Grep\r\ndisable-model-invocation: true\r\n---\r\n'));
  assert.ok(!/[^\r]\n/.test(off), 'no bare LF introduced');
  assert.equal(setClaudeInvocation(off, true), crlf);
  // An explicit false is replaced in place when turning off, and kept as it is when turning on.
  const explicit = skill.replace('allowed-tools', 'disable-model-invocation: false\nallowed-tools');
  assert.equal(setClaudeInvocation(explicit, true), explicit);
  assert.equal(setClaudeInvocation(explicit, false), skill.replace('allowed-tools', 'disable-model-invocation: true\nallowed-tools'));
  // A true in the middle is removed where it is; a comment after the value does not matter.
  const yes = skill.replace('allowed-tools', 'disable-model-invocation: yes\nallowed-tools');
  assert.equal(setClaudeInvocation(yes, false), yes, 'yes already means off to Claude Code');
  assert.equal(setClaudeInvocation(yes, true), skill);
  const middle = skill.replace('# keep this comment', 'disable-model-invocation: true # you only');
  assert.equal(setClaudeInvocation(middle, false), middle);
  assert.equal(setClaudeInvocation(middle, true), skill.replace('# keep this comment\n', ''));
});

test('SKILL.md: no front-matter, an empty one, and a value over several lines', () => {
  assert.equal(setClaudeInvocation('# Just a body\n', true), '# Just a body\n');
  assert.equal(setClaudeInvocation('# Just a body\r\n', false), '---\r\ndisable-model-invocation: true\r\n---\r\n# Just a body\r\n');
  assert.equal(setClaudeInvocation('---\n---\nBody\n', false), '---\ndisable-model-invocation: true\n---\nBody\n');
  assert.throws(() => setClaudeInvocation(skill.replace('allowed-tools', 'disable-model-invocation:\n  true\nallowed-tools'), true), /several lines/);
});

test('agents/openai.yaml: created when missing, edited in place when present, removed when it held only the flag', () => {
  assert.equal(setCodexInvocation(null, true), null);
  const created = setCodexInvocation(null, false)!;
  assert.equal(created, 'policy:\n  allow_implicit_invocation: false\n');
  assert.equal(setCodexInvocation(created, false), created);
  assert.equal(setCodexInvocation(created, true), null, 'nothing else in it: the file goes');
  const rich = 'interface:\n  display_name: "Careful review"\n\npolicy:\n    other: 1\ndependencies: {}\n';
  const off = setCodexInvocation(rich, false)!;
  assert.equal(off, 'interface:\n  display_name: "Careful review"\n\npolicy:\n    allow_implicit_invocation: false\n    other: 1\ndependencies: {}\n', 'indented like its sibling');
  assert.equal(setCodexInvocation(off, true), rich);
  const onlyPolicy = 'interface:\n  display_name: X\npolicy:\n  allow_implicit_invocation: false\n';
  assert.equal(setCodexInvocation(onlyPolicy, true), 'interface:\n  display_name: X\n', 'an emptied policy block goes too');
  assert.equal(setCodexInvocation('interface:\n  display_name: X', false), 'interface:\n  display_name: X\npolicy:\n  allow_implicit_invocation: false\n', 'a missing final newline is added before appending');
  const explicit = 'policy:\n  allow_implicit_invocation: true\n';
  assert.equal(setCodexInvocation(explicit, true), explicit, 'an explicit true stays');
  assert.equal(setCodexInvocation(explicit, false), created);
  assert.throws(() => setCodexInvocation('policy: { allow_implicit_invocation: true }\n', false), /one line/);
  const crlf = 'interface:\r\n  display_name: X\r\n';
  assert.equal(setCodexInvocation(crlf, false), 'interface:\r\n  display_name: X\r\npolicy:\r\n  allow_implicit_invocation: false\r\n');
});

test('the listed entry: name and description, with when_to_use appended', () => {
  assert.equal(listingChars(skill), '- careful-review: Review a change: correctness first.'.length);
  assert.equal(listingChars(skill.replace('allowed-tools', 'when_to_use: Before merging.\nallowed-tools')), '- careful-review: Review a change: correctness first. Before merging.'.length);
});

test('the whole bundle: both switches together, other files untouched, round trip exact', () => {
  const bundle: { content: string; files: Record<string, string> } = { content: skill, files: { 'references/checklist.md': b64('- one\n') } };
  const off = setModelInvocation(bundle, false);
  assert.deepEqual(readInvocation(off), { claude: false, codex: false });
  assert.equal(off.files['references/checklist.md'], bundle.files['references/checklist.md']);
  assert.equal(text(off.files[CODEX_POLICY_FILE]), 'policy:\n  allow_implicit_invocation: false\n');
  assert.deepEqual(setModelInvocation(off, false), off, 'idempotent');
  assert.deepEqual(setModelInvocation(off, true), bundle, 'round trip');
  assert.deepEqual(setModelInvocation(bundle, true), bundle);
});

test('flag-only changes are told apart from any other change', () => {
  const approved = authoring(skill, { 'references/checklist.md': b64('- one\n') });
  const off = { ...approved, ...setModelInvocation(approved, false) };
  assert.equal(flagOnlyChange(approved, off), true);
  assert.equal(flagOnlyChange(off, { ...off, ...setModelInvocation(off, true) }), true);
  assert.equal(flagOnlyChange(approved, { ...off, collection: 'Elsewhere' }), true, 'the collection is organisation');
  assert.equal(flagOnlyChange(approved, { ...off, content: off.content.replace('Read it.', 'Read it twice.') }), false, 'the body changed too');
  assert.equal(flagOnlyChange(approved, { ...off, files: { ...off.files, 'references/checklist.md': b64('- two\n') } }), false, 'a bundled file changed');
  assert.equal(flagOnlyChange(approved, { ...off, files: { ...off.files, 'extra.md': b64('x') } }), false, 'a file was added');
  assert.equal(flagOnlyChange(approved, { ...off, tags: ['other'] }), false);
  assert.equal(flagOnlyChange(approved, { ...off, content: off.content.replace('\n', '\r\n') }), false, 'line endings are bytes too');
  const explicit = authoring(skill.replace('allowed-tools', 'disable-model-invocation: false\nallowed-tools'));
  assert.equal(flagOnlyChange(explicit, { ...explicit, ...setModelInvocation(explicit, false) }), true);
  assert.equal(flagOnlyChange({ ...approved, kind: 'prompt' }, { ...off, kind: 'prompt' }), false, 'skills only');
});
