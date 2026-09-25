/**
 * Builds the demo machine and library the screenshots show. Files outside the library (the home folder, projects, agent
 * folders and config files) are written directly, the way a user's machine would already have them. Everything inside the
 * library goes through Kiln's own API calls, the same ones the desktop makes, including agent runs: those launch a scripted
 * stand-in for Claude Code (stubs/claude-stub.mjs) and yt-dlp, so no model or network is involved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialiseRepository } from '../../packages/git/standard';
import { configFiles, projects, prompts, skills, unmanagedAgent, unmanagedSkill, video, videoFiles } from './demo';

export type Call = <T = any>(method: string, args?: unknown) => Promise<T>;
export type Machine = { home: string; library: string; local: string; remote: string; bin: string; projects: Record<string, string> };

/** Paths on the demo machine. `home` is the fake user folder, e.g. C:\Users\dev on the Windows runner. */
export function machine(home: string, scratch: string): Machine {
  return {
    home, library: path.join(home, 'Kiln', 'my-kiln'), local: path.join(home, '.kiln'), remote: path.join(scratch, 'github', 'my-kiln.git'),
    bin: path.join(scratch, 'bin'), projects: Object.fromEntries(Object.keys(projects).map(name => [name, path.join(home, 'Projects', name)])),
  };
}
const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

