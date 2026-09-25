// A scripted stand-in for `claude -p --output-format stream-json`, used only to seed the screenshot library.
// Kiln launches it exactly as it launches Claude Code; it reads the prompt from stdin, streams the same event shapes and
// ends with a `result` event carrying structured output. The replies are written for the fictional demo project.
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const pace = Number(process.env.KILN_STUB_PACE_MS ?? 4000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.argv.includes('--version')) { console.log('2.4.1 (Claude Code)'); process.exit(0); }
let input = '';
for await (const chunk of process.stdin) input += chunk;
const cwd = process.cwd();
const file = relative => path.join(cwd, ...relative.split('/'));
const session = randomUUID();
let block = 0;
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const say = text => emit({ type: 'assistant', message: { content: [{ type: 'text', id: `msg_${++block}`, text }] } });
const use = (name, input) => emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${++block}`, name, input }] } });

let steps = [], output, usage;
if (input.includes('You are the assistant inside Kiln')) {
  steps = [
    () => use('Read', { file_path: file('context.md') }),
    () => use('Grep', { pattern: 'signup|demo profile|run it again' }),
    () => say('The change is in the “Fix one thing, run it again” chapter.'),
  ];
  output = 'They changed one line of the prompt, at 13:20 (“Fix one thing, run it again”):\n\n  “Skip the parent-only signup. If it blocks you, use the demo profile in README.md.”\n\nFirst run (13:26): the agent could not get past the parent signup, so it never reached an activity.\nSecond run (13:39): it went straight to the levels and found the unlabelled play button.\n\nYour library copy of “Try it as a seven-year-old” already has that line. It is the current revision, and its experiment on my-game passed. I made no changes.';
  usage = { input_tokens: 18240, cache_read_input_tokens: 11200, output_tokens: 310 };
} else if (input.includes('Distill this captured source material')) {
  steps = [
    () => say('Reading the transcript and its six chapters. The prompt is read out word for word at 4:12, so I will keep its wording exactly.'),
    () => say('Skipping the sponsor segment (2:05 to 3:10) and the sign-off. OBS Studio is named at 15:48; its official site is obsproject.com.'),
  ];
  const entry = (type, title, description, content, timestamp, tags, url = '') => ({ type, title, description, content, url, timestamp, tags });
  output = {
    collection: 'I let a seven-year-old test my app (with an agent)',
    summary: 'A developer hands a children’s puzzle app to a coding agent with one instruction: use it like a seven-year-old would. The first run stalls at the parent signup; a one-line change to the prompt gets it to the levels, where it finds an unlabelled play button.',
    takeaway: 'Have the agent find the first place a newcomer gets stuck, fix that one thing, and run it again.',
    entries: [
      entry('prompt', 'Try it as a seven-year-old', 'Makes an agent explore your app like a young first-time player and report the first thing that stops it, without changing anything.', 'Use this app as a seven-year-old. Skip the parent-only signup. Try different activities until you hit something confusing or cannot tell what to do next. Describe that first obstacle and suggest a fix. Make no changes yet.', '4:12', ['testing', 'ux']),
      entry('technique', 'Test as someone who won’t read the manual', 'Finds the screens that only work if the player reads instructions first.', '1. Tell the agent it may not read help screens, settings or any paragraph of text.\n2. Let it tap only what looks tappable.\n3. Stop at the first moment it has to guess, and record that screen.\n4. Ignore everything after the first obstacle until it is fixed.', '7:30', ['testing', 'ux']),
      entry('insight', 'You stop seeing the confusing bits of your own app', 'Why a fresh-eyes run finds problems the builder has walked past for months.', 'Familiarity hides confusion: the builder reads an unlabelled triangle as “play” because they drew it. A tester with no history reads it as a shape. Budget a fresh-eyes run for every screen you have stopped looking at.', '11:05', ['ux']),
      entry('technique', 'Fix one thing, then run it again', 'Keeps a test loop short by changing one line of the prompt or the app between runs.', '1. Run the prompt and note the first obstacle.\n2. Change exactly one thing: one line of the prompt, or one screen of the app.\n3. Run the same prompt on the same project again.\n4. Compare the two reports before changing anything else.', '13:20', ['testing', 'workflow']),
      entry('tool', 'OBS Studio, to replay the session', 'Free screen recorder used to capture the whole test run so you can scrub to the moment the agent got stuck.', 'Records the screen while the agent or a player uses the app. When a report names a confusing screen, scrub to that point in the recording and show it to the team.', '15:48', ['recording'], 'https://obsproject.com/'),
    ],
    skipped: 'Sponsor segment (2:05 to 3:10) and the channel updates at the end.',
  };
  usage = { input_tokens: 21480, cache_read_input_tokens: 12800, output_tokens: 1930 };
} else if (input.includes('Run a bounded experiment')) {
  if (input.includes('use the demo profile in README.md')) {
    steps = [
      () => say('The prompt now points at a demo profile in README.md. I will check that first, then walk the screens a new player reaches.'),
      () => use('Read', { file_path: file('README.md') }),
      () => use('Read', { file_path: file('src/save/profile.ts') }),
      () => use('Read', { file_path: file('src/screens/Start.tsx') }),
      () => say('With ?profile=demo, useProfile returns the demo profile, so Start skips ParentGate and renders Levels.'),
      () => use('Glob', { pattern: 'src/screens/*.tsx' }),
      () => use('Read', { file_path: file('src/screens/Levels.tsx') }),
      () => use('Read', { file_path: file('src/screens/Shop.tsx') }),
      () => say('The first thing a player meets on Levels is the play control, and it has no text.'),
    ];
    output = {
      judgement: 'pass',
      note: 'Found a concrete first obstacle with a file reference and a one-line fix, using read access only. Judged from the code; the app was not run.',
      output: 'Used the demo profile from README.md (“Local testing → Demo profile”). With ?profile=demo, src/save/profile.ts returns the demo profile, so Start renders Levels without the parent gate.\n\nFirst obstacle: on Levels, the play control is an icon with no label (src/screens/Levels.tsx:4, <IconButton icon="triangle" />). A seven-year-old who does not read the triangle as “play” has no other cue for what starts a level. AGENTS.md already asks for a visible text label on every button.\n\nSuggested fix: put the word “Play” under the icon and make the whole level card tappable.\n\nNot reached: Shop is behind ParentGate (“Ask a grown-up”), which is expected for a children’s app.\n\nNo files were changed.',
    };
    usage = { input_tokens: 38950, cache_read_input_tokens: 27600, output_tokens: 1210 };
  } else {
    steps = [
      () => say('I will read the README and the start screen first, then look for the parent-only signup the prompt asks me to skip.'),
      () => use('Read', { file_path: file('README.md') }),
      () => use('Read', { file_path: file('package.json') }),
      () => use('Grep', { pattern: 'ParentGate|signup' }),
      () => use('Read', { file_path: file('src/screens/Start.tsx') }),
      () => say('Start shows ParentGate until a profile exists. The prompt says to skip the signup but not how, and creating an account would need writes and a running app.'),
    ];
    output = {
      judgement: 'uncertain',
      note: 'Could not get past the parent signup, so no activity was tried. Marked uncertain rather than guessing.',
      output: 'Start renders <ParentGate reason="Create a parent account to save progress" /> whenever useProfile() returns nothing (src/screens/Start.tsx:6). Every activity is behind it.\n\nThe prompt asks me to skip the parent-only signup, but nothing in it says how. Creating an account would mean writing a profile and running the app, which this read-only experiment cannot do.\n\nFirst obstacle: not reached. To test the activities, the prompt needs a way past the gate, such as a demo profile or test account.\n\nNo files were changed.',
    };
    usage = { input_tokens: 24310, cache_read_input_tokens: 16900, output_tokens: 860 };
  }
} else {
  steps = [
    () => say('Shaping the prompt into a skill with the bundled writing guidance: a trigger-first description, numbered steps and a clear stopping point.'),
    () => use('Read', { file_path: file('guidance.md') }),
  ];
  output = {
    name: 'fresh-eyes',
    description: 'Explores an app as a young first-time player and reports the first obstacle with a suggested fix.',
    skill: `---
name: fresh-eyes
description: Explore an app the way a young first-time player would and report the first obstacle, with a suggested fix. Use when asked to test onboarding, first-run flows or a children's app with fresh eyes.
---

# Fresh eyes

## Procedure
1. Use the app as a seven-year-old. Do not read help screens or settings.
2. If a parent-only signup blocks you, use the demo profile described in README.md.
3. Try different activities until you hit something confusing or cannot tell what to do next.
4. Stop at that first obstacle. Describe the screen, what you expected and what happened.
5. Suggest the smallest fix.

## Limitations
Make no changes. Report the first obstacle only; later ones depend on fixing it.
`,
    notes: 'Kept the source prompt’s wording for the steps. Added the demo-profile line from its second revision.',
  };
  usage = { input_tokens: 15620, cache_read_input_tokens: 9400, output_tokens: 980 };
}

await sleep(pace / 2);
emit({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: session, cwd, tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] });
for (const step of steps) { await sleep(pace); step(); }
await sleep(pace);
emit(typeof output === 'string'
  ? { type: 'result', subtype: 'success', is_error: false, session_id: session, result: output, usage }
  : { type: 'result', subtype: 'success', is_error: false, session_id: session, result: JSON.stringify(output), structured_output: output, usage });
