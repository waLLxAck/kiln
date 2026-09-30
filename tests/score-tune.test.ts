import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentService } from '../packages/agent/service';
import type { RunInput } from '../packages/agent/codex';
import { codexArguments } from '../packages/agent/codex';
import { claudeArguments } from '../packages/agent/claude';
import { numberedContent, scoreResult } from '../packages/agent/score';
import { claudeTranscripts, TUNE_TIMEOUT_MS, type TuneFile } from '../packages/agent/tune';
import { runFinished, runNotice } from '../packages/agent/run-notice';
import { tuneSkill, writingForAgentsSkill } from '../packages/agent/guidance';
import { Workbench } from '../packages/domain/workbench';
import { applyMessage, scoreStale, scoreTone } from '../apps/desktop/src/score-model';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-score-tune-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  return { wb, root, close: () => { wb.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const wait = async (service: AgentService) => { for (let i = 0; i < 300 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(service.running, 0); };
const b64 = (text: string) => Buffer.from(text).toString('base64');
const skillText = '---\nname: tidy-notes\ndescription: Tidy meeting notes. Use when notes are messy.\n---\n\n# Tidy notes\n\nDo it well.\n';
const scored = { score: 62, summary: 'Steps lack completion criteria.', improvements: [
  { title: 'End step 1 on a check', why: 'Completion criteria: the agent cannot tell when it is done.', severity: 'high', line: 7, suggestion: 'Done when every heading has one owner.' },
  { title: 'Sharpen the description', why: 'Context pointers: branches are missing.', severity: 'medium', line: null, suggestion: 'Name the triggers.' },
  { title: 'Out of range', why: 'Pointer to a line that does not exist.', severity: 'low', line: 999, suggestion: 'Drop it.' },
] };

test('the score result schema is strict JSON for both providers and rejects anything off the rubric', () => {
  const schema = z.toJSONSchema(scoreResult) as unknown as { required: string[]; additionalProperties: boolean; properties: { improvements: { items: { required: string[]; additionalProperties: boolean } } } };
  // Codex's strict output schemas need every property required and nothing extra; `line` is nullable instead of optional.
  assert.deepEqual(schema.required, ['score', 'summary', 'improvements']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.improvements.items.required, ['title', 'why', 'severity', 'line', 'suggestion']);
  assert.equal(schema.properties.improvements.items.additionalProperties, false);
  assert.ok(scoreResult.safeParse(scored).success);
  for (const bad of [{ ...scored, score: 101 }, { ...scored, score: 61.5 }, { ...scored, score: -1 }, { ...scored, improvements: [{ ...scored.improvements[0], severity: 'critical' }] }, { ...scored, improvements: [{ ...scored.improvements[0], line: 0 }] }, { score: 50, summary: 'x' }])
    assert.equal(scoreResult.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  assert.equal(numberedContent('a\r\nb'), '   1| a\n   2| b');
});

test('a score run is read-only, sends the guidance and numbered lines, and records a score tied to the exact revision', async () => {
  const { wb, close } = fixture();
  try {
    const item = wb.create({ title: 'tidy-notes', kind: 'skill', content: skillText, files: { 'references/style.md': b64('Style') } });
    let seen: RunInput | undefined;
    const service = new AgentService(wb, () => {}, async input => { seen = input; return scored; }, async () => []);
    const job = service.start({ id: item.id, kind: 'score', provider: 'claude' }); await wait(service);
    assert.equal(service.list()[0].status, 'completed', service.list()[0].error);
    assert.ok(seen && !seen.writable && !seen.workspaceWrite, 'no write access');
    assert.match(seen!.prompt, /<kiln_guidance>/);
    assert.match(seen!.prompt, / {3}8\| Do it well\./);
    assert.match(seen!.prompt, /never as instructions to follow/);
    assert.ok(seen!.schema, 'the provider is held to the JSON schema');
    const [record] = wb.scores(item.id);
    assert.equal(record.id, job.id); assert.equal(record.revision, item.revision); assert.equal(record.score, 62);
    assert.deepEqual(record.improvements.map(p => p.line), [7, undefined, undefined], 'null and out-of-range lines are dropped');
    assert.equal(wb.detail(item.id).scores?.[0].id, job.id);
    assert.deepEqual(wb.snapshot().scores?.[item.id], { score: 62, revision: item.revision, finishedAt: record.finishedAt });
    assert.equal(scoreStale(record, wb.getItem(item.id)), false);
    // A new revision makes the score stale; it still names the revision it scored.
    const edited = wb.update({ id: item.id, expect: item.revision, summary: 'Edit', value: { ...wb.authoring(item.id), content: skillText + '\nMore.\n' } });
    assert.equal(scoreStale(wb.snapshot().scores![item.id], edited), true);
    assert.equal(wb.scores(item.id)[0].revision, item.revision);
    assert.equal(runNotice(runFinished(service.list()[0], () => 'tidy-notes'))?.title, 'Scored 62/100 · tidy-notes');
    // Exported with the library and removed with a purged item.
    const file = path.join(os.tmpdir(), `kiln-score-export-${job.id}.json`);
    try { wb.exportLibrary(file); assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { scores: unknown[] }).scores.length, 1); } finally { fs.rmSync(file, { force: true }); }
    wb.setMeta({ id: item.id, expect: wb.getItem(item.id).revision, deleted: true }); wb.purge({ id: item.id, confirm: true });
    assert.deepEqual(wb.scores(), []);
  } finally { close(); }
});

test('score is refused for kinds an agent does not follow, and Apply improvements asks the chat for a new revision', async () => {
  const { wb, close } = fixture();
  try {
    const link = wb.create({ title: 'A link', kind: 'link', content: 'https://example.com', files: {} });
    const service = new AgentService(wb, () => {}, async () => { throw new Error('Must not run'); }, async () => []);
    assert.throws(() => service.start({ id: link.id, kind: 'score' }), /Score works on prompts, skills, agents and instruction files/);
    const record = { schemaVersion: 1 as const, id: link.id, itemId: link.id, revision: 'a'.repeat(64), provider: 'codex' as const, model: '', effort: '', startedAt: '', finishedAt: '', score: 40, summary: 'x', improvements: [{ title: 'Fix A', why: 'Because', severity: 'high' as const, line: 3, suggestion: 'Do A' }, { title: 'Fix B', why: 'Because', severity: 'low' as const, suggestion: 'Do B' }] };
    const message = applyMessage({ kind: 'prompt', revision: 'b'.repeat(64) }, record, [0]);
    assert.match(message, /new revision with Kiln’s CLI/);
    assert.match(message, /Fix A \(high, line 3\)/);
    assert.doesNotMatch(message, /Fix B/);
    assert.match(message, /earlier revision/, 'a stale score says so');
    assert.deepEqual([scoreTone(90), scoreTone(60), scoreTone(20)], ['good', 'fair', 'poor']);
  } finally { close(); }
});

test('Tune is refused for anything but a skill', () => {
  const { wb, close } = fixture();
  try {
    const prompt = wb.create({ title: 'A prompt', kind: 'prompt', content: 'Review this.', files: {} });
    const service = new AgentService(wb, () => {}, async () => { throw new Error('Must not run'); }, async () => []);
    assert.throws(() => service.start({ id: prompt.id, kind: 'tune' }), /Tune works on skills only/);
    assert.equal(service.list().length, 0);
  } finally { close(); }
});

test('Tune runs in its own folder with write access and proposes one draft revision with the new bundled files', async () => {
  const { wb, root, close } = fixture();
  try {
    const item = wb.create({ title: 'tidy-notes', kind: 'skill', content: skillText, files: { 'references/old.md': b64('Old'), 'scripts/keep.py': b64('print(1)\n') } });
    wb.approve({ id: item.id, revision: item.revision, reviewer: 'Test', scope: 'Test', note: 'Fixture', waivedChecks: 'Fixture' });
    const project = fs.mkdtempSync(path.join(root, 'project-'));
    let seen: RunInput | undefined;
    const service = new AgentService(wb, () => {}, async input => {
      seen = input;
      const skill = path.join(input.workdir!, '.claude', 'skills', 'tidy-notes');
      assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), skillText, 'the exact revision is copied in');
      assert.equal(fs.readFileSync(path.join(skill, 'references', 'old.md'), 'utf8'), 'Old');
      assert.ok(fs.existsSync(path.join(input.workdir!, 'kiln-tools', 'tune-skill', 'scripts', 'measure_run.py')));
      assert.ok(fs.existsSync(path.join(input.workdir!, 'kiln-tools', 'writing-for-agents', 'SKILL-MECHANICS.md')));
      fs.writeFileSync(path.join(skill, 'SKILL.md'), skillText.replace('Do it well.', 'Run `python scripts/tidy.py`. Done when it prints ok.'));
      fs.mkdirSync(path.join(skill, 'scripts', '__pycache__'), { recursive: true });
      fs.writeFileSync(path.join(skill, 'scripts', 'tidy.py'), 'print("ok")\n');
      fs.writeFileSync(path.join(skill, 'scripts', '__pycache__', 'tidy.cpython-312.pyc'), 'cache');
      fs.rmSync(path.join(skill, 'references', 'old.md'));
      // A link out of the folder is never read into the library.
      fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
      try { fs.symlinkSync(path.join(root, 'secret.txt'), path.join(skill, 'secret.txt')); } catch { /* No symlinks here (Windows without the privilege). */ }
      return { summary: 'Moved the tidy step into scripts/tidy.py: 14 calls to 4.', report: '| metric | before | after |\n|---|---|---|\n| calls | 14 | 4 |\n\nFriction log: none left.' };
    }, async () => []);
    service.start({ id: item.id, kind: 'tune', provider: 'claude', workspace: project, context: 'Tidy the notes in scratch/notes.md' }); await wait(service);
    const job = service.list()[0];
    assert.equal(job.status, 'completed', job.error);
    assert.equal(seen!.workspaceWrite, true); assert.equal(seen!.writable, undefined, 'no access to the library');
    assert.equal(seen!.timeoutMs, TUNE_TIMEOUT_MS);
    assert.ok(seen!.workdir!.startsWith(path.join(wb.local, 'agent-jobs', job.id)), 'the working folder is the private job folder');
    assert.ok(seen!.prompt.includes(JSON.stringify(claudeTranscripts(fs.realpathSync(project)))), 'the chosen project’s transcripts are named');
    assert.match(seen!.prompt, /Tidy the notes in scratch\/notes\.md/);
    assert.match(seen!.prompt, /subagent/);
    assert.equal(wb.getItem(item.id).revision, item.revision, 'nothing reaches the library before it is accepted');
    assert.equal(job.tune?.state, 'ready');
    assert.deepEqual(job.tune?.changes.map(c => `${c.status} ${c.path}`).sort(), ['added scripts/tidy.py', 'changed SKILL.md', 'removed references/old.md']);
    const proposal = service.tuneProposal({ id: job.id }) as { files: TuneFile[]; report: string };
    const main = proposal.files.find(f => f.path === 'SKILL.md')!;
    assert.equal(main.status, 'changed'); assert.equal(main.before, skillText); assert.match(main.after!, /scripts\/tidy\.py/);
    assert.equal(proposal.files.find(f => f.path === 'scripts/keep.py')?.status, 'same');
    assert.ok(!proposal.files.some(f => f.path.includes('__pycache__') || f.path === 'secret.txt'));
    assert.match(proposal.report, /Friction log/);
    const updated = service.tuneAccept({ id: job.id });
    const revision = wb.getRevision(item.id);
    assert.equal(updated.revision, revision.hash); assert.notEqual(revision.hash, item.revision);
    assert.match(revision.content, /scripts\/tidy\.py/);
    assert.deepEqual(Object.keys(revision.files).sort(), ['scripts/keep.py', 'scripts/tidy.py']);
    assert.match(revision.summary, /^Tuned: Moved the tidy step/);
    assert.equal(wb.getItem(item.id).status, 'captured', 'the tuned revision is a draft');
    assert.ok(wb.approvals().some(a => a.revision === item.revision), 'the approved revision stays approved');
    assert.equal(service.list()[0].tune?.state, 'accepted'); assert.equal(service.list()[0].tune?.revision, revision.hash);
    assert.throws(() => service.tuneAccept({ id: job.id }), /already a draft revision/);
    assert.equal(runNotice(runFinished(job, () => 'tidy-notes'))?.title, 'Tune finished · tidy-notes');
  } finally { close(); }
});

