import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse } from 'yaml';
import type { Authoring } from '../packages/protocol/schema';
import { validateContent } from '../packages/domain/content';
import { contentChecks } from '../packages/domain/content-checks';
import { validateAgent } from '../packages/domain/agent-format';
import { safeRelativePath } from '../packages/domain/relative-path';
import { draftKey, parseDraft, serialiseDraft, withDraftContent } from '../apps/desktop/src/item-draft';
import { editableText, encodeText, mergeTextEdits, newFileProblem } from '../apps/desktop/src/bundled-text';
import { itemLanguage, languageFor, lineSeparatorFor } from '../apps/desktop/src/code-language';

/** validateContent's problem rules exactly as they were before they moved into contentChecks, kept here as the reference. */
function legacyProblems(value: Authoring): string[] {
  const problems: string[] = [];
  if (value.kind === 'agent') problems.push(...validateAgent(value));
  if (value.kind === 'skill') {
    const match = value.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) problems.push('SKILL.md needs YAML frontmatter with name and description.');
    else {
      try {
        const meta = parse(match[1]);
        if (!meta || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64) problems.push('Skill name must be lowercase words separated by hyphens (up to 64 characters).');
        if (typeof meta?.description !== 'string' || !meta.description.trim() || meta.description.length > 1024) problems.push('Add a description explaining when to use the skill (up to 1,024 characters).');
      } catch { problems.push('Skill frontmatter is invalid YAML.'); }
    }
    for (const match of value.content.matchAll(/\]\(([^)]+)\)/g)) {
      const reference = match[1].split('#')[0].replace(/^\.\//, '');
      const present = Object.hasOwn(value.files, reference) || (reference.endsWith('/') && Object.keys(value.files).some(name => name.startsWith(reference)));
      if (reference && !/^(https?:|mailto:)/i.test(reference) && !present) problems.push(`Missing or unsupported local reference: ${reference}`);
    }
  }
  if (value.kind === 'link') {
    try { const url = new URL(value.content.trim().split('\n')[0]); if (!['http:', 'https:'].includes(url.protocol)) problems.push('Links must use HTTP or HTTPS.'); } catch { problems.push('The first line must be a valid web URL.'); }
  }
  if (value.kind === 'reference' && !value.content.trim()) problems.push('Add an absolute file path. This is a reference, not a backup.');
  return [...new Set(problems)];
}
const b64 = (text: string) => Buffer.from(text).toString('base64');
const skill = (name: string, body = 'Follow the checklist.') => `---\nname: ${name}\ndescription: Use when reviewing a change.\n---\n\n# ${name}\n\n${body}\n`;
const authoring = (value: Partial<Authoring>): Authoring => ({ title: 'T', kind: 'prompt', content: '', description: '', tags: [], collection: '', source: '', licence: 'Personal', files: {}, ...value } as Authoring);
const fixtures: Authoring[] = [
  authoring({ kind: 'skill', content: skill('careful-review') }),
  authoring({ kind: 'skill', content: skill('careful-review').replaceAll('\n', '\r\n') }),
  authoring({ kind: 'skill', content: '# No frontmatter' }),
  authoring({ kind: 'skill', content: skill('Careful Review') }),
  authoring({ kind: 'skill', content: skill('x'.repeat(65)) }),
  authoring({ kind: 'skill', content: '---\nname: ok\ndescription: ""\n---\nBody' }),
  authoring({ kind: 'skill', content: `---\nname: ok\ndescription: ${'d'.repeat(1025)}\n---\nBody` }),
  authoring({ kind: 'skill', content: '---\nname: [unclosed\ndescription: x\n---\nBody' }),
  authoring({ kind: 'skill', content: '---\n---\nBody' }),
  authoring({ kind: 'skill', content: '---\nname: 7\n---\n' }),
  authoring({ kind: 'skill', content: skill('linked', 'See [checklist](references/checklist.md), [guide](./references/guide.md#top), [site](https://example.com), [mail](mailto:a@b.c), [dir](scripts/), [again](references/guide.md).'), files: { 'references/checklist.md': b64('- claims\n'), 'assets/logo.png': Buffer.from([137, 80, 78, 71]).toString('base64') } }),
  authoring({ kind: 'skill', content: skill('dirs', 'Run [tools](scripts/).'), files: { 'scripts/check.py': b64('print(1)\n') } }),
  authoring({ kind: 'agent', content: 'invalid', agent: { provider: 'codex', filename: 'repair.toml' } }),
  authoring({ kind: 'agent', content: 'name = "reviewer"\ndescription = "Reviews"\ndeveloper_instructions = "Be careful"\n', agent: { provider: 'codex', filename: 'reviewer.toml' } }),
  authoring({ kind: 'agent', content: '---\nname: Careful Reviewer\ndescription: Reviews\n---\nBody', agent: { provider: 'claude', filename: 'careful.md' } }),
  authoring({ kind: 'agent', content: '---\ndescription: Reviews\n---\nBody', agent: { provider: 'copilot', filename: 'careful.toml' } }),
  authoring({ kind: 'agent', content: 'x' }),
  authoring({ kind: 'link', content: 'https://example.com/page\nnotes' }),
  authoring({ kind: 'link', content: 'ftp://example.com' }),
  authoring({ kind: 'link', content: 'not a url' }),
  authoring({ kind: 'reference', content: '  ' }),
  authoring({ kind: 'reference', content: '/home/ada/file.pdf' }),
  authoring({ kind: 'prompt', content: 'Check the diff for off-by-one errors and missing tests.' }),
  authoring({ kind: 'instruction', content: '' }),
];