/** Writes what the machine already has before Kiln opens, plus the stub CLIs, and creates the Kiln repository. */
export function prepareMachine(m: Machine) {
  // The demo home is rebuilt from scratch, so refuse to touch a folder that is neither empty nor an earlier demo home.
  const marker = path.join(m.home, '.kiln-demo-home');
  if (fs.existsSync(m.home) && fs.readdirSync(m.home).length && !fs.existsSync(marker)) throw new Error(`${m.home} is not empty and is not a demo home folder.`);
  fs.rmSync(m.home, { recursive: true, force: true }); write(marker, 'Created by tests/screenshots; deleted and rebuilt on every run.\n');
  for (const [name, files] of Object.entries(projects)) for (const [file, content] of Object.entries(files)) write(path.join(m.projects[name], file), content);
  for (const [file, content] of Object.entries(configFiles)) write(path.join(m.home, file), content);
  // Found outside the library: a skill and a Claude subagent nobody imported yet.
  write(path.join(m.home, '.claude', 'skills', 'pr-summary', 'SKILL.md'), unmanagedSkill);
  write(path.join(m.home, '.claude', 'agents', 'test-runner.md'), unmanagedAgent);
  // Differs: an older research skill copied into the shared Agents folder by hand.
  write(path.join(m.home, '.agents', 'skills', 'research', 'SKILL.md'), skills.research.content(skills.research.before));
  // Stub CLIs on PATH: claude runs the scripted agent; yt-dlp copies the demo video's captions and metadata into its working folder.
  fs.mkdirSync(m.bin, { recursive: true });
  const stub = path.resolve('tests', 'screenshots', 'stubs', 'claude-stub.mjs');
  for (const [file, content] of Object.entries(videoFiles)) write(path.join(m.bin, 'ytdlp-fixture', file), content);
  if (process.platform === 'win32') {
    // Kiln launches both as native executables on Windows, so the stubs are tiny executables built with the runner's .NET Framework compiler.
    const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    for (const name of ['claude', 'yt-dlp']) execFileSync(csc, ['/nologo', `/out:${path.join(m.bin, `${name}.exe`)}`, path.resolve('tests', 'screenshots', 'stubs', `${name}.cs`)], { stdio: 'pipe' });
    fs.copyFileSync(stub, path.join(m.bin, 'claude-stub.mjs'));
  } else {
    write(path.join(m.bin, 'claude'), `#!/bin/sh\nexec node "${stub}" "$@"\n`);
    write(path.join(m.bin, 'yt-dlp'), `#!/bin/sh\ncp "${path.join(m.bin, 'ytdlp-fixture')}"/* .\n`);
    fs.chmodSync(path.join(m.bin, 'claude'), 0o755); fs.chmodSync(path.join(m.bin, 'yt-dlp'), 0o755);
  }
  // Git reads its identity from the home folder, which the app sees as the fake one.
  write(path.join(m.home, '.gitconfig'), '[user]\n\tname = Dev\n\temail = dev@example.com\n');
  // The Kiln repository, with a local bare repository standing in for GitHub so approvals commit and push for real.
  fs.rmSync(path.dirname(m.remote), { recursive: true, force: true }); fs.mkdirSync(path.dirname(m.remote), { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', m.remote], { stdio: 'ignore' });
  const previous = process.env.KILN_LOCAL; process.env.KILN_LOCAL = m.local;
  try { const created = initialiseRepository({ parent: path.dirname(m.library), name: path.basename(m.library) }); if (!created.committed) throw new Error(created.message); }
  finally { if (previous === undefined) delete process.env.KILN_LOCAL; else process.env.KILN_LOCAL = previous; }
  execFileSync('git', ['-C', m.library, 'remote', 'add', 'origin', m.remote], { stdio: 'ignore' });
}

/** Environment for the app and its backend: the fake home folder, isolated library and private data, and the stubs first on PATH. */
export function environment(m: Machine): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  return { ...process.env, [pathKey]: `${m.bin}${path.delimiter}${process.env[pathKey]}`, HOME: m.home, USERPROFILE: m.home, KILN_HOME: m.home, KILN_LIBRARY: m.library, KILN_LOCAL: m.local, KILN_PLAIN_COMMITS: '1', CLAUDE_CONFIG_DIR: path.join(m.home, '.claude'), CODEX_HOME: path.join(m.home, '.codex') };
}

const approve = (call: Call, item: { id: string; revision: string }) => call('approvals.approve', { id: item.id, revision: item.revision, reviewer: 'Local user', scope: 'Current revision', note: 'Approved by clicking Approve in Kiln.', evidence: [], waivedChecks: 'Manual approval without requiring passing typical and boundary trials.' });
type Job = { id: string; status: string; error?: string; createdItemIds?: string[]; createdItemId?: string };
async function finished(call: Call, id: string): Promise<Job> {
  for (let i = 0; i < 600; i++) {
    const job = (await call<Job[]>('agent.jobs')).find(j => j.id === id);
    if (job && job.status !== 'running') { if (job.status !== 'completed') throw new Error(`Agent run ${job.status}: ${job.error}`); return job; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Agent run did not finish');
}

/** Fills the library through the app's API. Returns the ids the screenshots navigate to. */
export async function seed(call: Call, m: Machine) {
  await call('desktop.settings', { shortcut: 'CommandOrControl+Shift+Space', launchAtLogin: false, theme: 'light', agentProvider: 'claude' });
  const enroll = (name: string, root: string, provider: string, scope: string) => call<{ id: string }>('targets.enroll', { name, root, provider, scope, profile: 'Personal' });
  const agents = await enroll('Agents skills', m.home, 'codex', 'personal');
  const claude = await enroll('Claude skills', m.home, 'claude', 'personal');
  const game = await enroll('my-game', m.projects['my-game'], 'claude', 'project');
  await enroll('orders-api', m.projects['orders-api'], 'codex', 'project');
  const create = (input: Record<string, unknown>) => call<{ id: string; revision: string }>('items.create', { tags: [], files: {}, source: '', licence: 'Unknown', ...input });
  const install = (item: { id: string }, target: { id: string }) => call('skills.install', { itemId: item.id, targetId: target.id, confirm: true });

  // The video comes first: its distillation runs while the rest of the library is filled in.
  const capture = await call<{ item: { id: string }; job: { id: string } }>('agent.capture', { text: `https://www.youtube.com/watch?v=${video.id}`, analyze: true, provider: 'claude' });

  await create({ title: prompts.traceInstruction.title, kind: 'prompt', content: prompts.traceInstruction.text, collection: 'Agent workflow', tags: ['debugging', 'instructions'], description: 'When an agent did something unexpected: find the instruction behind it before changing anything.' });
  const research1 = await create({ title: skills.research.title, kind: 'skill', content: skills.research.content(skills.research.before), collection: skills.research.collection, tags: skills.research.tags });
  await approve(call, research1);
  const research = await call<{ id: string; revision: string }>('items.update', { id: research1.id, expect: research1.revision, summary: 'Ask for links and dates with every citation', value: { title: skills.research.title, kind: 'skill', content: skills.research.content(skills.research.after), collection: skills.research.collection, tags: skills.research.tags, files: {}, source: '', licence: 'Unknown', description: '' } });
  await approve(call, research); await install(research, claude);
  const writing = await create({ title: skills.writing.title, kind: 'skill', content: skills.writing.content, files: skills.writing.files, collection: skills.writing.collection, tags: skills.writing.tags, source: 'Bundled with Kiln', licence: 'MIT' });
  await approve(call, writing); await install(writing, claude);
  const playtest = await create({ title: skills.playtest.title, kind: 'skill', content: skills.playtest.content, collection: skills.playtest.collection, tags: skills.playtest.tags });
  await approve(call, playtest); await install(playtest, game);
  await create({ title: skills.releaseNotes.title, kind: 'skill', content: skills.releaseNotes.content, collection: skills.releaseNotes.collection, tags: skills.releaseNotes.tags });
  const review = await create({ title: skills.codeReview.title, kind: 'skill', content: skills.codeReview.content, files: skills.codeReview.files, collection: skills.codeReview.collection, tags: skills.codeReview.tags });
  await approve(call, review);
  for (const target of [agents, claude]) await install(review, target);
  // Someone edited the personal Claude copy by hand afterwards.
  const edited = path.join(m.home, '.claude', 'skills', 'code-review', 'SKILL.md');
  fs.writeFileSync(edited, fs.readFileSync(edited, 'utf8').replace(skills.codeReview.handEdit.del, skills.codeReview.handEdit.add));

  // The distilled prompt is tested on the game project, fixed in one line, and tested again.
  const distilled = await finished(call, capture.job.id);
  const promptId = distilled.createdItemIds![0];
  const first = await call<{ id: string }>('agent.start', { id: promptId, kind: 'trial', provider: 'claude', workspace: m.projects['my-game'], context: '' });
  await finished(call, first.id);
  const current = await call<{ item: { revision: string }; revision: Record<string, unknown> & { content: string } }>('items.read', { id: promptId });
  const { hash: _h, itemId: _i, parent: _p, createdAt: _c, author: _a, summary: _s, schemaVersion: _v, hashVersion: _hv, ...value } = current.revision;
  await call('items.update', { id: promptId, expect: current.item.revision, summary: 'Use the demo profile when the parent signup blocks the run', value: { ...value, content: current.revision.content.replace(prompts.fix.del, prompts.fix.add) } });
  const second = await call<{ id: string }>('agent.start', { id: promptId, kind: 'trial', provider: 'claude', workspace: m.projects['my-game'], context: '' });
  await finished(call, second.id);
  const derived = await finished(call, (await call<{ id: string }>('agent.start', { id: promptId, kind: 'derive', provider: 'claude', context: '' })).id);

  for (const id of [review.id, promptId]) { const item = (await call<{ item: { revision: string } }>('items.read', { id })).item; await call('items.meta', { id, expect: item.revision, favourite: true }); }
  // Give the personal Claude settings a previous version, as if it had been edited in Kiln once.
  const files = await call<{ files: { key: string; path: string }[] }>('home.list');
  const settings = files.files.find(f => f.path === path.join(m.home, '.claude', 'settings.json'))!;
  const before = await call<{ hash: string; content: string }>('home.read', { key: settings.key });
  await call('home.save', { key: settings.key, expect: before.hash, content: before.content.replace('    "deny": [\n', '    "ask": [\n      "Bash(git push:*)"\n    ],\n    "deny": [\n') });
  // Wait for approvals to reach the stand-in GitHub, so items show as published.
  for (let i = 0; i < 120; i++) { const jobs = await call<{ status: string }[]>('publish.jobs'); if (jobs.every(j => ['done', 'failed'].includes(j.status))) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  return { video: capture.item.id, prompt: promptId, review: review.id, research: research.id, writing: writing.id, playtest: playtest.id, freshEyes: derived.createdItemId!, targets: { agents: agents.id, claude: claude.id, game: game.id } };
}
export type Seeded = Awaited<ReturnType<typeof seed>>;