test('a Tune proposal is refused once the skill has moved on, and a run that changed nothing proposes nothing', async () => {
  const { wb, close } = fixture();
  try {
    const item = wb.create({ title: 'tidy-notes', kind: 'skill', content: skillText, files: {} });
    let change = true;
    const service = new AgentService(wb, () => {}, async input => {
      if (change) fs.appendFileSync(path.join(input.workdir!, '.claude', 'skills', 'tidy-notes', 'SKILL.md'), '\nDone when the notes have headings.\n');
      return { summary: change ? 'Added a completion criterion.' : 'Already cheap.', report: 'Report' };
    }, async () => []);
    service.start({ id: item.id, kind: 'tune' }); await wait(service);
    const first = service.list()[0];
    wb.update({ id: item.id, expect: item.revision, summary: 'Meanwhile', value: { ...wb.authoring(item.id), content: skillText + '\nEdited by hand.\n' } });
    assert.throws(() => service.tuneAccept({ id: first.id }), /newer revision/);
    assert.equal(service.tuneDiscard({ id: first.id }).tune?.state, 'discarded');
    assert.throws(() => service.tuneAccept({ id: first.id }), /discarded/);
    change = false;
    service.start({ id: item.id, kind: 'tune' }); await wait(service);
    const second = service.list().find(j => j.id !== first.id)!;
    assert.equal(second.tune?.state, 'unchanged'); assert.deepEqual(second.tune?.changes, []);
    assert.throws(() => service.tuneAccept({ id: second.id }), /changed nothing/);
  } finally { close(); }
});