test('the shared content checks give exactly the problems validateContent reported before', () => {
  for (const value of fixtures) {
    const expected = legacyProblems(value);
    assert.deepEqual(validateContent(value), expected, value.content.slice(0, 40));
    assert.deepEqual([...new Set(contentChecks(value).map(c => c.message))], expected);
  }
  assert.throws(() => validateContent(authoring({ kind: 'skill', content: skill('a'), files: { 'SKILL.md': b64('x') } })), /main content file/);
});

test('content checks point at the line they are about', () => {
  const lines = (value: Authoring) => contentChecks(value).map(c => [c.line, c.message.slice(0, 20)]);
  assert.deepEqual(lines(authoring({ kind: 'skill', content: '# No frontmatter' })), [[1, 'SKILL.md needs YAML ']]);
  assert.deepEqual(lines(authoring({ kind: 'skill', content: '---\ndescription: Fine\nname: Bad Name\n---\nBody' })), [[3, 'Skill name must be l']]);
  assert.deepEqual(lines(authoring({ kind: 'skill', content: '---\nname: fine\n---\nBody' })), [[1, 'Add a description ex']]);
  assert.deepEqual(lines(authoring({ kind: 'skill', content: skill('ok', 'Intro\n\nSee [x](missing.md).') })), [[10, 'Missing or unsupport']]);
  assert.equal(contentChecks(authoring({ kind: 'skill', content: '---\nname: ok\ndescription: [x\n---\n' }))[0].line, 3);
});

test('item drafts: the original { content, base } format still restores and the plain editor keeps writing it', () => {
  const old = JSON.stringify({ content: 'Hello', base: 'abc' });
  assert.deepEqual(parseDraft(old), { content: 'Hello', base: 'abc' });
  assert.equal(parseDraft(null), null);
  assert.equal(parseDraft('not json'), null);
  assert.equal(parseDraft(JSON.stringify({ content: 'x' })), null, 'a draft needs its base revision');
  assert.equal(withDraftContent(null, 'Hi', 'h1'), JSON.stringify({ content: 'Hi', base: 'h1' }));
  assert.equal(withDraftContent(old, 'Hi', 'h1'), JSON.stringify({ content: 'Hi', base: 'h1' }), 'drafts without code editor fields are written exactly as before');
  assert.equal(draftKey('id-1'), 'kiln-draft:id-1');
});

test('item drafts keep metadata and bundled file edits, ignore junk and survive the plain editor', () => {
  const full = serialiseDraft({ content: 'Body', base: 'h', meta: { title: 'New title', tags: 'a, b' }, files: { 'references/notes.md': 'Notes\r\n' } });
  assert.deepEqual(parseDraft(full), { content: 'Body', base: 'h', meta: { title: 'New title', tags: 'a, b' }, files: { 'references/notes.md': 'Notes\r\n' } });
  assert.equal(serialiseDraft({ content: 'Body', base: 'h', meta: {}, files: {} }), JSON.stringify({ content: 'Body', base: 'h' }));
  assert.deepEqual(parseDraft(JSON.stringify({ content: 'c', base: 'b', meta: { title: 3, source: 'web', unknown: 'x' }, files: ['nope'] })), { content: 'c', base: 'b', meta: { source: 'web' } });
  // The plain editor (flag off) rewrites content and base but must not drop what the code editor stored.
  assert.deepEqual(parseDraft(withDraftContent(full, 'Edited without the flag', 'h')), { content: 'Edited without the flag', base: 'h', meta: { title: 'New title', tags: 'a, b' }, files: { 'references/notes.md': 'Notes\r\n' } });
});

