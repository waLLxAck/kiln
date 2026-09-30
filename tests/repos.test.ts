import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildSync } from 'esbuild';
import { Workbench } from '../packages/domain/workbench';
import { AgentService } from '../packages/agent/service';
import { RepoImports, DEFAULT_REGISTRIES } from '../packages/domain/repo-import';
import { detectLayout } from '../packages/domain/repo-layout';
import { parseGitHubRepo, repoSourceOf } from '../packages/domain/github-url';
import { parseArguments } from '../apps/cli/arguments';

// Every "GitHub" repository here is a local fixture: KILN_GITHUB_REMOTE points the fetcher at <remotes>/<owner>/<repo>.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-repos-test-'));
const remotes = path.join(tmp, 'remotes');
process.env.KILN_GITHUB_REMOTE = remotes;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const skill = (name: string, body = 'Do the thing.') => `---\nname: ${name}\ndescription: Use when ${name} is needed.\n---\n\n# ${name}\n\n${body}\n`;
const agent = (name: string) => `---\nname: ${name}\ndescription: Reviews ${name}.\n---\n\nYou review code.\n`;
const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n';
const write = (root: string, files: Record<string, string>) => { for (const [name, text] of Object.entries(files)) { const file = path.join(root, ...name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); } };
function fixture(owner: string, name: string, files: Record<string, string>) {
  const dir = path.join(remotes, owner, name); fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=Kiln test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (next: Record<string, string>, message = 'change') => { write(dir, next); git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  const head = commit(files, 'initial');
  return { dir, git, commit, head };
}
const library = () => { const id = randomUUID().slice(0, 8); return new Workbench(path.join(tmp, `library-${id}`), path.join(tmp, `private-${id}`)); };
const wait = async (service: AgentService) => { for (let i = 0; i < 300 && (service.running || service.queued); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(service.running, 0); };

test('GitHub repository links are recognised with or without a scheme, with a ref and folder, and other pages are not', () => {
  assert.deepEqual(parseGitHubRepo('https://github.com/mattpocock/skills'), { owner: 'mattpocock', repo: 'skills', url: 'https://github.com/mattpocock/skills', rest: '', blob: false });
  assert.equal(parseGitHubRepo('  github.com/anthropics/skills.git  ')?.url, 'https://github.com/anthropics/skills');
  assert.equal(parseGitHubRepo('http://www.github.com/a/b/')?.url, 'https://github.com/a/b');
  assert.deepEqual(parseGitHubRepo('https://github.com/a/b/tree/feature/x/skills/my%20skill?tab=readme#top'), { owner: 'a', repo: 'b', url: 'https://github.com/a/b', rest: 'feature/x/skills/my skill', blob: false });
  assert.equal(parseGitHubRepo('https://github.com/a/b/blob/main/skills/x/SKILL.md')?.blob, true);
  for (const other of ['https://github.com/a/b/issues/1', 'https://github.com/a/b/pull/2', 'https://github.com/orgs/a/repos', 'https://gitlab.com/a/b', 'https://github.com/a', 'see https://github.com/a/b', 'https://github.com/a/b/tree/main/../x', 'https://github.com/a/b/tree']) assert.equal(parseGitHubRepo(other), null, other);
  const source = repoSourceOf({ kind: 'source', source: `https://github.com/a/b/tree/${'c'.repeat(40)}/skills/x` });
  assert.equal(source?.commit, 'c'.repeat(40)); assert.equal(source?.scope, 'skills/x');
  assert.equal(repoSourceOf({ kind: 'link', source: `https://github.com/a/b/tree/${'c'.repeat(40)}` }), null);
});

test('layout detection finds each skill and agent convention, and leaves bundle files, notes and unlisted plugin skills alone', () => {
  const root = path.join(tmp, 'layouts'); write(root, {
    'skills/alpha/SKILL.md': skill('alpha'), 'skills/alpha/examples/inner/SKILL.md': skill('inner'), 'skills/alpha/agents/openai.yaml': 'policy: {}\n', 'skills/alpha/agents/helper.md': agent('helper'),
    '.claude/skills/bravo/SKILL.md': skill('bravo'), '.agents/skills/charlie/SKILL.md': skill('charlie'), '.cursor/skills/delta/SKILL.md': skill('delta'), '.github/skills/echo/SKILL.md': skill('echo'),
    'plugins/p1/.claude-plugin/plugin.json': JSON.stringify({ name: 'plugin-one', skills: ['./skills/foxtrot'] }), 'plugins/p1/skills/foxtrot/SKILL.md': skill('foxtrot'), 'plugins/p1/skills/old/SKILL.md': skill('old'), 'plugins/p1/agents/p1-reviewer.md': agent('p1-reviewer'),
    '.claude-plugin/marketplace.json': JSON.stringify({ name: 'market', plugins: [{ name: 'plugin-two', source: './plugins/p2' }, { name: 'remote', source: { source: 'github', repo: 'x/y' } }] }), 'plugins/p2/skills/golf/SKILL.md': skill('golf'),
    'misc/hotel/SKILL.md': skill('hotel'),
    '.claude/agents/reviewer.md': agent('reviewer'), '.github/agents/planner.md': '---\ndescription: Plans work.\n---\nPlan.\n', 'tools/writer.agent.md': '---\ndescription: Writes.\n---\nWrite.\n', '.codex/agents/tester.toml': 'name = "tester"\ndescription = "Tests"\ndeveloper_instructions = "Test."\n',
    'agents/notes.md': '# Just notes\n', 'agents/architect.md': agent('architect'), 'docs/guide.md': '# Guide\n',
    'AGENTS.md': '# Agents\n', 'CLAUDE.md': '# Claude\n', 'README.md': '# Layouts\n', 'LICENSE': MIT,
  });
  const layout = detectLayout(root);
  const byName = Object.fromEntries(layout.skills.map(s => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'old']);
  assert.equal(byName.alpha.layout, 'skills'); assert.equal(byName.bravo.layout, '.claude/skills'); assert.equal(byName.charlie.layout, '.agents/skills'); assert.equal(byName.delta.layout, '.cursor/skills'); assert.equal(byName.echo.layout, '.github/skills');
  assert.equal(byName.foxtrot.layout, 'plugin'); assert.equal(byName.foxtrot.plugin, 'plugin-one'); assert.equal(byName.golf.plugin, 'plugin-two'); assert.equal(byName.hotel.layout, 'folder');
  assert.equal(byName.old.listed, false, 'a plugin that lists its skills leaves the others unoffered'); assert.equal(byName.foxtrot.listed, true); assert.equal(byName.alpha.listed, true);
  assert.deepEqual(layout.agents.map(a => `${a.provider}:${a.path}`), ['claude:.claude/agents/reviewer.md', 'codex:.codex/agents/tester.toml', 'copilot:.github/agents/planner.md', 'claude:agents/architect.md', 'claude:plugins/p1/agents/p1-reviewer.md', 'copilot:tools/writer.agent.md']);
  assert.deepEqual(layout.instructions, ['AGENTS.md', 'CLAUDE.md']);
  assert.equal(layout.licence, 'MIT'); assert.equal(layout.readme, 'README.md');
  assert.deepEqual(layout.plugins.map(p => p.name).sort(), ['plugin-one', 'plugin-two']);
  assert.deepEqual(detectLayout(root, 'skills').skills.map(s => s.name), ['alpha'], 'a folder link scans only that folder');
});

test('a repository scan imports skills and agents as drafts with provenance and licence, and a second scan finds them identical', async () => {
  const repo = fixture('acme', 'skills', { 'README.md': '# Acme skills\n\nSkills we use every day.\n', 'LICENSE': MIT, 'skills/review/SKILL.md': skill('review', 'See [notes](notes.md).'), 'skills/review/notes.md': 'Notes.\n', 'skills/apache/SKILL.md': skill('apache'), 'skills/apache/LICENSE.txt': 'Apache License, Version 2.0\n', '.claude/agents/checker.md': agent('checker'), 'AGENTS.md': '# House rules\n' });
  const wb = library();
  try {
    const repos = new RepoImports(wb);
    const scan = await repos.scan({ url: 'github.com/acme/skills' });
    assert.equal(scan.commit, repo.head); assert.equal(scan.collection, 'acme/skills'); assert.equal(scan.licence, 'MIT'); assert.deepEqual(scan.instructions, ['AGENTS.md']);
    assert.deepEqual(scan.skills.map(s => [s.title, s.status, s.selected, s.fileCount]), [['apache', 'new', true, 2], ['review', 'new', true, 2]]);
    assert.deepEqual(scan.agents.map(a => [a.title, a.provider, a.status]), [['checker', 'claude', 'new']]);
    assert.ok(fs.realpathSync(path.join(wb.local, 'repo-sources', 'acme__skills', repo.head)), 'the checkout sits in the machine-private cache');
    const preview = await repos.preview({ url: 'github.com/acme/skills', key: 'skill:skills/review' });
    assert.match(preview.content, /name: review/); assert.deepEqual(preview.files, ['notes.md']);

    const result = await repos.import({ url: 'https://github.com/acme/skills', confirm: true });
    assert.equal(result.imported.length, 3); assert.equal(result.collection, 'acme/skills');
    const source = wb.getItem(result.sourceItemId), sourceRevision = wb.getRevision(source.id);
    assert.equal(source.kind, 'source'); assert.equal(source.title, 'acme/skills'); assert.equal(source.source, `https://github.com/acme/skills/tree/${repo.head}`);
    assert.match(sourceRevision.content, /^https:\/\/github\.com\/acme\/skills\n\n# Acme skills/); assert.equal(source.description, 'Skills we use every day.');
    const items = wb.madeFrom(source.id), review = items.find(i => i.title === 'review')!, apache = items.find(i => i.title === 'apache')!, checker = items.find(i => i.kind === 'agent')!;
    assert.equal(review.source, `https://github.com/acme/skills/tree/${repo.head}/skills/review`); assert.equal(review.status, 'captured'); assert.equal(review.collection, 'acme/skills');
    assert.equal(review.licence, 'MIT'); assert.equal(apache.licence, 'Apache-2.0', 'a skill folder’s own licence wins');
    assert.deepEqual(Object.keys(wb.getRevision(review.id).files), ['notes.md']);
    assert.equal(checker.agent?.provider, 'claude'); assert.equal(checker.source, `https://github.com/acme/skills/tree/${repo.head}/.claude/agents/checker.md`);
    assert.equal(wb.approvals().length, 0);

    const again = await repos.scan({ url: 'https://github.com/acme/skills' });
    assert.ok([...again.skills, ...again.agents].every(e => e.status === 'identical' && !e.selected)); assert.equal(again.sourceItemId, source.id);
    const repeat = await repos.import({ url: 'https://github.com/acme/skills', confirm: true, select: ['skills/review'] });
    assert.deepEqual(repeat.imported, []); assert.deepEqual(repeat.unchanged, ['skill:skills/review']); assert.equal(repeat.sourceItemId, source.id);
    await assert.rejects(repos.import({ url: 'https://github.com/acme/skills', confirm: true, select: ['skills/missing'] }), /Not found/);
  } finally { wb.close(); }
});

test('an upstream change updates the imported item as a new draft revision, unless it was edited in Kiln; a same-named skill from elsewhere differs', async () => {
  const repo = fixture('acme', 'drift', { 'skills/one/SKILL.md': skill('one'), 'skills/two/SKILL.md': skill('two') });
  const other = fixture('someone', 'else', { 'skills/one/SKILL.md': skill('one', 'A different one.') });
  const wb = library();
  try {
    const repos = new RepoImports(wb), url = 'https://github.com/acme/drift';
    const first = await repos.import({ url, confirm: true });
    const one = first.imported.find(i => i.title === 'one')!, two = first.imported.find(i => i.title === 'two')!;
    wb.approve({ id: one.id, revision: wb.getItem(one.id).revision, reviewer: 'Me', scope: 'Personal', note: 'ok', evidence: [], waivedChecks: 'none' });
    const edited = wb.getRevision(two.id); wb.update({ id: two.id, expect: edited.hash, summary: 'My edit', value: { ...wb.authoring(two.id), content: edited.content + '\nMine.\n' } });
    const head = repo.commit({ 'skills/one/SKILL.md': skill('one', 'Improved upstream.'), 'skills/two/SKILL.md': skill('two', 'Also changed upstream.') });

    const scan = await repos.scan({ url });
    const byTitle = Object.fromEntries(scan.skills.map(s => [s.title, s]));
    assert.equal(byTitle.one.status, 'differs'); assert.deepEqual(byTitle.one.match, { itemId: one.id, title: 'one', against: 'approved', sameSource: true, edited: false }); assert.equal(byTitle.one.selected, true);
    assert.equal(byTitle.two.match?.edited, true); assert.equal(byTitle.two.selected, false, 'your edit is not replaced by default');
    const approvedRevision = wb.getItem(one.id).revision;
    const result = await repos.import({ url, confirm: true });
    assert.deepEqual(result.updated.map(u => u.id), [one.id]); assert.deepEqual(result.imported, []);
    const updated = wb.getItem(one.id);
    assert.notEqual(updated.revision, approvedRevision); assert.equal(updated.source, `https://github.com/acme/drift/tree/${head}/skills/one`);
    assert.ok(wb.approvals().some(a => a.itemId === one.id && a.revision === approvedRevision), 'the approval stays on the reviewed revision');
    assert.equal(wb.getItem(result.sourceItemId).source, `https://github.com/acme/drift/tree/${head}`, 'the source item follows the newer commit');

    const elsewhere = await repos.scan({ url: 'https://github.com/someone/else' });
    assert.equal(elsewhere.skills[0].status, 'differs'); assert.equal(elsewhere.skills[0].match?.sameSource, false);
    const copy = await repos.import({ url: 'https://github.com/someone/else', confirm: true });
    assert.equal(copy.imported.length, 1); assert.notEqual(copy.imported[0].id, one.id);
    assert.ok(other.head);
  } finally { wb.close(); }
});

test('a symlink in a skill folder arrives as the text of its target, never the file it points at', async () => {
  const secret = path.join(tmp, 'secret.txt'); fs.writeFileSync(secret, 'TOP SECRET');
  const repo = fixture('acme', 'links', { 'skills/linked/SKILL.md': skill('linked') });
  fs.symlinkSync(secret, path.join(repo.dir, 'skills', 'linked', 'key.txt'));
  repo.commit({}, 'add link');
  const wb = library();
  try {
    const result = await new RepoImports(wb).import({ url: 'https://github.com/acme/links', confirm: true });
    const files = wb.getRevision(result.imported[0].id).files;
    // Git for Windows records the link target with forward slashes.
    assert.equal(Buffer.from(files['key.txt'], 'base64').toString('utf8').replaceAll('\\', '/'), secret.replaceAll('\\', '/'));
  } finally { wb.close(); }
});

test('a tree link with a slashed branch scans only its folder, and a missing folder is reported', async () => {
  const repo = fixture('acme', 'branches', { 'skills/a/SKILL.md': skill('a'), 'skills/b/SKILL.md': skill('b') });
  repo.git('checkout', '-q', '-b', 'feature/new'); const head = repo.commit({ 'skills/c/SKILL.md': skill('c') }); repo.git('checkout', '-q', 'main');
  const wb = library();
  try {
    const repos = new RepoImports(wb);
    const scan = await repos.scan({ url: 'https://github.com/acme/branches/tree/feature/new/skills/c' });
    assert.equal(scan.ref, 'feature/new'); assert.equal(scan.scope, 'skills/c'); assert.equal(scan.commit, head); assert.deepEqual(scan.skills.map(s => s.title), ['c']);
    const blob = await repos.scan({ url: 'https://github.com/acme/branches/blob/main/skills/a/SKILL.md' });
    assert.deepEqual(blob.skills.map(s => s.title), ['a']);
    const result = await repos.import({ url: 'https://github.com/acme/branches/tree/feature/new/skills/c', confirm: true });
    assert.equal(wb.getItem(result.sourceItemId).title, 'acme/branches · skills/c');
    await assert.rejects(repos.scan({ url: 'https://github.com/acme/branches/tree/main/nowhere' }), /not a folder/);
    await assert.rejects(repos.scan({ url: 'https://github.com/acme/missing' }), (error: Error) => /REPOSITORY_UNAVAILABLE|does not exist|not found|not appear/i.test(`${(error as { code?: string }).code} ${error.message}`));
  } finally { wb.close(); }
});

test('Dig deeper runs a repository distillation in the checkout and files new skills with their bundles beside the imports', async () => {
  const repo = fixture('acme', 'deeper', { 'README.md': '# Deeper\n\nRun `npm run release` to ship.\n', 'skills/known/SKILL.md': skill('known'), 'scripts/release.sh': 'echo release\n' });
  const wb = library();
  try {
    const repos = new RepoImports(wb);
    const imported = await repos.import({ url: 'https://github.com/acme/deeper', confirm: true });
    fs.rmSync(path.join(wb.local, 'repo-sources'), { recursive: true, force: true }); // A retry days later fetches the recorded commit again.
    let input: { prompt: string; workdir?: string; writable?: string[]; persist?: boolean; schema?: object } | undefined;
    const service = new AgentService(wb, () => {}, async run => { input = run; return {
      collection: 'ignored', summary: 'A release workflow lives in scripts.', takeaway: 'Ship with the script.', skipped: '',
      entries: [
        { type: 'skill', title: 'Release', description: 'Ship a release the house way.', content: skill('release-acme', 'Run [the script](release.sh).'), url: '', timestamp: '', tags: ['release'], files: [{ path: 'release.sh', content: 'npm run release\n' }] },
        { type: 'technique', title: 'Release from main', description: 'Always release from main.', content: '1. Check out main.\n2. Run the script.', url: `https://github.com/acme/deeper/blob/${repo.head}/README.md`, timestamp: '', tags: ['release'], files: [] },
        { type: 'skill', title: 'Known again', description: 'Duplicate.', content: skill('known'), url: '', timestamp: '', tags: [], files: [] },
      ] }; }, async () => []);
    const job = service.start({ id: imported.sourceItemId, kind: 'distill' });
    assert.equal(job.kind, 'distill-repo');
    await wait(service);
    const done = service.list().find(j => j.id === job.id)!;
    assert.equal(done.status, 'completed', done.error);
    assert.equal(input!.workdir, path.join(wb.local, 'repo-sources', 'acme__deeper', repo.head)); assert.equal(input!.writable, undefined, 'read-only run'); assert.equal(input!.persist, true);
    assert.match(input!.prompt, /Distill this captured source material/); assert.match(input!.prompt, /One more entry type applies here, whichever types are listed above\. skill:/); assert.match(input!.prompt, /skills\/known \(known\)/);
    assert.match(JSON.stringify(input!.schema), /"skill"/);
    assert.equal(done.createdItemIds?.length, 2, 'the skill identical to an import is skipped');
    const made = done.createdItemIds!.map(id => wb.getItem(id));
    const release = made.find(i => i.kind === 'skill')!, technique = made.find(i => i.kind === 'technique')!;
    assert.equal(release.title, 'release-acme'); assert.equal(release.origin?.itemId, imported.sourceItemId); assert.equal(release.collection, 'acme/deeper');
    assert.equal(Buffer.from(wb.getRevision(release.id).files['release.sh'], 'base64').toString('utf8'), 'npm run release\n');
    assert.doesNotMatch(wb.getRevision(release.id).content, /From “/, 'a skill carries no source footer');
    assert.equal(technique.collection, 'acme/deeper');
    const source = wb.getItem(imported.sourceItemId);
    assert.equal(source.kind, 'source'); assert.equal(source.description, 'A release workflow lives in scripts.');
    assert.ok(wb.analyses(source.id)[0].counts.skill, 'the analysis record counts skill entries');
    assert.throws(() => service.start({ id: release.id, kind: 'distill-repo' }), /Only a GitHub repository source/);
  } finally { wb.close(); }
});

test('the public repository list starts with the curated defaults and keeps only GitHub links when edited', () => {
  const wb = library();
  try {
    const repos = new RepoImports(wb);
    assert.deepEqual(repos.registries(), DEFAULT_REGISTRIES);
    assert.ok(DEFAULT_REGISTRIES.some(r => r.url === 'https://github.com/anthropics/skills') && DEFAULT_REGISTRIES.some(r => r.url === 'https://github.com/mattpocock/skills'));
    assert.deepEqual(repos.saveRegistries({ repositories: [{ url: 'github.com/acme/skills.git', description: 'Ours' }, { url: 'https://github.com/acme/skills' }, { url: 'https://github.com/a/b/tree/main/skills' }] }), [{ url: 'https://github.com/acme/skills', description: 'Ours' }, { url: 'https://github.com/a/b/tree/main/skills', description: '' }]);
    assert.equal(repos.registries().length, 2);
    assert.throws(() => repos.saveRegistries({ repositories: [{ url: 'https://example.com/x' }] }), /GitHub repository link/);
  } finally { wb.close(); }
});

test('the CLI scans and imports a repository with JSON output', () => {
  fixture('acme', 'cli', { 'skills/one/SKILL.md': skill('one'), 'skills/two/SKILL.md': skill('two') });
  const cli = path.join(tmp, 'workbench.cjs'); buildSync({ entryPoints: ['apps/cli/main.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: cli, target: 'node22', logLevel: 'silent' });
  const lib = path.join(tmp, 'cli-library'), local = path.join(tmp, 'cli-private');
  const run = (...args: string[]) => { const out = spawnSync(process.execPath, [cli, ...args, '--library', lib, '--local', local], { encoding: 'utf8', env: { ...process.env, KILN_GITHUB_REMOTE: remotes } }); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout).data; };
  const scan = run('repos', 'scan', 'https://github.com/acme/cli');
  assert.deepEqual(scan.skills.map((s: { key: string; status: string }) => `${s.key}:${s.status}`), ['skill:skills/one:new', 'skill:skills/two:new']);
  const result = run('repos', 'import', 'https://github.com/acme/cli', '--select', 'skill:skills/two', '--collection', 'Picked');
  assert.deepEqual(result.imported.map((i: { title: string }) => i.title), ['two']); assert.equal(result.collection, 'Picked');
  assert.equal(run('repos', 'list').length, DEFAULT_REGISTRIES.length);
  assert.deepEqual(parseArguments(['repos', 'import', 'https://github.com/a/b', '--select', 'x']).ids, ['https://github.com/a/b']);
  assert.throws(() => parseArguments(['repos', 'scan']), /one ID/);
});
