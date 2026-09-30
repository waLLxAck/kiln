import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { HomeFiles } from '../packages/home/service';
import { WorkbenchError } from '../packages/domain/errors';
import { contentChecks } from '../packages/domain/content-checks';
import { fromNative, mcpIdentity, McpTranslationError, parseMcp, scrubSecrets, serialiseMcp, toNative, type McpClient, type McpServer } from '../packages/domain/mcp-format';
import { tomlWith } from '../packages/deployment/mcp';
import type { McpCopy, McpScan, McpStatus } from '../packages/deployment/mcp';
import { parseArguments } from '../apps/cli/arguments';

const github: McpServer = { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } };
const docs: McpServer = { name: 'docs', transport: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': 'web' } };
const hasCode = (code: string) => (error: unknown) => error instanceof WorkbenchError && error.code === code;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-mcp-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private', 'local'));
  const homeFiles = new HomeFiles({ home, privateRoot: path.join(root, 'private'), env: {}, platform: 'linux', probe: async () => null });
  const router = new Router(wb, { composer: null, home: homeFiles });
  const project = path.join(root, 'Web app'); fs.mkdirSync(project);
  const call = <T = any>(method: string, args: unknown = {}) => router.call(method, args) as T;
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const create = (server: McpServer) => wb.create({ title: server.name, kind: 'mcp', content: serialiseMcp(server) });
  const copy = (itemId: string, client: McpClient, where = '') => call<McpStatus>('mcp.status', { itemId, ...(where ? { project: where } : {}) }).copies.find(c => c.client === client && c.project === where && !c.renamed) as McpCopy;
  return { root, home, wb, router, project, call, write, create, copy, homeFiles, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('a definition translates to each client’s own entry and back, with that client’s variable spelling', () => {
  assert.deepEqual(toNative('claude', github), { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
  assert.deepEqual(toNative('cursor', github), { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } });
  assert.deepEqual(toNative('vscode', docs), { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer ${env:DOCS_TOKEN}', 'X-Team': 'web' } });
  assert.deepEqual(toNative('copilot', github), { type: 'local', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }, tools: ['*'] });
  assert.deepEqual(toNative('codex', github), { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env_vars: ['GITHUB_TOKEN'] }, 'Codex forwards the variable by name');
  assert.deepEqual(toNative('codex', docs), { url: 'https://docs.example.com/mcp', bearer_token_env_var: 'DOCS_TOKEN', http_headers: { 'X-Team': 'web' } });
  for (const client of ['claude', 'codex', 'copilot', 'vscode', 'cursor'] as McpClient[]) for (const server of [github, docs]) {
    const back = fromNative(client, server.name, toNative(client, server));
    assert.ok(back, `${client} reads its own entry`); assert.deepEqual(back.dropped, []);
    assert.equal(mcpIdentity(back.server), mcpIdentity(server), `${client} round-trips ${server.name}`);
  }
  assert.throws(() => toNative('codex', { ...docs, transport: 'sse' }), McpTranslationError, 'Codex has no sse transport');
  assert.throws(() => toNative('codex', { ...github, env: { TOKEN: '${GITHUB_TOKEN}' } }), McpTranslationError, 'Codex cannot rename a variable');
  const codex = fromNative('codex', 'x', { command: 'uvx', args: ['srv'], env: { MODE: 'fast' }, env_vars: ['KEY'], startup_timeout_sec: 20 });
  assert.deepEqual(codex?.server.env, { KEY: '${KEY}', MODE: 'fast' }); assert.deepEqual(codex?.dropped, ['startup_timeout_sec'], 'fields a definition has no place for are named');
  assert.equal(fromNative('claude', 'x', { type: 'sse', url: 'https://a.example/sse' })?.server.transport, 'sse');
  assert.equal(fromNative('claude', 'x', { foo: 1 }), null, 'neither a command nor a url');
});

test('content checks reject malformed definitions and literal secrets, and import scrubs secrets into references', () => {
  const check = (content: string) => contentChecks({ kind: 'mcp', content, files: {} }).map(p => p.message);
  assert.deepEqual(check(serialiseMcp(github)), []);
  assert.match(check('{ nope')[0], /is JSON/);
  assert.match(check('{"name":"a b","transport":"stdio","command":"x"}')[0], /name of letters/);
  assert.match(check('{"name":"a","transport":"stdio"}')[0], /needs the command/);
  assert.match(check('{"name":"a","transport":"http","url":"ftp://x"}')[0], /http\(s\) url/);
  assert.match(check('{"name":"a","transport":"stdio","command":"x","port":1}')[0], /Unknown field “port”/);
  const leaked = check(JSON.stringify({ name: 'gh', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }, null, 2));
  assert.equal(leaked.length, 1); assert.match(leaked[0], /env\.GITHUB_TOKEN looks like a literal secret.*\$\{GITHUB_TOKEN\}/);
  assert.deepEqual(check(JSON.stringify({ name: 'gh', transport: 'stdio', command: 'npx', env: { LOG_LEVEL: 'debug', CONFIG_FILE: '/etc/token.json', API_KEY_PATH: '~/key' } })), [], 'plain settings and paths are not secrets');
  assert.match(check(JSON.stringify({ name: 'd', transport: 'http', url: 'https://x.example', headers: { Authorization: 'Bearer abcdefghijklmnop' } }))[0], /headers\.Authorization/);
  const scrubbed = scrubSecrets({ ...docs, headers: { Authorization: 'Bearer abcdefghijklmnopqrstu' } });
  assert.deepEqual(scrubbed.server.headers, { Authorization: 'Bearer ${DOCS_TOKEN}' }); assert.deepEqual(scrubbed.replaced, ['headers.Authorization']);
  assert.deepEqual(scrubSecrets({ ...github, env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } }).server.env, { GITHUB_TOKEN: '${GITHUB_TOKEN}' });
  assert.deepEqual(parseMcp(serialiseMcp(github)).server, github);
});

test('installing writes only the server’s entry: other JSON keys, comments and layout stay byte for byte', () => {
  const f = fixture();
  try {
    const state = `{\n  "numStartups": 12,\n  "oauthAccount": { "emailAddress": "me@example.com" },\n  "mcpServers": {\n    "other": { "type": "stdio", "command": "other-server" }\n  },\n  "projects": { "/x": { "allowedTools": [] } }\n}\n`;
    const claudeFile = f.write(path.join(f.home, '.claude.json'), state); fs.chmodSync(claudeFile, 0o600);
    const vscode = `// Workspace servers\n{\n\t"inputs": [],\n\t"servers": {\n\t\t// keep me\n\t\t"local": { "type": "stdio", "command": "local" }\n\t}\n}\n`;
    const vscodeFile = f.write(path.join(f.project, '.vscode', 'mcp.json'), vscode);
    const item = f.create(github);
    const installed = f.call('mcp.install', { itemId: item.id, client: 'claude', confirm: true });
    assert.equal(installed.method, 'installed'); assert.equal(installed.approved, true, 'installing a draft approves exactly that revision');
    const after = fs.readFileSync(claudeFile, 'utf8'), parsed = JSON.parse(after);
    assert.deepEqual(parsed.mcpServers.github, toNative('claude', github));
    assert.deepEqual({ ...parsed, mcpServers: { other: parsed.mcpServers.other } }, JSON.parse(state), 'every other key is unchanged');
    assert.ok(after.startsWith('{\n  "numStartups": 12,\n  "oauthAccount": { "emailAddress": "me@example.com" },\n  "mcpServers": {\n    "other": { "type": "stdio", "command": "other-server" },'), 'text before the entry is untouched');
    assert.ok(after.endsWith('  },\n  "projects": { "/x": { "allowedTools": [] } }\n}\n'));
    // Windows has no POSIX permission bits; there the mode check says nothing.
    if (process.platform !== 'win32') assert.equal(fs.statSync(claudeFile).mode & 0o777, 0o600, 'a private file stays private');
    f.call('mcp.install', { itemId: item.id, client: 'vscode', project: f.project, confirm: true });
    const vsAfter = fs.readFileSync(vscodeFile, 'utf8');
    assert.ok(vsAfter.startsWith('// Workspace servers\n{\n\t"inputs": [],\n\t"servers": {\n\t\t// keep me\n\t\t"local": { "type": "stdio", "command": "local" },'), 'comments and tabs are kept');
    assert.match(vsAfter, /"GITHUB_TOKEN": "\$\{env:GITHUB_TOKEN\}"/);
    assert.equal(f.copy(item.id, 'vscode', f.project).state, 'installed');
    assert.ok(f.homeFiles.savedProjects().includes(f.project), 'the project becomes one of your projects');
    // New files are created with only the servers table.
    f.call('mcp.install', { itemId: item.id, client: 'cursor', confirm: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, '.cursor', 'mcp.json'), 'utf8')), { mcpServers: { github: toNative('cursor', github) } });
    // Removing restores the files exactly.
    f.call('mcp.remove', { itemId: item.id, client: 'claude', confirm: true });
    assert.equal(fs.readFileSync(claudeFile, 'utf8'), state, 'removing only removes that entry');
    f.call('mcp.remove', { itemId: item.id, client: 'vscode', project: f.project, confirm: true });
    assert.equal(fs.readFileSync(vscodeFile, 'utf8'), vscode);
    assert.equal(f.copy(item.id, 'claude').state, 'absent');
    const kept = fs.readdirSync(path.join(f.root, 'private', 'home-backups', 'claude-state'));
    assert.equal(kept.length, 2, 'each write keeps the previous file under the Config files key for ~/.claude.json');
  } finally { f.close(); }
});

test('Codex installs replace only their own TOML table, honour CODEX_HOME and keep comments and other tables', () => {
  const f = fixture();
  try {
    const codexHome = path.join(f.root, 'codex-home');
    const homeFiles = new HomeFiles({ home: f.home, privateRoot: path.join(f.root, 'private'), env: { CODEX_HOME: codexHome }, platform: 'linux', probe: async () => null });
    const router = new Router(f.wb, { composer: null, home: homeFiles });
    const config = `# my settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other" # inline comment\n\n# notes about profiles\n[profiles.fast]\nmodel = "mini"\n`;
    const file = f.write(path.join(codexHome, 'config.toml'), config);
    const item = f.create(docs);
    router.call('mcp.install', { itemId: item.id, client: 'codex', confirm: true });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith(config), 'a new table is appended; everything before stays');
    assert.deepEqual((parseToml(text) as any).mcp_servers.docs, { url: 'https://docs.example.com/mcp', bearer_token_env_var: 'DOCS_TOKEN', http_headers: { 'X-Team': 'web' } });
    // An update rewrites the table in place.
    const v2 = f.wb.update({ id: item.id, expect: item.revision, summary: 'new url', value: { ...f.wb.authoring(item.id), content: serialiseMcp({ ...docs, url: 'https://docs.example.com/v2/mcp' }) } });
    const status = router.call('mcp.status', { itemId: item.id }) as McpStatus;
    assert.equal(status.copies.find(c => c.client === 'codex' && !c.project)?.state, 'installed');
    const result = router.call('mcp.install', { itemId: item.id, client: 'codex', confirm: true }) as { method: string };
    assert.equal(result.method, 'updated');
    const updated = fs.readFileSync(file, 'utf8');
    assert.ok(updated.startsWith(config) && updated.includes('url = "https://docs.example.com/v2/mcp"') && !updated.includes('/docs.example.com/mcp"'));
    router.call('mcp.remove', { itemId: item.id, client: 'codex', confirm: true });
    assert.equal(fs.readFileSync(file, 'utf8'), config, 'removing leaves the file as it was');
    assert.equal(v2.revision.length, 64);
    // Tables in the middle of a file are replaced where they are, with their subtables.
    const middle = `[mcp_servers.docs]\nurl = "https://old"\n\n[mcp_servers.docs.env_http_headers]\nX = "Y"\n\n# next\n[mcp_servers.other]\ncommand = "o"\n`;
    const replaced = tomlWith(middle, 'mcp_servers', 'docs', { url: 'https://new' }, parseToml(middle) as Record<string, unknown>);
    assert.equal(replaced, `[mcp_servers.docs]\nurl = "https://new"\n\n# next\n[mcp_servers.other]\ncommand = "o"\n`);
    assert.throws(() => tomlWith('mcp_servers.docs = { url = "x" }\n', 'mcp_servers', 'docs', { url: 'y' }, { mcp_servers: { docs: { url: 'x' } } }), hasCode('TOML_LAYOUT_UNSUPPORTED'), 'an inline entry is refused, not rewritten');
    assert.throws(() => router.call('mcp.install', { itemId: f.create({ ...docs, name: 'events', transport: 'sse' }).id, client: 'codex', confirm: true }), hasCode('CLIENT_UNSUPPORTED'));
  } finally { f.close(); }
});

