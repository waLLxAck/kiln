/**
 * The fictional demo library the screenshots show. Every name, project, video and channel here is invented; the two prompts
 * are the real examples from apps/marketing/src/content.ts, and the writing-for-agents skill is Kiln's own bundled guidance.
 */
import fs from 'node:fs';
import path from 'node:path';

const guidance = (name: string) => fs.readFileSync(path.resolve('packages', 'agent', 'guidance', name), 'utf8');
const b64 = (text: string) => Buffer.from(text).toString('base64');

/** The two example prompts on the marketing site, word for word, and the one-line fix the site's test run makes to the first. */
export const prompts = {
  freshEyes: { title: 'Try it as a seven-year-old', text: 'Use this app as a seven-year-old. Skip the parent-only signup. Try different activities until you hit something confusing or cannot tell what to do next. Describe that first obstacle and suggest a fix. Make no changes yet.' },
  traceInstruction: { title: 'Find the instruction that went wrong', text: 'You did X, but I expected Y. Trace the decision to instructions, messages, files or assumptions. Check AGENTS.md and CLAUDE.md for outdated guidance. Explain the cause and propose the smallest instruction change. Don’t edit anything yet.' },
  fix: { del: 'Skip the parent-only signup.', add: 'Skip the parent-only signup. If it blocks you, use the demo profile in README.md.' },
};

export const skills = {
  codeReview: {
    title: 'code-review', collection: 'Code quality', tags: ['review', 'git'],
    content: `---
name: code-review
description: Review a change for defects before it is merged. Use when asked to review a diff, a branch or a pull request, or to check work before committing.
---

# Code review

Review the change in two passes, standards and specification, and report them separately.

## Inputs
- The diff or branch to review, and the branch it merges into.
- The task, issue or specification the change is meant to satisfy, when there is one.

## Procedure
1. Read the whole diff once before commenting. Note which files changed and why.
2. Standards pass: check the change against [the checklist](references/checklist.md) and the conventions already used in the surrounding code.
3. Specification pass: compare the behaviour with what the task asked for. List anything missing, extra or different.
4. For each finding, give the file and line, what is wrong, why it matters and the smallest fix.
5. Separate blocking defects from suggestions. Say plainly when nothing is blocking.

## Checks
- Every finding points at a specific line.
- Claims about behaviour are backed by the code, a test or a command you ran.

## Limitations
Do not rewrite the change unless asked. Never approve or merge it.
`,
    files: { 'references/checklist.md': b64(`# Review checklist

- Names say what a thing is, not how it is built.
- Errors are handled where they can be acted on, and surfaced otherwise.
- New behaviour has a test that fails without the change.
- No secrets, tokens or machine paths in code, logs or fixtures.
- Public interfaces keep backwards compatibility, or the change says why not.
- Comments explain why; the code already says what.
`) },
    /** What someone changed by hand in the my-game project's copy. */
    handEdit: { del: 'Review the change in two passes, standards and specification, and report them separately.', add: 'Review the change in one pass. Only report blocking defects.' },
  },
  research: {
    title: 'research', collection: 'Research & writing', tags: ['research', 'sources'],
    content: (cite: string) => `---
name: research
description: Research a technical question from primary sources and report what is known, with citations. Use when asked to compare options, check how something works, or confirm a fact before relying on it.
---

# Research

## Procedure
1. Restate the question in one sentence and list what would answer it.
2. Prefer primary sources: official documentation, specifications, release notes and source code.
3. Read at least two independent sources before concluding. Note where they disagree.
4. ${cite}
5. Keep what the sources say apart from your own inference.

## Output
A short answer first, then the evidence, then open questions.

## Limitations
Say when a source is more than a year old or when a claim could not be verified.
`,
    before: 'Cite sources.', after: 'Cite sources with links and dates.',
  },
  writing: {
    title: 'writing-for-agents', collection: 'Research & writing', tags: ['writing', 'skills'],
    content: guidance('writing-for-agents.md'),
    files: { 'SKILL-MECHANICS.md': b64(guidance('skill-mechanics.md')) },
  },
  playtest: {
    title: 'playtest-brief', collection: 'Game dev', tags: ['games', 'playtest'],
    content: `---
name: playtest-brief
description: Write a one-page brief for a playtest session covering goals, players, what to watch and what to ask afterwards. Use before a playtest or when asked to plan one.
---

# Playtest brief

## Procedure
1. Name the one question this session should answer, such as "Can a new player finish level 1 without help?".
2. Describe who plays: age, experience with the genre, and whether they have seen the game before.
3. List what to watch for: where players hesitate, what they tap first, what they say out loud.
4. Write three questions to ask afterwards. Keep them open: "What did you expect to happen when…?"
5. Note the build, device and time limit.

## Output
One page. Goal first, questions last. No more than ten watch points.

## Limitations
A brief plans a session; it does not replace watching real players.
`,
  },
  releaseNotes: {
    title: 'release-notes', collection: 'Code quality', tags: ['git', 'writing'],
    content: `---
name: release-notes
description: Draft release notes from the commits since the last tag. Use when preparing a release or when asked what changed between two versions.
---

# Release notes

## Procedure
1. Find the previous tag and list the commits since it.
2. Group changes as New, Improved and Fixed. Leave out refactors that users cannot see.
3. Write each entry as what the user can now do, in one sentence.
4. List breaking changes first, with the migration step.

## Limitations
Only describe what the commits show. Ask when a change's purpose is unclear.
`,
  },
};

