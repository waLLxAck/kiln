import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';
import { HomeFiles } from '../packages/home/service';
import { UsageService, type SkillRow, type UsageReport } from '../packages/usage/service';
import { defaultPrices, estimateCost, normaliseModel, priceFor, noTokens } from '../packages/usage/prices';
import { projectOf } from '../packages/usage/transcripts';
import { parseArguments } from '../apps/cli/arguments';
import { dollars, filterSkills, nextSort, sortSkills, sortSpend, tokens, trend } from '../apps/desktop/src/usage-model';

// Usage: skill use and token spend from synthetic Claude Code and Codex logs, read incrementally into a machine-private cache.
const DAY = 86_400_000;
/** Local noon `days` days ago, so a fixture's day never depends on the time the test runs. */
const at = (days: number, minute = 0) => { const d = new Date(); d.setHours(12, minute, 0, 0); return new Date(d.getTime() - days * DAY).toISOString(); };
const jsonl = (lines: object[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const skill = (name: string) => `---\nname: ${name}\ndescription: Does ${name} carefully.\n---\n\n# ${name}\n`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-usage-'));
  const home = path.join(root, 'home'), claudeConfig = path.join(root, 'claude-config'), proj = path.join(root, 'code', 'shop'), proj2 = path.join(root, 'code', 'game');
  for (const folder of [home, proj, proj2]) fs.mkdirSync(folder, { recursive: true });
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  // Claude's logs follow CLAUDE_CONFIG_DIR; Codex's stay in the home folder's .codex.
  const router = new Router(wb, { composer: null, home: new HomeFiles({ home, privateRoot: path.join(root, 'private-home'), env: { CLAUDE_CONFIG_DIR: claudeConfig } }) });
  const claudeFile = path.join(claudeConfig, 'projects', '-code-shop', 's1.jsonl');
  const subagentFile = path.join(claudeConfig, 'projects', '-code-shop', 's1', 'subagents', 'agent-a1.jsonl');
  const codexFile = path.join(home, '.codex', 'sessions', '2026', '09', '29', 'rollout-2026-09-29T10-00-00-t1.jsonl');
  const forkFile = path.join(home, '.codex', 'sessions', '2026', '09', '29', 'rollout-2026-09-29T10-05-00-t2.jsonl');
  const base = (folder: string) => `Base directory for this skill: ${folder}\n\n# Skill\nBody`;
  fs.mkdirSync(path.dirname(subagentFile), { recursive: true }); fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(claudeFile, jsonl([
    { type: 'user', uuid: 'u1', sessionId: 's1', cwd: proj, timestamp: at(1), message: { role: 'user', content: 'Review my change' } },
    // One response written as two lines with the same id: the second only adds its growth.
    { type: 'assistant', sessionId: 's1', cwd: proj, timestamp: at(1, 1), message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 150, ephemeral_1h_input_tokens: 50 }, output_tokens: 5 }, content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', sessionId: 's1', cwd: proj, timestamp: at(1, 1), message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 150, ephemeral_1h_input_tokens: 50 }, output_tokens: 20, output_tokens_details: { thinking_tokens: 7 } }, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'careful-review' } }] } },
    { type: 'user', uuid: 'u2', sessionId: 's1', cwd: proj, timestamp: at(1, 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: careful-review' }] } },
    { type: 'user', uuid: 'u3', isMeta: true, sourceToolUseID: 'toolu_1', sessionId: 's1', cwd: proj, timestamp: at(1, 1), message: { role: 'user', content: [{ type: 'text', text: base(path.join(home, '.claude', 'skills', 'careful-review')) }] } },
    // Typed as /tidy: the skill's text arrives without sourceToolUseID.
    { type: 'user', uuid: 'u4', sessionId: 's1', cwd: proj, timestamp: at(3), message: { role: 'user', content: '<command-message>tidy</command-message>\n<command-name>/tidy</command-name>' } },
    { type: 'user', uuid: 'u5', sessionId: 's1', cwd: proj, timestamp: at(3), message: { role: 'user', content: [{ type: 'text', text: 'Tidy it' }, { type: 'text', text: base('/nowhere/skills/tidy') }] } },
    { type: 'assistant', sessionId: 's1', cwd: proj, timestamp: at(3, 1), message: { id: 'm9', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 }, content: [] } },
  ]));
  // A subagent: the parent's sessionId, a worktree of the same project, the older `command` input.
  fs.writeFileSync(subagentFile, jsonl([
    { type: 'assistant', agentId: 'a1', isSidechain: true, sessionId: 's1', cwd: path.join(proj, '.claude', 'worktrees', 'agent-a1'), timestamp: at(1, 5), message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: 'tool_use', id: 'toolu_2', name: 'Skill', input: { command: '/careful-review' } }] } },
  ]));
  const lintFolder = path.join(proj2, '.agents', 'skills', 'lint-fix');
  fs.mkdirSync(lintFolder, { recursive: true }); fs.writeFileSync(path.join(lintFolder, 'SKILL.md'), skill('lint-fix'));
  const skillMessage = { timestamp: at(0), type: 'response_item', payload: { type: 'message', id: 'msg1', role: 'user', content: [{ type: 'input_text', text: `<skill>\n<name>careful-review</name>\n<path>/x/.agents/skills/careful-review/SKILL.md</path>\n---\nname: careful-review\n---\n</skill>` }] } };
  fs.writeFileSync(codexFile, jsonl([
    { timestamp: at(0), type: 'session_meta', payload: { id: 't1', session_id: 't1', cwd: proj2, base_instructions: { text: 'long' } } },
    { timestamp: at(0), type: 'turn_context', payload: { turn_id: 'turn1', model: 'gpt-5.5', cwd: proj2 } },
    skillMessage,
    // The same skill read in the same turn is one use, the explicit one.
    { timestamp: at(0, 1), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"cat /x/.agents/skills/careful-review/SKILL.md"}))' } },
    { timestamp: at(0, 2), type: 'turn_context', payload: { turn_id: 'turn2', model: 'gpt-5.5', cwd: proj2 } },
    { timestamp: at(0, 2), type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'shell', arguments: JSON.stringify({ cmd: 'sed -n 1,80p .agents/skills/lint-fix/SKILL.md' }) } },
    { timestamp: at(0, 3), type: 'token_usage_record', payload: { thread_id: 't1', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 } } },
    { timestamp: at(0, 3), type: 'token_usage_record', payload: { thread_id: 'someone-else', usage: { input_tokens: 5000, output_tokens: 5000 } } },
    { timestamp: at(0, 3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9999, output_tokens: 9999 } } } },
  ]));
  // A forked subagent: its own thread first, then the parent's history (and meta) copied in. No usage records: running totals.
  fs.writeFileSync(forkFile, jsonl([
    { timestamp: at(0, 5), type: 'session_meta', payload: { id: 't2', session_id: 't1', cwd: proj2 } },
    { timestamp: at(0, 5), type: 'session_meta', payload: { id: 't1', session_id: 't1', cwd: proj2 } },
    skillMessage,
    { timestamp: at(0, 5), type: 'turn_context', payload: { turn_id: 'turn9', model: 'gpt-5.5', cwd: proj2 } },
    { timestamp: at(0, 6), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } } },
    { timestamp: at(0, 6), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } } },
    { timestamp: at(0, 7), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 30 } } } },
  ]));
  const report = async (days = 30) => await router.call('usage.report', { days }) as UsageReport;
  return { root, home, proj, proj2, wb, router, claudeFile, subagentFile, codexFile, forkFile, lintFolder, report, close() { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const approve = (wb: Workbench, id: string) => wb.approve({ id, revision: wb.getItem(id).revision, reviewer: 'tester', scope: 'Fixture', note: 'ok', waivedChecks: 'fixture' });
const row = (report: UsageReport, name: string) => report.skills.find(s => s.name === name || s.title === name)!;

test('reads skill uses from both harnesses, maps them to library items, and keeps only counts', async () => {
  const f = fixture();
  try {
    const item = f.wb.create({ title: 'careful-review', kind: 'skill', content: skill('careful-review') });
    const report = await f.report();
    assert.equal(report.scan.complete, true); assert.equal(report.scan.files, 4);
    const review = row(report, 'careful-review');
    // Two Claude uses (the Skill tool, in the session and its subagent) and one Codex use named with $; the read in the same turn is not counted again.
    assert.equal(review.itemId, item.id); assert.equal(review.uses, 3); assert.equal(review.inferred, 0);
    assert.deepEqual(review.harnesses, ['claude', 'codex']); assert.deepEqual(review.signals, ['explicit', 'tool']);
    assert.deepEqual(review.projects, [f.proj2, f.proj]); assert.equal(review.activeDays, 2);
    assert.equal(review.daily.at(-1), 1); assert.equal(review.daily.at(-2), 2);
    // Typed as /tidy: not in the library, and its folder is gone, so there is nothing to import.
    const tidy = row(report, 'tidy');
    assert.equal(tidy.itemId, null); assert.deepEqual(tidy.signals, ['slash']); assert.equal(tidy.importable, false);
    // Codex read lint-fix's SKILL.md by a relative path: inferred, resolved against the session's folder, importable.
    const lint = row(report, 'lint-fix');
    assert.equal(lint.inferred, 1); assert.equal(lint.folder, f.lintFolder); assert.equal(lint.importable, true);

    // One click imports it through the existing import flow; the next report maps it to the new item.
    const imported = f.router.call('skills.importLocal', { paths: [lint.folder], confirm: true }) as { imported: string[] };
    assert.equal(imported.imported.length, 1);
    assert.equal(row(await f.report(), 'lint-fix').itemId, imported.imported[0]);
    assert.equal((f.router.call('usage.item', { itemId: item.id }) as { uses: number }).uses, 3);

    // The cache is machine-private and holds no message text; the library repository gets nothing.
    const cache = fs.readFileSync(path.join(f.wb.local, 'usage', 'cache.json'), 'utf8');
    assert.doesNotMatch(cache, /Review my change|Tidy it|Body/);
    assert.equal(fs.readdirSync(f.wb.canonical, { recursive: true }).some(name => String(name).includes('usage')), false);
  } finally { f.close(); }
});

test('counts tokens once per response, per model, project and month, and attributes session tokens to the skills used', async () => {
  const f = fixture();
  try {
    f.wb.create({ title: 'careful-review', kind: 'skill', content: skill('careful-review') });
    const report = await f.report();
    const opus = report.spend.byModel.find(r => r.key === 'claude-opus-5-5')!;
    assert.deepEqual(opus.tokens, { input: 110, cached: 1000, cacheWrite: 150, cacheWrite1h: 50, output: 120, reasoning: 7 });
    // $4 input, $0.20 cache read, $5 5-minute write, $8 1-hour write, $20 output per million.
    const claudeCost = (110 * 4 + 1000 * 0.2 + 150 * 5 + 50 * 8 + 120 * 20) / 1e6;
    assert.ok(Math.abs(opus.cost! - claudeCost) < 1e-12);
    // Codex: the own thread's records only (600 uncached + 400 cached); the fork by growth of its running total (300 in, 30 out).
    const gpt = report.spend.byModel.find(r => r.key === 'gpt-5.5')!;
    assert.deepEqual(gpt.tokens, { input: 900, cached: 400, cacheWrite: 0, cacheWrite1h: 0, output: 80, reasoning: 10 });
    assert.equal(gpt.cost, null); assert.equal(gpt.unpriced, 1380);
    assert.deepEqual(report.spend.byProject.map(r => [r.key, r.sessions]).sort(), [[f.proj2, 1], [f.proj, 1]].sort());
    assert.equal(report.spend.byMonth.length >= 1, true);

    // Each session's tokens are split evenly among its skills: Claude's s1 had careful-review and tidy, Codex's t1 careful-review and lint-fix.
    const review = row(report, 'careful-review');
    assert.ok(Math.abs(review.attributedCost! - claudeCost / 2) < 1e-12);
    assert.equal(review.attributed.input, 110 / 2 + 900 / 2);
    assert.equal(row(report, 'lint-fix').attributedCost, null);

    // A price for the Codex model (saved on this machine) turns its tokens into an estimate.
    f.router.call('usage.prices', { set: { 'gpt-5.5': { input: 1, cached: 0.1, cacheWrite: 1, cacheWrite1h: 1, output: 10 } } });
    const priced = await f.report();
    assert.ok(Math.abs(priced.spend.byModel.find(r => r.key === 'gpt-5.5')!.cost! - (900 * 1 + 400 * 0.1 + 80 * 10) / 1e6) < 1e-12);
    assert.deepEqual(priced.prices.edited, ['gpt-5.5']);
    f.router.call('usage.prices', { set: {} });
    assert.deepEqual((await f.report()).prices.edited, []);
  } finally { f.close(); }
});

test('rescans only what was added, waits for unfinished lines, re-reads a file that shrank, and splits work into capped passes', async () => {
  const f = fixture();
  try {
    await f.report();
    const cachePath = path.join(f.wb.local, 'usage', 'cache.json');
    const entry = () => JSON.parse(fs.readFileSync(cachePath, 'utf8')).files[f.claudeFile];
    assert.equal(entry().offset, fs.statSync(f.claudeFile).size);
    // An appended use counts; a line still being written does not, until it is finished.
    const more = { type: 'assistant', sessionId: 's1', cwd: f.proj, timestamp: at(0), message: { id: 'm3', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_3', name: 'Skill', input: { skill: 'careful-review' } }] } };
    const line = JSON.stringify(more);
    fs.appendFileSync(f.claudeFile, line.slice(0, 40));
    let report = await f.report();
    assert.equal(report.scan.complete, true); assert.equal(row(report, 'careful-review').uses, 3);
    fs.appendFileSync(f.claudeFile, line.slice(40) + '\n');
    report = await f.report();
    assert.equal(row(report, 'careful-review').uses, 4); assert.equal(entry().offset, fs.statSync(f.claudeFile).size);
    // Nothing changed: nothing is read again, and nothing is counted twice.
    assert.equal(row(await f.report(), 'careful-review').uses, 4);

    // A file replaced by a shorter one is read from the start; what it recorded before is replaced.
    fs.writeFileSync(f.forkFile, jsonl([{ timestamp: at(0), type: 'session_meta', payload: { id: 't2', session_id: 't1', cwd: f.proj2 } }, { timestamp: at(0), type: 'turn_context', payload: { turn_id: 'x', model: 'gpt-5.5' } }, { timestamp: at(0), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 7, output_tokens: 1 } } } }]));
    assert.equal((await f.report()).spend.byModel.find(r => r.key === 'gpt-5.5')!.tokens.input, 600 + 7);
    // A log that disappears keeps what it recorded.
    fs.rmSync(f.subagentFile);
    assert.equal(row(await f.report(), 'careful-review').uses, 4);

    // A small byte budget takes several passes and ends with the same numbers as one pass.
    const service = new UsageService({ local: path.join(f.root, 'other-local'), home: f.home, env: { CLAUDE_CONFIG_DIR: path.join(f.root, 'claude-config') } });
    let passes = 0, status;
    do { status = await service.scan({ maxBytes: 300 }); passes++; } while (!status.complete && passes < 200);
    assert.ok(passes > 1, `took ${passes} passes`); assert.equal(status.complete, true);
    const library = f.router.usageLibrary(false);
    const small = service.report({ days: 30 }, library), whole = new UsageService({ local: path.join(f.root, 'third-local'), home: f.home, env: { CLAUDE_CONFIG_DIR: path.join(f.root, 'claude-config') } });
    await whole.scanAll();
    assert.deepEqual(small.skills.map(s => [s.name, s.uses]), whole.report({ days: 30 }, library).skills.map(s => [s.name, s.uses]));
    assert.deepEqual(small.spend.total.tokens, whole.report({ days: 30 }, library).spend.total.tokens);
  } finally { f.close(); }
});

test('lists installed skills unused in the window, and Kiln runs by kind and item', async () => {
  const f = fixture();
  try {
    const target = f.wb.enroll({ name: 'Claude skills', root: f.home, provider: 'claude', scope: 'personal', profile: 'Personal' });
    const review = f.wb.create({ title: 'Careful review', kind: 'skill', content: skill('careful-review') });
    const idle = f.wb.create({ title: 'Never used', kind: 'skill', content: skill('never-used') });
    for (const item of [review, idle]) { approve(f.wb, item.id); f.router.call('skills.install', { itemId: item.id, targetId: target.id, confirm: true }); }
    const report = await f.report(7);
    // Mapped by the folder Kiln installed it to, even though the title differs from the name the log used.
    assert.equal(row(report, 'careful-review').itemId, review.id); assert.equal(row(report, 'careful-review').status, 'approved');
    assert.deepEqual(report.unused.map(u => [u.itemId, u.lastUsed]), [[idle.id, null]]);
    // With a one-day window the Claude uses (yesterday and before) fall out, and only today's Codex one keeps it off the list.
    assert.deepEqual((await f.report(1)).unused.map(u => u.itemId), [idle.id]);

    fs.mkdirSync(path.join(f.wb.local, 'agent-jobs'), { recursive: true });
    fs.writeFileSync(path.join(f.wb.local, 'agent-jobs', 'job-1.json'), JSON.stringify({ id: 'job-1', kind: 'trial', provider: 'claude', model: 'claude-opus-5-5', itemId: review.id, startedAt: at(0), usage: { input: 1000, cached: 0, output: 100, reasoning: 0 } }));
    fs.writeFileSync(path.join(f.wb.local, 'agent-jobs', 'job-2.json'), JSON.stringify({ id: 'job-2', kind: 'distill', provider: 'codex', model: 'gpt-5.5', itemId: idle.id, startedAt: at(0), usage: { input: 500, cached: 200, output: 10, reasoning: 5 } }));
    const kiln = (await f.report()).spend.kiln;
    assert.equal(kiln.total.runs, 2);
    const trial = kiln.byKind.find(r => r.key === 'trial')!;
    assert.ok(Math.abs(trial.cost! - (1000 * 4 + 100 * 20) / 1e6) < 1e-12);
    // Codex reports input with the cached part in it.
    assert.deepEqual(kiln.byKind.find(r => r.key === 'distill')!.tokens, { input: 300, cached: 200, cacheWrite: 0, cacheWrite1h: 0, output: 10, reasoning: 5 });
    assert.equal(kiln.byItem.find(r => r.key === review.id)!.label, 'Careful review');
  } finally { f.close(); }
});

test('prices: model ids normalise to one row, unknown models have no estimate, and defaults are clearly dated', () => {
  assert.equal(normaliseModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(normaliseModel('anthropic.claude-sonnet-4-6-20260101'), 'claude-sonnet-4-6');
  assert.equal(priceFor('claude-opus-5-5', defaultPrices)!.key, 'claude-opus-5-5');
  assert.equal(priceFor('claude-opus-5', defaultPrices)!.key, 'claude-opus-5');
  assert.equal(priceFor('claude-opus-4-8', defaultPrices)!.price.output, 25);
  assert.equal(priceFor('claude-sonnet-4-6', defaultPrices)!.key, 'claude-sonnet-4');
  assert.equal(priceFor('gpt-6-astra', defaultPrices), null);
  assert.equal(estimateCost('gpt-6-astra', { ...noTokens(), input: 1e6 }, defaultPrices), null);
  assert.equal(estimateCost('claude-haiku-4-5', { ...noTokens(), input: 1e6, output: 1e6 }, defaultPrices), 6);
  assert.equal(projectOf('/nowhere/app/.claude/worktrees/agent-1'), '/nowhere/app');
});

test('usage CLI arguments and the page model', () => {
  assert.throws(() => parseArguments(['usage', 'item']), /one ID/);
  assert.throws(() => parseArguments(['usage', 'skills', '--days', 'soon']), /--days/);
  assert.throws(() => parseArguments(['usage', 'spend', '--project', 'x']), /not supported/);
  assert.equal(parseArguments(['usage', 'spend', '--days', '0']).option('days'), '0');
  const base: Omit<SkillRow, 'key' | 'name' | 'title' | 'itemId' | 'uses' | 'previous'> = { harnesses: [], signals: [], projects: [], daily: [], folder: null, importable: false, attributed: noTokens(), attributedCost: null, inferred: 0, total: 1, activeDays: 1, lastUsed: null, status: null };
  const rows: SkillRow[] = [{ ...base, key: 'a', name: 'alpha', title: 'alpha', itemId: 'x', status: 'approved', uses: 2, previous: 5 }, { ...base, key: 'b', name: 'beta', title: 'beta', itemId: null, uses: 9, previous: 1 }];
  assert.deepEqual(sortSkills(rows, { key: 'uses', dir: 'desc' }).map(r => r.key), ['b', 'a']);
  assert.deepEqual(sortSkills(rows, { key: 'title', dir: 'asc' }).map(r => r.key), ['a', 'b']);
  assert.deepEqual(filterSkills(rows, 'unmanaged').map(r => r.key), ['b']);
  assert.deepEqual(nextSort({ key: 'uses', dir: 'desc' }, 'uses', []), { key: 'uses', dir: 'asc' });
  assert.deepEqual(nextSort<'uses' | 'title'>({ key: 'uses', dir: 'desc' }, 'title', ['title']), { key: 'title', dir: 'asc' });
  assert.equal(trend(rows[0]), '−3'); assert.equal(trend(rows[1]), '+8');
  assert.equal(tokens(1234), '1.2k'); assert.equal(tokens(3_400_000), '3.4M'); assert.equal(tokens(2.1e9), '2.1B');
  assert.equal(dollars(null), '—'); assert.equal(dollars(0.004), '<$0.01'); assert.equal(dollars(12.4), '$12.40');
  const spend = [{ key: 'm', label: 'm', tokens: { ...noTokens(), output: 5 }, cost: null, unpriced: 5 }, { key: 'n', label: 'n', tokens: noTokens(), cost: 2, unpriced: 0 }];
  assert.deepEqual(sortSpend(spend, { key: 'cost', dir: 'desc' }).map(r => r.key), ['n', 'm']);
});