test('drift, external entries, replace, rollback and stale-file guards', () => {
  const f = fixture();
  try {
    const item = f.create(github);
    const file = f.write(path.join(f.project, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'docker', args: ['run', 'gh'] } } }, null, 2) + '\n');
    const original = fs.readFileSync(file, 'utf8');
    assert.equal(f.copy(item.id, 'claude', f.project).state, 'external', 'an entry Kiln did not write');
    assert.equal(f.copy(item.id, 'claude', f.project).matches, false);
    assert.throws(() => f.call('mcp.install', { itemId: item.id, client: 'claude', project: f.project, confirm: true }), hasCode('TARGET_UNMANAGED'));
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'refused installs write nothing');
    const stale = f.copy(item.id, 'claude', f.project).hash;
    fs.appendFileSync(file, '\n');
    assert.throws(() => f.call('mcp.install', { itemId: item.id, client: 'claude', project: f.project, replace: true, expect: stale, confirm: true }), hasCode('FILE_CHANGED'), 'a file changed since the preview is refused');
    const replaced = f.call('mcp.install', { itemId: item.id, client: 'claude', project: f.project, replace: true, confirm: true });
    assert.equal(replaced.method, 'replaced');
    assert.equal(f.copy(item.id, 'claude', f.project).state, 'installed');
    // Edited outside Kiln: drifted, and rollback refuses.
    const edited = JSON.parse(fs.readFileSync(file, 'utf8')); edited.mcpServers.github.args.push('--verbose'); fs.writeFileSync(file, JSON.stringify(edited, null, 2));
    assert.equal(f.copy(item.id, 'claude', f.project).state, 'drifted');
    assert.throws(() => f.call('mcp.rollback', { receiptId: replaced.receipt.id, confirm: true }), hasCode('TARGET_DRIFTED'));
    assert.throws(() => f.call('mcp.install', { itemId: item.id, client: 'claude', project: f.project, confirm: true }), hasCode('TARGET_DRIFTED'));
    assert.throws(() => f.call('mcp.remove', { itemId: item.id, client: 'claude', project: f.project, confirm: true }), hasCode('TARGET_DRIFTED'));
    const again = f.call('mcp.install', { itemId: item.id, client: 'claude', project: f.project, replace: true, confirm: true });
    // Rollback puts back the entry that install replaced: here Kiln's own earlier entry, which the user had edited.
    f.call('mcp.rollback', { receiptId: again.receipt.id, confirm: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.github.args.at(-1), '--verbose');
    // An identical entry written by someone else is adopted without a write.
    const other = f.write(path.join(f.home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }, tools: ['*'] } } }));
    const before = fs.readFileSync(other, 'utf8');
    assert.equal(f.copy(item.id, 'copilot').matches, true);
    assert.equal(f.call('mcp.install', { itemId: item.id, client: 'copilot', confirm: true }).method, 'adopted');
    assert.equal(fs.readFileSync(other, 'utf8'), before);
    assert.equal(f.copy(item.id, 'copilot').state, 'installed');
    // Outdated: a newer approved revision renders differently.
    const next = f.wb.update({ id: item.id, expect: f.wb.getItem(item.id).revision, summary: 'pin', value: { ...f.wb.authoring(item.id), content: serialiseMcp({ ...github, args: ['-y', '@modelcontextprotocol/server-github@1.2.0'] }) } });
    f.wb.approve({ id: item.id, revision: next.revision, reviewer: 'tester', scope: 'test', note: 'ok', waivedChecks: 'test' });
    assert.equal(f.copy(item.id, 'copilot').outdated, true);
    assert.equal(f.call('mcp.install', { itemId: item.id, client: 'copilot', confirm: true }).method, 'updated');
    assert.equal(f.copy(item.id, 'copilot').outdated, undefined);
  } finally { f.close(); }
});