/** A skill that sits in the Claude folder but not in the library, found by "Find skills and agents not in the library". */
export const unmanagedSkill = `---
name: pr-summary
description: Summarise a pull request for reviewers. Use when opening a pull request or asked to describe a branch.
---

# PR summary

1. Read the diff against the base branch.
2. Write what changed and why in three sentences or fewer.
3. List how it was tested and anything reviewers should look at first.
`;
export const unmanagedAgent = `---
name: test-runner
description: Runs the project's tests after a change and reports failures with the smallest reproduction.
tools: Read, Grep, Glob, Bash
---

Run the test command from the project README. When a test fails, report the test name, the assertion and the file and line.
Do not change the tests to make them pass.
`;

export const video = {
  id: 'kilnDemo001',
  title: 'I let a seven-year-old test my app (with an agent)',
  channel: 'Pixel & Pine',
  duration: 1104,
  uploadDate: '20260612',
  description: 'I handed my puzzle app to a coding agent with one instruction: use it like a seven-year-old would. It got stuck in the first minute, and that turned out to be the most useful test I have run all year.\n\nChapters\n0:00 Why test like a kid\n4:12 The prompt\n7:30 Testing without the manual\n11:05 What I stopped seeing\n13:20 Fix one thing, run it again\n15:48 Replaying the session',
  chapters: [['Why test like a kid', 0], ['The prompt', 252], ['Testing without the manual', 450], ['What I stopped seeing', 665], ['Fix one thing, run it again', 800], ['Replaying the session', 948]] as [string, number][],
};
/** Caption cues for the demo video: [seconds, text]. */
const cues: [number, string][] = [
  [0, 'So this week I tried something a little different.'], [4, 'I have a puzzle app for kids, and I know it far too well.'], [9, 'I can’t see it the way a new player does any more.'],
  [15, 'So I asked a coding agent to use it like a seven-year-old would.'], [22, 'No manual, no signup, just poking at things until something stops making sense.'],
  [31, 'And honestly, it got stuck in the first minute.'], [38, 'Which is exactly what I needed to see.'],
  [125, 'Quick thanks to this week’s sponsor before we get into it.'], [190, 'Okay, back to the app.'],
  [252, 'Here’s the prompt, word for word, and I’ll put it in the description.'], [258, 'Use this app as a seven-year-old. Skip the parent-only signup.'],
  [264, 'Try different activities until you hit something confusing or cannot tell what to do next.'], [271, 'Describe that first obstacle and suggest a fix. Make no changes yet.'],
  [279, 'That last line matters. I want a report first, not a pile of edits.'],
  [450, 'The trick is to test as someone who will not read anything.'], [456, 'A seven-year-old skips every paragraph of text you wrote.'],
  [463, 'So you tell the agent: no reading the help screen, no settings, just tap what looks tappable.'], [472, 'And write down the first moment it has to guess.'],
  [480, 'You only want the first obstacle. Everything after it is noise until that one is fixed.'],
  [665, 'Here’s what surprised me. I built every one of these screens.'], [671, 'And I had completely stopped seeing that the play button is just a triangle.'],
  [678, 'No label, nothing. To me it’s obviously play. To a new player it’s a shape.'], [686, 'You stop seeing the confusing bits of your own app. Everyone does.'],
  [800, 'So I changed one line in the prompt and ran it again.'], [806, 'The first run could not get past the parent signup at all.'],
  [812, 'So I told it to use the demo profile from the README if the signup blocks it.'], [819, 'Second run went straight to the levels, and found the unlabelled play button.'],
  [827, 'Fix one thing, run it again. That’s the whole loop.'],
  [948, 'Last tip: record the session so you can replay it.'], [953, 'I use OBS Studio, it’s free and it records the whole screen.'],
  [960, 'When the agent says it got confused at a certain screen, you can scrub straight to it.'], [968, 'And you can show it to the rest of the team.'],
  [1090, 'That’s it for this one. Try the prompt on your own app and tell me where it got stuck.'],
];
const vttTime = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`;
export const videoFiles = {
  [`${video.id}.en.vtt`]: `WEBVTT\nKind: captions\nLanguage: en\n\n${cues.map(([at, text], i) => `${vttTime(at)} --> ${vttTime(cues[i + 1]?.[0] ?? at + 6)}\n${text}\n`).join('\n')}`,
  [`${video.id}.info.json`]: JSON.stringify({ id: video.id, title: video.title, channel: video.channel, duration: video.duration, upload_date: video.uploadDate, description: video.description, webpage_url: `https://www.youtube.com/watch?v=${video.id}`, chapters: video.chapters.map(([title, start_time], i) => ({ title, start_time, end_time: video.chapters[i + 1]?.[1] ?? video.duration })) }),
};