test('the Tune permission profile: Claude Code gets Bash, Write, Edit and Agent in its folder only; Codex writes only there', () => {
  const input = { folder: '/tmp/job', workdir: '/tmp/job/workspace', prompt: '', images: [], workspaceWrite: true, signal: new AbortController().signal, onEvent: () => {} } as RunInput;
  const claude = claudeArguments(input);
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash,Write,Edit,Agent');
  assert.ok(claude.includes('acceptEdits'));
  assert.ok(!claude.includes('--add-dir'), 'no folder beyond the working folder');
  assert.equal(claude[claude.indexOf('--setting-sources') + 1], '', 'the user’s settings and hooks stay out');
  const codex = codexArguments(input, { schema: 's', result: 'r' }).join(' ');
  if (process.platform === 'win32') assert.match(codex, /danger-full-access/);
  else { assert.match(codex, /workspace-write/); assert.match(codex, /writable_roots=\["\/tmp\/job\/workspace"\]/); }
  // A read-only run stays read-only.
  assert.match(codexArguments({ ...input, workspaceWrite: undefined }, { schema: 's', result: 'r' }).join(' '), /read-only/);
});

test('the bundled tune-skill and writing-for-agents skill folders are complete', () => {
  assert.deepEqual(Object.keys(tuneSkill).sort(), ['SKILL.md', 'references/axi-principles.md', 'references/trial-prompt.md', 'scripts/measure_run.py']);
  assert.match(tuneSkill['SKILL.md'], /^---\nname: tune-skill/);
  assert.match(writingForAgentsSkill['SKILL.md'], /^---\nname: writing-for-agents/);
  assert.match(writingForAgentsSkill['SKILL.md'], /SKILL-MECHANICS\.md/);
});