test('import finds each distinct server once across clients and projects, scrubs secrets, and skips what the library has', () => {
  const f = fixture();
  try {
    f.write(path.join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } } }, projects: { [f.project]: { mcpServers: { local: { command: 'local-tool' } } } } }));
    f.write(path.join(f.home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } } } }));
    f.write(path.join(f.home, '.codex', 'config.toml'), '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\nenv_vars = ["GITHUB_TOKEN"]\n\n[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n');
    f.write(path.join(f.project, '.vscode', 'mcp.json'), '{ "servers": { "docs": { "type": "http", "url": "https://docs.example.com/mcp" } } }');
    f.write(path.join(f.project, '.mcp.json'), '{ "mcpServers": { "github": { "command": "docker", "args": ["run", "gh"] } } }');
    const scan = f.call<McpScan>('mcp.scan');
    const byName = (name: string) => scan.servers.filter(s => s.name === name);
    assert.equal(byName('github').length, 2, 'the same name with a different definition stays separate');
    const shared = byName('github').find(s => s.found.length === 3)!;
    assert.deepEqual(shared.found.map(x => x.client).sort(), ['claude', 'codex', 'cursor'], 'identical definitions found in three clients are one entry');
    assert.deepEqual(shared.server.env, { GITHUB_TOKEN: '${GITHUB_TOKEN}' }); assert.deepEqual(shared.replaced, ['env.GITHUB_TOKEN'], 'the literal token became a reference');
    assert.deepEqual(byName('docs')[0].found.map(x => [x.client, x.scope]).sort(), [['codex', 'personal'], ['vscode', 'project']]);
    assert.equal(byName('local')[0].found[0].scope, 'local', 'Claude’s per-project entries in ~/.claude.json are found');
    const result = f.call('mcp.import', { keys: [shared.key] });
    assert.equal(result.created.length, 1);
    const item = f.wb.getItem(result.created[0].id), content = f.wb.getRevision(item.id).content;
    assert.equal(item.kind, 'mcp'); assert.equal(item.status, 'captured'); assert.ok(!content.includes('ghp_'), 'no secret reaches the library');
    assert.equal(f.call<McpScan>('mcp.scan').servers.find(s => s.key === shared.key)?.itemId, item.id, 'rescanning marks it as in the library');
    assert.deepEqual(f.call('mcp.import', { keys: [shared.key] }).skipped, [{ key: shared.key, reason: 'already in the library' }]);
    assert.equal(f.call('mcp.import', { all: true }).created.length, 3, 'the rest: docs, local and the other github');
    // Entries Kiln installed are not offered again.
    const docsItem = f.wb.listItems().find(i => i.title === 'docs')!;
    f.call('mcp.install', { itemId: docsItem.id, client: 'cursor', confirm: true });
    assert.ok(!f.call<McpScan>('mcp.scan').servers.some(s => s.found.some(x => x.client === 'cursor' && x.file.endsWith(path.join('.cursor', 'mcp.json')) && s.name === 'docs')));
  } finally { f.close(); }
});

test('the CLI accepts the mcp commands and refuses incomplete ones', () => {
  assert.equal(parseArguments(['mcp', 'install', 'id', '--client', 'codex', '--project', '/x', '--replace']).option('replace'), 'true');
  assert.deepEqual(parseArguments(['mcp', 'import', 'a', 'b']).ids, ['a', 'b']);
  assert.throws(() => parseArguments(['mcp', 'import']), /--all or the keys/);
  assert.throws(() => parseArguments(['mcp', 'install', 'id', '--client', 'zed']), /--client claude/);
  assert.throws(() => parseArguments(['mcp', 'rollback']), /--receipt/);
});