/** The fictional game project the experiment runs on, and a second project so the selector has a choice. */
export const projects: Record<string, Record<string, string>> = {
  'my-game': {
    'README.md': `# Puzzle Garden

A puzzle game for children aged 5 to 9. Players grow a garden by solving short logic puzzles.

## Running it

\`\`\`sh
npm install
npm run dev
\`\`\`

## Local testing

### Demo profile
Start the app with \`?profile=demo\` to skip the parent gate. The demo profile has three levels unlocked and no purchases.
`,
    'package.json': JSON.stringify({ name: 'puzzle-garden', version: '0.9.2', private: true, scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' }, dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' }, devDependencies: { vite: '^7.3.0', vitest: '^3.2.0' } }, null, 2) + '\n',
    'src/screens/Start.tsx': `import { ParentGate } from '../parents/ParentGate';\nimport { useProfile } from '../save/profile';\n\nexport function Start() {\n  const profile = useProfile();\n  if (!profile) return <ParentGate reason="Create a parent account to save progress" />;\n  return <Levels />;\n}\n`,
    'src/screens/Levels.tsx': `export function Levels({ levels }: { levels: Level[] }) {\n  return <ul className="levels">{levels.map(level => <li key={level.id}>\n    <img src={level.art} alt="" />\n    <IconButton icon="triangle" onClick={() => play(level)} />\n  </li>)}</ul>;\n}\n`,
    'src/screens/Shop.tsx': 'export function Shop() {\n  return <ParentGate reason="Ask a grown-up" />;\n}\n',
    'src/save/profile.ts': 'export function useProfile() {\n  const demo = new URLSearchParams(location.search).get("profile") === "demo";\n  return demo ? demoProfile : loadProfile();\n}\n',
    'AGENTS.md': '# Puzzle Garden\n\n- Run `npm test` before proposing a change.\n- Screens live in src/screens; one component per file.\n- Every button needs a visible text label; icons alone are not enough for young players.\n',
    'CLAUDE.md': '@AGENTS.md\n',
    '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm test:*)', 'Bash(npm run build:*)'], deny: ['Read(./.env)'] } }, null, 2) + '\n',
  },
  'orders-api': {
    'README.md': '# Orders API\n\nA small HTTP service for the shop backend.\n',
    'package.json': JSON.stringify({ name: 'orders-api', version: '2.4.0', private: true, scripts: { start: 'node src/server.js', test: 'node --test' } }, null, 2) + '\n',
    'src/server.js': 'import http from "node:http";\n',
    'AGENTS.md': '# Orders API\n\n- Keep handlers small; business rules live in src/orders.\n',
  },
};

/** Personal agent configuration in the demo home folder. */
export const configFiles: Record<string, string> = {
  '.claude/settings.json': JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: { allow: ['Bash(npm test:*)', 'Bash(npm run lint:*)', 'Bash(git diff:*)', 'Bash(git log:*)'], deny: ['Read(./.env)', 'Read(./.env.*)', 'Read(./secrets/**)'] },
    hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npm run lint --silent' }] }] },
  }, null, 2) + '\n',
  '.claude/CLAUDE.md': '# Personal instructions\n\n- Ask before adding a dependency.\n- Prefer small, reviewable commits with a one-line summary.\n- When a test fails, show the failing assertion before proposing a fix.\n',
  '.codex/config.toml': 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nnetwork_access = false\n',
  '.codex/AGENTS.md': '# Personal instructions\n\n- Ask before adding a dependency.\n- Keep changes small and explain them in plain language.\n',
};
