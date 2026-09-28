import { parse } from 'yaml';
import type { Authoring, Bundle, SkillInvocation } from '../protocol/schema';
import { invariant } from './errors';

/**
 * Whether the model may invoke a skill on its own, read from and written to the skill's own files (docs/SKILL_INVOCATION.md):
 *
 * - `claude`: `disable-model-invocation: true` in SKILL.md's front-matter. Claude Code reads it; so does Copilot in VS Code.
 * - `codex`: `policy.allow_implicit_invocation: false` in the bundled `agents/openai.yaml`. Only Codex reads that file.
 *
 * Turning invocation off writes both; turning it on removes what says "off" and nothing else. Every other byte (key order,
 * quoting, comments, line endings, a byte-order mark) is kept, so the change is one line and can be recognised as flag-only.
 */
export type { SkillInvocation };
export const CODEX_POLICY_FILE = 'agents/openai.yaml';
const CLAUDE_KEY = 'disable-model-invocation';
const CODEX_KEY = 'allow_implicit_invocation';

type Lines = { bom: string; lines: string[]; eols: string[] };
/** Splits text into lines, keeping each line's own ending ('' for a last line without one) so joining gives the bytes back. */
function split(text: string): Lines {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '', body = text.slice(bom.length), lines: string[] = [], eols: string[] = [];
  const re = /\r\n|\n|\r/g; let at = 0, match: RegExpExecArray | null;
  while ((match = re.exec(body))) { lines.push(body.slice(at, match.index)); eols.push(match[0]); at = match.index + match[0].length; }
  if (at < body.length || !lines.length) { lines.push(body.slice(at)); eols.push(''); }
  return { bom, lines, eols };
}
const join = ({ bom, lines, eols }: Lines) => bom + lines.map((line, i) => line + eols[i]).join('');
/** The line ending a text uses: its first one, else LF. */
const eolOf = (value: Lines) => value.eols.find(Boolean) ?? '\n';

/** Index of the front-matter's closing `---` line, or -1 when the text has no front-matter. */
function frontMatterEnd(value: Lines) {
  if (value.lines[0]?.trimEnd() !== '---') return -1;
  for (let i = 1; i < value.lines.length; i++) if (/^---[ \t]*$/.test(value.lines[i])) return i;
  return -1;
}
/** A top-level `key: value` line with an inline scalar (and maybe a comment). */
const keyLine = (key: string) => new RegExp(`^${key.replace(/[-]/g, '\\-')}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`);
/**
 * An inline YAML value as a boolean, or null for anything else. Claude Code reads `yes`, `no`, `on`, `off`, `1` and `0` in any
 * case as booleans too (`loose`); Codex parses `agents/openai.yaml` strictly, so only `true` and `false` count there.
 */