test('bundled files: text is detected by content and round-trips byte for byte; binary files are left alone', () => {
  assert.equal(editableText(b64('plain\n')), 'plain\n');
  assert.equal(editableText(''), '');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('é\r\nline\r\n')]).toString('base64');
  assert.equal(encodeText(editableText(bom)!), bom, 'a byte-order mark and CRLF survive');
  assert.equal(editableText(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')), null, 'PNG bytes are not UTF-8');
  assert.equal(editableText(Buffer.from('a\0b').toString('base64')), null, 'NUL bytes mean binary');
  assert.equal(editableText(Buffer.alloc(600 * 1024, 97).toString('base64')), null, 'too large to edit');
  assert.equal(editableText('%%%'), null, 'invalid base64');
  const files = { 'a.md': b64('one\r\n'), 'b.txt': b64('two'), 'logo.png': Buffer.from([137, 80, 78, 71]).toString('base64'), 'big.bin': Buffer.from([0, 1, 2]).toString('base64') };
  const merged = mergeTextEdits(files, { 'a.md': 'one\r\n', 'b.txt': 'two, edited', 'logo.png': 'overwritten?', 'notes/new.md': '' });
  assert.equal(merged['a.md'], files['a.md'], 'unchanged text keeps its stored bytes');
  assert.equal(Buffer.from(merged['b.txt'], 'base64').toString(), 'two, edited');
  assert.equal(merged['logo.png'], files['logo.png'], 'binary files are never replaced by text');
  assert.equal(merged['big.bin'], files['big.bin']);
  assert.equal(merged['notes/new.md'], '');
  assert.deepEqual(Object.keys(merged).sort(), ['a.md', 'b.txt', 'big.bin', 'logo.png', 'notes/new.md']);
});

test('new bundled file paths use the storage path rules', () => {
  const legacySafe = (value: string) => value.length > 0 && value.length < 240 && !/[\\:*?"<>|\x00-\x1f]/.test(value) && !path.posix.isAbsolute(value) && value.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p));
  for (const value of ['references/notes.md', 'a', '/etc/passwd', '../up.md', 'a/./b', 'a//b', 'C:\\x', 'con.txt', 'folder/nul', 'trailing.', 'space /x', 'ok-name_1.py', 'x'.repeat(240), '', 'q?.md'])
    assert.equal(safeRelativePath(value), legacySafe(value), value);
  const existing = ['references/Notes.md'];
  assert.equal(newFileProblem('references/extra.md', existing, safeRelativePath), null);
  assert.match(newFileProblem('', existing, safeRelativePath)!, /Enter a relative path/);
  assert.match(newFileProblem('../x.md', existing, safeRelativePath)!, /relative path/);
  assert.match(newFileProblem('SKILL.md', existing, safeRelativePath)!, /main content file/);
  assert.match(newFileProblem('references/notes.md', existing, safeRelativePath)!, /already exists/);
});

test('languages by file name and line breaks the editor must keep', () => {
  assert.equal(languageFor('SKILL.md'), 'markdown');
  assert.equal(languageFor('/home/ada/.claude/settings.json'), 'json');
  assert.equal(languageFor('C:\\Users\\Ada\\AppData\\Roaming\\Code\\User\\settings.json', { comments: true }), 'jsonc');
  assert.equal(languageFor('project/.vscode/mcp.json'), 'jsonc');
  assert.equal(languageFor('tsconfig.build.json'), 'jsonc');
  assert.equal(languageFor('config.yml'), 'yaml');
  assert.equal(languageFor('~/.codex/config.toml'), 'toml');
  assert.equal(languageFor('scripts/check.sh'), 'shell');
  assert.equal(languageFor('/home/ada/.bashrc'), 'shell');
  assert.equal(languageFor('Microsoft.PowerShell_profile.ps1'), 'powershell');
  assert.equal(languageFor('scripts/check.py'), 'python');
  assert.equal(languageFor('run.mjs'), 'javascript');
  assert.equal(languageFor('data.csv'), 'plain');
  assert.equal(itemLanguage({ kind: 'agent', agent: { provider: 'codex' } }), 'toml');
  assert.equal(itemLanguage({ kind: 'agent', agent: { provider: 'claude' } }), 'markdown');
  assert.equal(itemLanguage({ kind: 'link' }), 'plain');
  assert.equal(lineSeparatorFor('a\nb\n'), null);
  assert.equal(lineSeparatorFor('a\r\nb\r\n'), '\r\n');
  assert.equal(lineSeparatorFor('a\r\nb\n'), '\n');
  assert.equal(lineSeparatorFor('a\rb'), '\n');
});
