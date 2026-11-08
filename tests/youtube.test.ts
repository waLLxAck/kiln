import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from '../packages/agent/service';
import { cleanVtt, fetchTranscript, findYtDlp, timestamp, transcriptMarkdown, youtubeCookieArgs, youtubeDownloadError, youtubeId, ytDlpFolders, type VideoTranscript } from '../packages/agent/youtube';
import { Workbench } from '../packages/domain/workbench';
import { Router } from '../packages/domain/router';

const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-youtube-test-')); return new Workbench(path.join(root, 'library'), path.join(root, 'private')); };
const wait = async (service: AgentService) => { for (let i = 0; i < 300 && service.running; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(service.running, 0); };
const video: VideoTranscript = { id: 'Q7n0PGbMW_U', url: 'https://www.youtube.com/watch?v=Q7n0PGbMW_U', title: 'Anthropic Is "Increasing" Your Limits', channel: 'Theo', durationSeconds: 920, uploadDate: '20260831', description: 'Limits went up 25%.', chapters: [{ title: 'Intro', start: 0 }, { title: 'The maths', start: 245 }], transcript: 'Starting September 14th, we are raising limits.\nHere is the maths.', language: 'en-orig' };

const installer = (home: string) => (...parts: string[]) => { const file = path.join(home, ...parts); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file; };

test('yt-dlp is found where pip --user and the usual Windows installers put it, even when that folder is not on PATH', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-ytdlp-windows-')), install = installer(home);
  const env = { ProgramFiles: path.join(home, 'Program Files') };
  try {
    assert.equal(findYtDlp('', 'win32', home, env), null);
    // pip falls back to a per-user install when it cannot write to the Python folder; that Scripts folder is never on PATH. Newest Python wins.
    install('AppData', 'Roaming', 'Python', 'Python39', 'Scripts', 'yt-dlp.exe');
    const user = install('AppData', 'Roaming', 'Python', 'Python314', 'Scripts', 'yt-dlp.exe');
    fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'Python', 'share'));
    assert.equal(findYtDlp('', 'win32', home, env), user);
    // Only yt-dlp.exe starts without a shell, so a .cmd wrapper or an extensionless script on PATH is passed over.
    const shims = path.join(home, 'shims'); install('shims', 'yt-dlp.cmd'); install('shims', 'yt-dlp');
    assert.equal(findYtDlp(`"${shims}"`, 'win32', home, env), user);
    // A copy on PATH comes first.
    const onPath = install('tools', 'yt-dlp.exe');
    assert.equal(findYtDlp(`${shims};${path.dirname(onPath)}`, 'win32', home, env), onPath);

    fs.mkdirSync(path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Program Files', 'Python312'), { recursive: true }); fs.mkdirSync(path.join(home, 'Program Files', 'Git'));
    const store = path.join(home, 'AppData', 'Local', 'Packages', 'PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python313');
    fs.mkdirSync(store, { recursive: true });
    assert.deepEqual(ytDlpFolders(home, 'win32', env), [
      path.join(home, 'AppData', 'Roaming', 'Python', 'Python314', 'Scripts'),
      path.join(home, 'AppData', 'Roaming', 'Python', 'Python39', 'Scripts'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'Scripts'),
      path.join(home, 'Program Files', 'Python312', 'Scripts'),
      path.join(store, 'Scripts'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
      path.join(home, 'scoop', 'shims'),
      path.join(home, '.local', 'bin'),
    ]);
    // %APPDATA%, %LOCALAPPDATA% and %SCOOP% are used when set.
    const moved = ytDlpFolders(home, 'win32', { APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local'), SCOOP: path.join(home, 'apps', 'scoop') });
    assert.deepEqual(moved, [path.join(home, 'Local', 'Microsoft', 'WinGet', 'Links'), path.join(home, 'apps', 'scoop', 'shims'), path.join(home, '.local', 'bin')]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('yt-dlp from pip install --user is found in ~/Library/Python on macOS and ~/.local/bin on Linux', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-ytdlp-posix-')), install = installer(home);
  try {
    install('Library', 'Python', '3.9', 'bin', 'yt-dlp');
    const user = install('Library', 'Python', '3.12', 'bin', 'yt-dlp');
    assert.equal(findYtDlp('', 'darwin', home, {}), user);
    assert.deepEqual(ytDlpFolders(home, 'darwin', {}).slice(0, 2), [path.join(home, 'Library', 'Python', '3.12', 'bin'), path.join(home, 'Library', 'Python', '3.9', 'bin')]);
    assert.ok(ytDlpFolders(home, 'darwin', {}).includes('/opt/homebrew/bin'));
    assert.ok(ytDlpFolders(home, 'linux', {}).includes(path.posix.join(home, '.local', 'bin')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('YouTube cookie arguments require an explicit browser choice and prefer it over the home cookie file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-youtube-cookies-'));
  try {
    assert.deepEqual(youtubeCookieArgs({}, home), []);
    fs.writeFileSync(path.join(home, 'cookies.txt'), '# Netscape HTTP Cookie File\n');
    assert.deepEqual(youtubeCookieArgs({}, home), ['--cookies', path.join(home, 'cookies.txt')]);
    assert.deepEqual(youtubeCookieArgs({ youtubeBrowser: 'chrome' }, home), ['--cookies-from-browser', 'chrome']);
    assert.deepEqual(youtubeCookieArgs({ youtubeBrowser: 'firefox', youtubeBrowserProfile: ' Personal Profile ' }, home), ['--cookies-from-browser', 'firefox:Personal Profile']);
    assert.deepEqual(youtubeCookieArgs({ youtubeBrowser: '', youtubeBrowserProfile: 'old profile' }, home), ['--cookies', path.join(home, 'cookies.txt')]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('YouTube bot checks explain recovery in Kiln, while unrelated downloader errors retain their details', () => {
  for (const apostrophe of ['’', "'", '�']) {
    const output = `ERROR: [youtube] Kl-I7sUcAOY: Sign in to confirm you${apostrophe}re not a bot. Use --cookies-from-browser or --cookies for the authentication.`;
    const message = youtubeDownloadError(1, output).message;
    assert.match(message, /Settings → YouTube/); assert.match(message, /save, then retry/); assert.match(message, /cookies.txt in your home folder/);
    assert.doesNotMatch(message, /yt-dlp exited/);
    assert.match(youtubeDownloadError(1, output, 'firefox').message, /Open the video in firefox/);
  }
  assert.equal(youtubeDownloadError(1, 'ERROR: Video unavailable').message, 'yt-dlp exited (1). ERROR: Video unavailable');
});

test('the transcript downloader passes browser cookies to yt-dlp and translates its bot-check failure', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-youtube-downloader-'));
  const previousPath = process.env.PATH;
  try {
    const executable = path.join(root, 'yt-dlp');
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
if (process.argv.includes('firefox:blocked')) {
  console.error('ERROR: [youtube] Kl-I7sUcAOY: Sign in to confirm you’re not a bot.');
  process.exit(1);
}
fs.writeFileSync('Kl-I7sUcAOY.en.vtt', 'WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\nHello from captions\\n');
fs.writeFileSync('Kl-I7sUcAOY.info.json', JSON.stringify({ title: 'Test video', channel: 'Test channel' }));
`);
    fs.chmodSync(executable, 0o755);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ''}`;
    t.mock.method(os, 'homedir', () => root);
    const input = { url: 'https://youtu.be/Kl-I7sUcAOY', folder: root, signal: new AbortController().signal, onPhase: () => {}, auth: { youtubeBrowser: 'firefox' as const, youtubeBrowserProfile: 'Personal Profile' } };
    const fetched = await fetchTranscript(input);
    assert.equal(fetched.title, 'Test video'); assert.match(fetched.transcript, /Hello from captions/);
    const args: string[] = JSON.parse(fs.readFileSync(path.join(root, 'video', 'args.json'), 'utf8'));
    assert.equal(args[args.indexOf('--cookies-from-browser') + 1], 'firefox:Personal Profile');
    assert.ok(!args.includes('--cookies')); assert.ok(args.includes('--skip-download'));
    await assert.rejects(fetchTranscript({ ...input, auth: { youtubeBrowser: 'firefox', youtubeBrowserProfile: 'blocked' } }), /Settings → YouTube/);
  } finally { process.env.PATH = previousPath; fs.rmSync(root, { recursive: true, force: true }); }
});

test('YouTube authentication persists privately, preserves other settings and reaches video distillation', async () => {
  const wb = fixture();
  try {
    assert.equal(wb.settings().youtubeBrowser, '');
    const file = path.join(wb.local, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', distillOff: ['tool'] }));
    const router = new Router(wb, { composer: null });
    router.call('settings.youtube', { youtubeBrowser: 'firefox', youtubeBrowserProfile: 'Kiln YouTube test profile' });
    assert.equal(wb.settings().theme, 'dark'); assert.deepEqual(wb.settings().distillOff, ['tool']);
    assert.equal(wb.settings().youtubeBrowser, 'firefox'); assert.equal(wb.settings().youtubeBrowserProfile, 'Kiln YouTube test profile');
    assert.throws(() => router.call('settings.youtube', { youtubeBrowser: 'unknown' }));
    assert.equal(wb.settings().youtubeBrowser, 'firefox', 'invalid settings leave the previous selection intact');
    wb.saveDistillTypes({ types: ['insight'] });
    assert.equal(wb.settings().youtubeBrowser, 'firefox', 'saving other settings preserves the browser');
    let auth: unknown;
    const service = new AgentService(wb, () => {}, async () => ({}), async () => [], async input => { auth = input.auth; throw new Error('Test stops after checking authentication'); });
    service.capture({ text: video.url, files: {} }); await wait(service);
    assert.deepEqual(auth, wb.settings());
    assert.equal(service.list()[0].status, 'failed');
    const exported = path.join(wb.local, 'export.json'); wb.exportLibrary(exported);
    assert.equal(fs.readFileSync(exported, 'utf8').includes('Kiln YouTube test profile'), false, 'browser profile is not included in the portable library');
    router.call('settings.youtube', { youtubeBrowser: '' });
    assert.equal(wb.settings().youtubeBrowser, ''); assert.equal(wb.settings().youtubeBrowserProfile, '');
  } finally { wb.close(); }
});

test('youtubeId recognises the link shapes people paste and rejects everything else', () => {
  for (const url of ['https://www.youtube.com/watch?v=Q7n0PGbMW_U', 'https://youtu.be/Q7n0PGbMW_U?si=abc', 'youtube.com/shorts/Q7n0PGbMW_U', 'https://m.youtube.com/watch?feature=share&v=Q7n0PGbMW_U', ' https://www.youtube.com/live/Q7n0PGbMW_U ']) assert.equal(youtubeId(url), 'Q7n0PGbMW_U', url);
  for (const text of ['https://example.com/watch?v=Q7n0PGbMW_U', 'Watch this https://youtu.be/Q7n0PGbMW_U later', 'a prompt about youtube', '']) assert.equal(youtubeId(text), null, text);
});
test('cleanVtt strips WebVTT scaffolding and the rolling duplicates of auto-captions', () => {
  const vtt = ['WEBVTT', 'Kind: captions', 'Language: en', '', '00:00:00.000 --> 00:00:01.430 align:start position:0%', ' ', 'Starting<00:00:00.320><c> September</c><00:00:00.680><c> 14th,</c><00:00:01.240><c> we&#39;re</c>', '', '00:00:01.430 --> 00:00:01.440 align:start position:0%', "Starting September 14th, we’re", ' ', '', '00:00:01.440 --> 00:00:03.270 align:start position:0%', "Starting September 14th, we’re", 'permanently<00:00:02.040><c> raising</c><00:00:02.520><c> standard</c>', '', 'NOTE some note', '3', '00:03.270 --> 00:03.280', 'permanently raising standard &amp; more'].join('\n');
  assert.equal(cleanVtt(vtt, 0), 'Starting September 14th, we’re\npermanently raising standard\npermanently raising standard & more');
  assert.equal(cleanVtt(vtt), '[0:00]\nStarting September 14th, we’re\npermanently raising standard\npermanently raising standard & more', 'a marker opens the transcript');
  const later = vtt + '\n\n00:00:31.000 --> 00:00:33.000\nlater line\n\n00:01:02.500 --> 00:01:04.000\nmuch later\n\n01:00:00.000 --> 01:00:01.000\nan hour in';
  assert.equal(cleanVtt(later).split('\n').filter(l => l.startsWith('[')).join(' '), '[0:00] [0:31] [1:02] [1:00:00]', 'a marker at most every 30 seconds of video');
  assert.equal(timestamp(245), '4:05'); assert.equal(timestamp(3725), '1:02:05');
  const md = transcriptMarkdown(video); assert.match(md, /^# Anthropic Is/); assert.match(md, /- Duration: 15:20/); assert.match(md, /- 4:05 The maths/); assert.match(md, /## Transcript\n\nStarting September/);
});
test('a pasted YouTube link is distilled: transcript saved on the link item, entries filed as linked items in a new collection', async () => {
  const wb = fixture();
  try {
    wb.saveCollections({ names: ['Claude Code limits'] });
    let prompt = '', fetched = '';
    const service = new AgentService(wb, () => {}, async input => { prompt = input.prompt; return { collection: 'Claude Code limits', summary: 'Theo explains the new limits.', takeaway: 'Measure your own usage before trusting the headline.', skipped: 'Sponsor read.', entries: [
      { type: 'prompt', title: 'Estimate my weekly Claude Code budget', description: 'Turns a week of session logs into a usage estimate.', content: 'Given these session logs: {{logs}}, estimate my weekly token spend and where it concentrates.', url: '', timestamp: '4:05', tags: ['usage', 'Claude'] },
      { type: 'tool', title: 'ccusage', description: 'CLI that reads local Claude Code logs and reports token usage.', content: 'Run `npx ccusage` in a terminal; it prints daily and per-session totals.', url: 'https://github.com/ryoppippi/ccusage', timestamp: '', tags: ['cli'] },
      { type: 'technique', title: 'Compact before context hits 60%', description: 'Keeps sessions cheap.', content: '1. Watch the context meter.\n2. Run /compact before 60%.\n3. Start a fresh session for a new task.', url: '', timestamp: '9:30', tags: ['workflow'] },
      { type: 'tool', title: 'Broken URL tool', description: 'URL should be ignored.', content: 'Details.', url: 'not a url', timestamp: '', tags: [] },
    ] }; }, async () => [], async input => { fetched = input.url; input.onPhase('Fetching transcript with yt-dlp'); return video; });
    const { item, job } = service.capture({ text: 'https://youtu.be/Q7n0PGbMW_U', files: {} });
    assert.equal(job?.kind, 'distill'); assert.equal(item.kind, 'source', 'material captured for analysis is a source');
    await wait(service);
    const done = service.list()[0]; assert.equal(done.status, 'completed', done.error); assert.equal(fetched, 'https://youtu.be/Q7n0PGbMW_U');
    assert.match(prompt, /Distill this captured source material/); assert.match(prompt, /## Transcript\n\nStarting September/);
    const source = wb.getItem(item.id), revision = wb.getRevision(item.id);
    assert.equal(source.title, 'Anthropic Is "Increasing" Your Limits'); assert.equal(source.collection, video.title, 'the video title overrides the generated topic');
    assert.equal(source.description, 'Theo explains the new limits.'); assert.ok(revision.files['transcript.md']); assert.match(revision.content, /^https:\/\/www\.youtube\.com\/watch\?v=Q7n0PGbMW_U\n/);
    assert.equal(done.createdItemIds?.length, 4); assert.equal(done.collection, video.title);
    const created = done.createdItemIds!.map(id => wb.getItem(id));
    assert.deepEqual(created.map(c => [c.kind, c.title, c.collection === done.collection, c.origin?.itemId === item.id]), [['prompt', 'Estimate my weekly Claude Code budget', true, true], ['tool', 'ccusage', true, true], ['technique', 'Compact before context hits 60%', true, true], ['tool', 'Broken URL tool', true, true]]);
    assert.equal(wb.getRevision(created[0].id).content, 'Given these session logs: {{logs}}, estimate my weekly token spend and where it concentrates.', 'prompts stay bare so Copy yields only the prompt');
    assert.equal(created[0].source, 'https://www.youtube.com/watch?v=Q7n0PGbMW_U&t=245s'); assert.deepEqual(created[0].tags, ['usage', 'claude']); assert.equal(created[0].description, 'Turns a week of session logs into a usage estimate.');
    assert.match(wb.getRevision(created[1].id).content, /^https:\/\/github\.com\/ryoppippi\/ccusage\n\nRun `npx ccusage`[\s\S]*by Theo: https:\/\/www\.youtube\.com\/watch\?v=Q7n0PGbMW_U$/);
    assert.match(wb.getRevision(created[2].id).content, /at 9:30: https:\/\/www\.youtube\.com\/watch\?v=Q7n0PGbMW_U&t=570s$/);
    assert.ok(wb.collections().includes(video.title));
    // The analysis travels with the library; the run's steps stay private.
    const [analysis] = wb.analyses(item.id);
    assert.equal(analysis.id, done.id); assert.equal(analysis.summary, 'Theo explains the new limits.'); assert.deepEqual(analysis.counts, { prompt: 1, tool: 2, technique: 1 });
    assert.deepEqual(analysis.created, done.createdItemIds); assert.equal(analysis.collection, video.title); assert.equal(wb.detail(item.id).analyses.length, 1);
    assert.ok(!JSON.stringify(analysis).includes('steps') && !JSON.stringify(analysis).includes(wb.local));
    assert.deepEqual(new Set(wb.madeFrom(item.id).map(i => i.id)), new Set(done.createdItemIds));
  } finally { wb.close(); }
});
test('a failed transcript fetch leaves the link item intact and reports the reason', async () => {
  const wb = fixture();
  try {
    const service = new AgentService(wb, () => {}, async () => ({}), async () => [], async () => { throw new Error('yt-dlp was not found on PATH.'); });
    const { item } = service.capture({ text: 'https://www.youtube.com/watch?v=Q7n0PGbMW_U', files: {} }); await wait(service);
    assert.equal(service.list()[0].status, 'failed'); assert.match(service.list()[0].error ?? '', /yt-dlp was not found/);
    assert.equal(wb.getItem(item.id).title, 'https://www.youtube.com/watch?v=Q7n0PGbMW_U'); assert.equal(wb.snapshot().items.length, 1);
  } finally { wb.close(); }
});