function scalar(value: string, loose: boolean): boolean | null {
  let bare = value.replace(/(^|\s)#.*$/, '').trim();
  if (loose) bare = bare.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
  return (loose ? /^(true|yes|on|1)$/ : /^(true|True|TRUE)$/).test(bare) ? true : (loose ? /^(false|no|off|0)$/ : /^(false|False|FALSE)$/).test(bare) ? false : null;
}
/** A parsed front-matter value as Claude Code reads a boolean field. */
const loosely = (value: unknown) => value === true || ((typeof value === 'string' || typeof value === 'number') && scalar(String(value), true) === true);
/** A key written as a block (`key:` with the value on the lines below), which removing or replacing one line would break. */
const blockValue = (raw: string) => !raw.replace(/(^|\s)#.*$/, '').trim();

/** The front-matter mapping, or null when there is none or it is not valid YAML. */
function frontMatter(content: string): Record<string, unknown> | null {
  const value = split(content), end = frontMatterEnd(value);
  if (end < 0) return null;
  try { const meta = parse(value.lines.slice(1, end).join('\n')); return meta && typeof meta === 'object' ? meta : null; } catch { return null; }
}
const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');
function codexPolicy(files: Record<string, string>): unknown {
  const file = files[CODEX_POLICY_FILE]; if (file === undefined) return undefined;
  try { const meta = parse(decode(file)); return meta && typeof meta === 'object' ? (meta as { policy?: { [CODEX_KEY]?: unknown } }).policy?.[CODEX_KEY] : undefined; } catch { return undefined; }
}

/** Whether an `agents/openai.yaml` text lets Codex invoke the skill implicitly (anything but a parsed `false` does). */
export function codexAllows(text: string) {
  try { const meta = parse(text); return !(meta && typeof meta === 'object' && (meta as { policy?: { [CODEX_KEY]?: unknown } }).policy?.[CODEX_KEY] === false); } catch { return true; }
}
/**
 * The front-matter fields a harness lists or acts on at session start, read from an installed SKILL.md (or a Claude command
 * file): `model` is false with `disable-model-invocation` set the way Claude Code reads it.
 */
export function skillMeta(content: string) {
  const meta = frontMatter(content) ?? {}, text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  return { name: text(meta.name), description: text(meta.description), whenToUse: text(meta.when_to_use), model: !loosely(meta[CLAUDE_KEY]) };
}
/** What the skill's files say. Missing keys mean the client's default, which is "the model may invoke it". */
export function readInvocation(bundle: Pick<Bundle, 'content' | 'files'>): SkillInvocation {
  return { claude: !loosely(frontMatter(bundle.content)?.[CLAUDE_KEY]), codex: codexPolicy(bundle.files) !== false };
}
/**
 * Characters of the entry a harness lists for this skill at session start: `name: description`, with Claude Code's
 * `when_to_use` appended. The exact wire format is not published; this is what the session-start estimate counts.
 */
export function listingChars(content: string) {
  const meta = frontMatter(content) ?? {}, text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const description = [text(meta.description), text(meta.when_to_use)].filter(Boolean).join(' ');
  return `- ${text(meta.name)}: ${description}`.length;
}
/** One word for the whole skill: every client may invoke it, none may, or they differ. */
export const invocationSummary = (value: SkillInvocation): 'model' | 'user' | 'mixed' => value.claude && value.codex ? 'model' : !value.claude && !value.codex ? 'user' : 'mixed';

/** SKILL.md with `disable-model-invocation` set (`allowed: false`) or removed (`allowed: true`). An explicit `false` is kept as it is. */
export function setClaudeInvocation(content: string, allowed: boolean): string {
  const value = split(content), end = frontMatterEnd(value), eol = eolOf(value), pattern = keyLine(CLAUDE_KEY);
  if (end < 0) {
    if (allowed) return content;
    // No front-matter at all: start one that holds only the flag (the skill still needs a name and description to be valid).
    return value.bom + `---${eol}${CLAUDE_KEY}: true${eol}---${eol}` + content.slice(value.bom.length);
  }
  const index = value.lines.slice(1, end).findIndex(line => pattern.test(line)) + 1;
  if (index > 0) {
    const raw = pattern.exec(value.lines[index])![1], current = scalar(raw, true);
    invariant(!blockValue(raw), 'INVOCATION_UNSUPPORTED', `SKILL.md sets ${CLAUDE_KEY} over several lines. Edit it by hand.`);
    // On: drop a true (or any value that is not a false); an explicit false already says "on" and stays. Off: a true stays as written.
    if (allowed ? current === false : current === true) return content;
    if (allowed) { value.lines.splice(index, 1); value.eols.splice(index, 1); } else value.lines[index] = `${CLAUDE_KEY}: true`;
    return join(value);
  }
  if (allowed) return content;
  value.lines.splice(end, 0, `${CLAUDE_KEY}: true`); value.eols.splice(end, 0, eol);
  return join(value);
}

/** `agents/openai.yaml` text with `policy.allow_implicit_invocation` set to false, or that line removed; null means no file. */
export function setCodexInvocation(text: string | null, allowed: boolean): string | null {
  if (text === null) return allowed ? null : `policy:\n  ${CODEX_KEY}: false\n`;
  const value = split(text), eol = eolOf(value);
  const policy = value.lines.findIndex(line => /^policy[ \t]*:/.test(line));
  if (policy >= 0) invariant(/^policy[ \t]*:[ \t]*(#.*)?$/.test(value.lines[policy]), 'INVOCATION_UNSUPPORTED', `${CODEX_POLICY_FILE} writes policy on one line. Edit it by hand.`);
  // The policy block: the indented (or blank) lines under `policy:`, up to the next top-level line.
  let blockEnd = policy + 1;
  if (policy >= 0) while (blockEnd < value.lines.length && (/^[ \t]/.test(value.lines[blockEnd]) || !value.lines[blockEnd].trim())) blockEnd++;
  while (policy >= 0 && blockEnd > policy + 1 && !value.lines[blockEnd - 1].trim()) blockEnd--;
  const child = new RegExp(`^([ \\t]+)${CODEX_KEY}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`);
  const index = policy < 0 ? -1 : value.lines.slice(policy + 1, blockEnd).findIndex(line => child.test(line)) + policy + 1;
  if (index > policy && policy >= 0) {
    const [, indent, raw] = child.exec(value.lines[index])!, current = scalar(raw, false);
    invariant(!blockValue(raw), 'INVOCATION_UNSUPPORTED', `${CODEX_POLICY_FILE} sets ${CODEX_KEY} over several lines. Edit it by hand.`);
    if (allowed ? current === true : current === false) return text;
    if (!allowed) { value.lines[index] = `${indent}${CODEX_KEY}: false`; return join(value); }
    value.lines.splice(index, 1); value.eols.splice(index, 1);
    // An emptied policy block goes too, and a file left with nothing in it is removed.
    const end = blockEnd - 1;
    if (!value.lines.slice(policy + 1, end).some(line => line.trim() && !/^[ \t]*#/.test(line))) { value.lines.splice(policy, end - policy); value.eols.splice(policy, end - policy); }
    const rest = join(value);
    return rest.replace(/^\uFEFF/, '').trim() ? rest : null;
  }
  if (allowed) return text;
  if (policy >= 0) {
    const sibling = value.lines.slice(policy + 1, blockEnd).find(line => line.trim())?.match(/^[ \t]+/)?.[0] ?? '  ';
    // The new line ends as the policy line did, so a file without a final newline still has none.
    const ending = value.eols[policy]; value.eols[policy] = ending || eol;
    value.lines.splice(policy + 1, 0, `${sibling}${CODEX_KEY}: false`); value.eols.splice(policy + 1, 0, ending);
    return join(value);
  }
  const rest = join(value), body = rest.slice(value.bom.length);
  return rest + (body && !/[\r\n]$/.test(body) ? eol : '') + `policy:${eol}  ${CODEX_KEY}: false${eol}`;
}

/** The bundle with model invocation allowed or not, for every client Kiln knows a switch for. Unchanged when it already says so. */
export function setModelInvocation<T extends Pick<Bundle, 'content' | 'files'>>(bundle: T, allowed: boolean): T {
  const content = setClaudeInvocation(bundle.content, allowed);
  const before = bundle.files[CODEX_POLICY_FILE], after = setCodexInvocation(before === undefined ? null : decode(before), allowed);
  const files = { ...bundle.files };
  if (after === null) delete files[CODEX_POLICY_FILE];
  else if (before === undefined || decode(before) !== after) files[CODEX_POLICY_FILE] = encode(after);
  return { ...bundle, content, files };
}

/**
 * The bundle with every model-invocation line taken out, whatever it says: what two revisions are compared on to tell a
 * flag-only change. An `agents/openai.yaml` left empty is dropped, as turning invocation back on would.
 */
function withoutFlags(bundle: Pick<Bundle, 'content' | 'files'>) {
  const value = split(bundle.content), end = frontMatterEnd(value), pattern = keyLine(CLAUDE_KEY);
  for (let i = end - 1; i > 0; i--) if (pattern.test(value.lines[i])) { value.lines.splice(i, 1); value.eols.splice(i, 1); }
  const files = { ...bundle.files }, policy = files[CODEX_POLICY_FILE];
  if (policy !== undefined) {
    const text = decode(policy);
    // Setting it to "allowed" after forcing an explicit value to false removes the line whatever it said.
    let stripped: string | null;
    try { stripped = setCodexInvocation(setCodexInvocation(text, false), true); } catch { stripped = text; }
    if (stripped === null) delete files[CODEX_POLICY_FILE]; else files[CODEX_POLICY_FILE] = encode(stripped);
  }
  return { content: join(value), files };
}
const sameFiles = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
};
/**
 * Whether `next` differs from `approved` only in model-invocation flags: the same title, description, tags, kind, source,
 * licence and agent, and the same bytes in SKILL.md and every bundled file once the flag lines are taken out of both.
 * The collection is left out: it is organisation, never part of what is approved.
 */
export function flagOnlyChange(approved: Authoring, next: Authoring) {
  if (approved.kind !== 'skill' || next.kind !== 'skill') return false;
  const meta = (value: Authoring) => JSON.stringify([value.title, value.description, value.tags, value.source, value.licence, value.agent ?? null]);
  if (meta(approved) !== meta(next)) return false;
  const a = withoutFlags(approved), b = withoutFlags(next);
  return a.content === b.content && sameFiles(a.files, b.files);
}
