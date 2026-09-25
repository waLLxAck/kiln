// The facts and sample data the homepage shows. Everything on the panel, in the folders and in the test runs is a labelled
// sample; product claims follow the root README.

// ---------- links ----------
// Every external link the site uses. To change where donations go, edit `kofi`.
export const version = '0.18.0';
export const repository = 'https://github.com/waLLxAck/kiln';
export const releases = `${repository}/releases`;
export const installer = `${releases}/download/v${version}/Kiln.Setup.${version}.exe`;
export const issues = `${repository}/issues`;
export const licence = `${repository}/blob/main/LICENSE`;
export const kofi = 'https://ko-fi.com/wallxack';
/** Pages on this site, under the base path the site is built for (`/` locally, `/kiln/` on GitHub Pages). */
export const home = import.meta.env.BASE_URL;
export const support = `${import.meta.env.BASE_URL}support/`;

/** Two prompts from a real library, condensed. */
const prompts = {
  freshEyes: { title: 'Try it as a seven-year-old', text: 'Use this app as a seven-year-old. Skip the parent-only signup. Try different activities until you hit something confusing or cannot tell what to do next. Describe that first obstacle and suggest a fix. Make no changes yet.' },
  traceInstruction: { title: 'Find the instruction that went wrong', text: 'You did X, but I expected Y. Trace the decision to instructions, messages, files or assumptions. Check AGENTS.md and CLAUDE.md for outdated guidance. Explain the cause and propose the smallest instruction change. Don’t edit anything yet.' },
};

// ---------- the skills panel ----------

export type Cell = 'on' | 'off' | 'edited' | 'found';
export type Col = 'claude' | 'shared' | 'codex' | 'copilot' | 'project';
type Drift = { why: string; line: number; del: string; add: string };
export type Row = { name: string; caption: string; rev: number; cells: Record<Col, Cell>; drift?: Partial<Record<Col, Drift>>; fresh?: boolean; pulse?: boolean };
export type Column = { key: Col; name: string; short: string; path: string; who: string };
export const columns: Column[] = [
  { key: 'claude', name: 'Claude Code', short: 'Claude', path: '~/.claude/<wbr>skills', who: 'Claude Code' },
  { key: 'shared', name: 'Shared (Codex, Copilot and others)', short: 'Shared', path: '~/.agents/<wbr>skills', who: 'Codex or Copilot' },
  { key: 'codex', name: 'Codex only', short: 'Codex', path: '~/.codex/<wbr>skills', who: 'Codex' },
  { key: 'copilot', name: 'Copilot only', short: 'Copilot', path: '~/.copilot/<wbr>skills', who: 'Copilot' },
  { key: 'project', name: 'my-game project', short: 'my-game', path: '.github/<wbr>skills', who: 'my-game' },
];
/** A column path without its line-break hints. */
export const plain = (html: string) => html.replace(/<wbr>/g, '');
export const off: Record<Col, Cell> = { claude: 'off', shared: 'off', codex: 'off', copilot: 'off', project: 'off' };
/** The sample library. The panels change it in place as the visitor flips switches, imports and approves. */
export const rows: Row[] = [
  { name: 'code-review', caption: '3 copies, 1 duplicate flagged', rev: 3, cells: { ...off, claude: 'on', shared: 'on', project: 'edited' },
    drift: { project: { why: 'Someone edited this copy by hand.', line: 12, del: 'Review standards and the specification separately.', add: 'Review the specification only. FINAL.' } } },
  { name: 'research', caption: '2 copies, 1 older', rev: 2, cells: { ...off, claude: 'on', shared: 'edited' },
    drift: { shared: { why: 'This copy is still revision 1.', line: 7, del: 'Cite sources with links and dates.', add: 'Cite sources.' } } },
  { name: 'writing-for-agents', caption: 'approved rev 1', rev: 1, cells: { ...off, claude: 'on' } },
  { name: 'playtest-brief', caption: 'approved rev 4', rev: 4, cells: { ...off, project: 'on' } },
  { name: 'pr-summary', caption: 'not in your library', rev: 0, cells: { ...off, codex: 'found' } },
];
export const stateText: Record<Cell, string> = { on: 'installed', off: 'off', edited: 'changed outside Kiln', found: 'found outside your library' };

// ---------- the doodled skill folders ----------

export type DoodleFile = { text: string; row?: string; dupe?: boolean; junk?: boolean; remark?: string; broken?: boolean };
export type DoodleFolder = { path: string; who: string; col: Col; rot: number; files: DoodleFile[] };
/** Two columns of folders, as they are drawn. */
export const folders: DoodleFolder[][] = [[
  { path: '~/.claude/skills', who: 'Claude Code', col: 'claude', rot: -1.2, files: [{ text: 'code-review', row: 'code-review' }, { text: 'code-review (1)', row: 'code-review', dupe: true, remark: 'dupe??' }, { text: 'research', row: 'research' }, { text: 'writing-for-agents', row: 'writing-for-agents' }] },
  { path: '~/.codex/skills', who: 'Codex', col: 'codex', rot: .9, files: [{ text: 'pr-summary', row: 'pr-summary', remark: 'forgot I had this' }] },
  { path: 'my-game/.github/skills', who: 'this project', col: 'project', rot: -.5, files: [{ text: 'code-review', row: 'code-review', remark: 'final-final' }, { text: 'playtest-brief', row: 'playtest-brief' }] },
], [
  { path: '~/.agents/skills', who: 'Codex, Copilot & co.', col: 'shared', rot: 1.3, files: [{ text: 'code-review', row: 'code-review' }, { text: 'research', row: 'research', remark: 'older one?' }, { text: 'old-link', junk: true, broken: true, remark: 'dead link' }] },
  { path: '~/.copilot/skills', who: 'Copilot', col: 'copilot', rot: -1.5, files: [{ text: 'untitled-skill/', junk: true, remark: '(empty)' }] },
]];
/** Where a doodled file lands on the panel: its cell, the row it duplicates, or the cleanup bar. */
export const slotOf = (f: DoodleFile, d: DoodleFolder) => (f.junk ? 'cleanup' : f.dupe ? `row:${f.row}` : `cell:${f.row}:${d.col}`);
export const targets = new Set(folders.flat().flatMap(d => d.files.map(f => slotOf(f, d))));

// ---------- the sources, and what Kiln pulls out of them ----------

type Card = { kind: string; title: string; from?: string };
export type LogLine = [kind: 'read' | 'cmd' | 'think', text: string];
type Run = { lines: LogLine[]; verdict: 'pass' | 'uncertain'; text: string; edit?: { del: string; add: string }; again?: LogLine[]; passText?: string };
export type SourceKey = 'yt' | 'x' | 'gh';
export type Pack = { key: SourceKey; chip: string; chipMeta: string; found: string; star: { kind: string; title: string; text: string; from?: string }; cards: Card[]; skill?: string; run?: Run };
export const packs: Record<SourceKey, Pack> = {
  yt: {
    key: 'yt', chip: 'I let a seven-year-old test my app (with an agent)', chipMeta: 'Pixel &amp; Pine · 18:24 · sample video',
    found: 'Found a prompt, a technique, an insight and a tool. Each one links to its minute in the video.',
    star: { kind: 'Prompt', ...prompts.freshEyes, from: '04:12' },
    cards: [{ kind: 'Technique', title: 'Test as someone who won’t read the manual', from: '07:30' }, { kind: 'Insight', title: 'You stop seeing the confusing bits of your own app', from: '11:05' }, { kind: 'Tool', title: 'A screen recorder, to replay the session', from: '15:48' }],
    skill: 'fresh-eyes',
    run: {
      lines: [['read', 'Read README.md and package.json'], ['read', 'Opened src/screens/Start.tsx'], ['cmd', 'rg -l "signup" src/'], ['think', 'Start screen wants a parent account first']],
      verdict: 'uncertain', text: 'It couldn’t get past the parent signup, so it never reached an activity. Marked uncertain instead of guessing.',
      edit: { del: 'Skip the parent-only signup.', add: 'Skip the parent-only signup. If it blocks you, use the demo profile in README.md.' },
      again: [['read', 'README.md: found the demo profile'], ['read', 'Walked Levels, Shop and Settings'], ['think', 'First obstacle: Play is an icon with no label']],
      passText: 'First obstacle: the Play button is an icon with no label. Suggested fix: put the word “Play” under it. No files changed.',
    },
  },
  x: {
    key: 'x', chip: 'Post by Nadia Brooks (@nadiabuilds)', chipMeta: 'Fictional post · sample',
    found: 'Found a prompt, a technique, an insight and a tool, linked to the post.',
    star: { kind: 'Prompt', ...prompts.traceInstruction },
    cards: [{ kind: 'Technique', title: 'Fix the instruction, not the output' }, { kind: 'Insight', title: 'Old AGENTS.md rules outlive their reasons' }, { kind: 'Tool', title: 'AGENTS.md and CLAUDE.md' }],
    skill: 'trace-the-instruction',
    run: {
      lines: [['read', 'Read AGENTS.md and CLAUDE.md'], ['cmd', 'git log -5 -- AGENTS.md'], ['read', 'Opened src/save/slots.ts'], ['think', '“Always add a migration” predates the new save format']],
      verdict: 'pass', text: 'Traced it to AGENTS.md, line 14: an outdated rule about migrations. Proposed a one-line change. No files changed.',
    },
  },
  gh: {
    key: 'gh', chip: 'mattpocock/skills', chipMeta: 'GitHub repository · skills/, README.md, LICENSE',
    found: 'Staged every skill in skills/ as a draft, linked to the repository. Nothing is installed.',
    star: { kind: 'Skills repository', title: 'mattpocock/skills', text: 'The skills in <code>skills/</code> come in as drafts for review. The repository stays where it is, and nothing is installed until you approve a revision.' },
    cards: [{ kind: 'Source note', title: 'README.md, kept with the drafts' }, { kind: 'Resource', title: 'A link back to the repository' }],
  },
};
