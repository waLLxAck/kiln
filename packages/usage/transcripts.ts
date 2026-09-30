import fs from 'node:fs';
import path from 'node:path';
import { addTokens, noTokens, type TokenCounts } from './prices';

/**
 * Reading Claude Code and Codex session logs, one JSONL line at a time, for the Usage view (service.ts). Only what the view needs
 * is kept: which skill was used, when, in which session and folder, and token counts per model and day. No message text leaves
 * the line it was read from.
 *
 * Shapes, as written by Claude Code 2.1 and Codex 0.15x on the machine this was built on (summarised in docs/GUIDE.md#usage):
 *
 * - **Claude Code** (`<config>/projects/<folder>/<session>.jsonl`, subagents in `<session>/subagents/agent-*.jsonl` with the
 *   parent's `sessionId`). The model asking for a skill is an assistant `tool_use` block named `Skill` with `input.skill`
 *   (`command` in older releases); the skill's text follows as a meta user message whose first line is
 *   `Base directory for this skill: <folder>` and whose `sourceToolUseID` names that block. A skill the user typed as `/name` has the
 *   same meta message without `sourceToolUseID`. One API response is written as several lines (one per content block) with the same
 *   `message.id` and growing `usage`, so a repeated id counts only what it added.
 * - **Codex** (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`). The first `session_meta` is the file's own thread (forked
 *   subagents copy their parent's history, and its `session_meta`, after it). A skill the user named (`$name`) arrives as a user
 *   message `<skill><name>…</name><path>…/SKILL.md</path>…`: observed. The agent reading a `…/skills/<name>/SKILL.md` in a
 *   command is how implicit use shows: **inferred**. Tokens come from `token_usage_record` lines for the file's own thread, or,
 *   in files without them, from the growth of `token_count`'s running total.
 */
export type Harness = 'claude' | 'codex';
/** `tool`: Claude's Skill tool. `slash`: typed as a command. `explicit`: Codex's injected `<skill>`. `inferred`: a SKILL.md read. */
export type Signal = 'tool' | 'slash' | 'explicit' | 'inferred';
export type SkillUse = { /** Stable across files, so a use copied into a forked session counts once. */ key: string; name: string; /** The skill's folder, when the log names it. */ folder: string; signal: Signal; at: string };
export type Bucket = { model: string; day: string; tokens: TokenCounts };
type ClaudeState = { lastId?: string; last?: TokenCounts; /** Skill tool calls waiting for their Base directory line: tool id → index in `uses`. */ pending: Record<string, number> };
type RawTotal = { input: number; cached: number; write: number; output: number; reasoning: number };
type CodexState = { thread?: string; records?: boolean; total?: RawTotal; model?: string; turn?: string; turnSkills: string[]; /** The latest working folder, for relative SKILL.md paths. */ cwd?: string };
/** Everything read from one log file so far, and where to carry on. Stored in the machine-private usage cache. */
export type FileEntry = {
  harness: Harness; size: number; mtimeMs: number; /** Bytes consumed: always the end of a complete line. */ offset: number;
  session: string; project: string; uses: SkillUse[]; /** `model \0 day` → tokens. */ buckets: Record<string, Bucket>;
  state: ClaudeState | CodexState; /** The file is no longer there; what it recorded is kept. */ gone?: boolean;
};

export const newEntry = (harness: Harness): FileEntry => ({ harness, size: 0, mtimeMs: 0, offset: 0, session: '', project: '', uses: [], buckets: {}, state: harness === 'claude' ? { pending: {} } : { turnSkills: [] } });

const pad = (n: number) => String(n).padStart(2, '0');
/** The local calendar day of an ISO timestamp, `YYYY-MM-DD`; '' when it does not parse. */
export function localDay(value: string | number) {
  const d = new Date(value); if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/**
 * The project a session ran in, from its working folder: the Git repository holding it (a subfolder counts as its repository, and
 * a linked worktree, such as an agent's `.claude/worktrees/<name>` or another tool's, as the repository it belongs to). A folder
 * outside any repository, or one that no longer exists, stays as it is, except `<project>/.claude/worktrees/<name>`.
 */
export function projectOf(cwd: string) {
  if (!cwd) return '';
  const trimmed = cwd.replace(/^file:\/\//, '').replace(/[\\/]+$/, '') || cwd;
  const known = roots.get(trimmed); if (known !== undefined) return known;
  let found = '';
  for (let folder = trimmed, depth = 0; depth < 12 && !found; depth++) {
    const dotGit = path.join(folder, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) found = folder;
      else if (stat.isFile()) found = fs.readFileSync(dotGit, 'utf8').match(/gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/)?.[1]?.trim() || folder;
    } catch { /* Not here: look one folder up. */ }
    const parent = path.dirname(folder); if (parent === folder) break; folder = parent;
  }
  if (!found) { const worktree = trimmed.search(/[\\/]\.(?:claude|codex)[\\/]worktrees[\\/]/); found = worktree > 0 ? trimmed.slice(0, worktree) : trimmed; }
  if (roots.size > 5000) roots.clear();
  roots.set(trimmed, found); return found;
}
const roots = new Map<string, string>();

const bytes = (text: string) => Buffer.from(text);
const claudeNeedles = [bytes('"type":"assistant"'), bytes('Base directory for this skill')];
const codexNeedles = [bytes('"session_meta"'), bytes('"turn_context"'), bytes('"token_usage_record"'), bytes('"token_count"'), bytes('<skill>'), bytes('SKILL.md')];
const BASE = 'Base directory for this skill:';
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const str = (value: unknown) => typeof value === 'string' ? value : '';

function addBucket(entry: FileEntry, model: string, at: string, tokens: TokenCounts) {
  const day = localDay(at); if (!day || !model) return;
  const key = `${model}\u0000${day}`;
  addTokens((entry.buckets[key] ??= { model, day, tokens: noTokens() }).tokens, tokens);
}
function adopt(entry: FileEntry, session: unknown, cwd: unknown) {
  if (!entry.session && typeof session === 'string') entry.session = session;
  if (!entry.project && typeof cwd === 'string') entry.project = projectOf(cwd);
}

/** Claude's usage block as token counts: input excludes cache reads and writes; the 1-hour write is split out of the total write. */
export function claudeTokens(usage: Record<string, unknown>): TokenCounts {
  const cache = (usage.cache_creation ?? {}) as Record<string, unknown>, details = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  const hour = num(cache.ephemeral_1h_input_tokens), write = num(usage.cache_creation_input_tokens);
  return { input: num(usage.input_tokens), cached: num(usage.cache_read_input_tokens), cacheWrite: Math.max(0, write - hour), cacheWrite1h: Math.min(hour, write || hour), output: num(usage.output_tokens), reasoning: num(details.thinking_tokens) };
}
function minus(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out = noTokens(); for (const key of Object.keys(out) as (keyof TokenCounts)[]) out[key] = Math.max(0, a[key] - b[key]); return out;
}

/** One Claude Code line. `offset` is the line's byte position, used to key a use whose line has no id. */
export function claudeLine(entry: FileEntry, line: Buffer, offset: number) {
  if (!claudeNeedles.some(n => line.includes(n))) return;
  let d: Record<string, any>; try { d = JSON.parse(line.toString('utf8')); } catch { return; }
  if (!d || typeof d !== 'object') return;
  const state = entry.state as ClaudeState; state.pending ??= {};
  adopt(entry, d.sessionId, d.cwd);
  const message = d.message && typeof d.message === 'object' ? d.message : null, at = str(d.timestamp);
  if (d.type === 'assistant' && message) {
    const model = str(message.model);
    if (model && model !== '<synthetic>' && message.usage && typeof message.usage === 'object') {
      const tokens = claudeTokens(message.usage), id = str(message.id);
      const delta = id && id === state.lastId && state.last ? minus(tokens, state.last) : tokens;
      state.lastId = id || undefined; state.last = tokens;
      addBucket(entry, model, at, delta);
    }
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type !== 'tool_use' || part.name !== 'Skill' || !part.input || typeof part.input !== 'object') continue;
      const name = str(part.input.skill ?? part.input.command).trim().replace(/^\//, '');
      if (!name) continue;
      const key = `claude:${str(part.id) || `${entry.session}:${offset}`}`;
      entry.uses.push({ key, name, folder: '', signal: 'tool', at });
      if (part.id) {
        state.pending[part.id] = entry.uses.length - 1;
        const ids = Object.keys(state.pending); for (const old of ids.slice(0, Math.max(0, ids.length - 50))) delete state.pending[old];
      }
    }
    return;
  }
  if (d.type !== 'user' || !message) return;
  const texts = typeof message.content === 'string' ? [message.content] : Array.isArray(message.content) ? message.content.filter((p: any) => p?.type === 'text').map((p: any) => str(p.text)) : [];
  for (const text of texts) {
    if (!text.startsWith(BASE)) continue;
    const folder = text.slice(BASE.length).split(/\r?\n/)[0].trim(); if (!folder) continue;
    const source = str(d.sourceToolUseID);
    if (source) {
      const index = state.pending[source];
      if (index !== undefined && entry.uses[index]) entry.uses[index].folder = folder;
      delete state.pending[source];
    } else entry.uses.push({ key: `claude:slash:${str(d.uuid) || `${entry.session}:${offset}`}`, name: path.basename(folder.replace(/[\\/]+$/, '')), folder, signal: 'slash', at });
  }
}

function codexRaw(usage: Record<string, unknown>): RawTotal {
  return { input: num(usage.input_tokens), cached: num(usage.cached_input_tokens), write: num(usage.cache_write_input_tokens), output: num(usage.output_tokens), reasoning: num(usage.reasoning_output_tokens) };
}
/** OpenAI's `input_tokens` includes cached (and cache-written) tokens; here input is only the uncached part. */
export function codexTokens(raw: RawTotal): TokenCounts {
  return { input: Math.max(0, raw.input - raw.cached - raw.write), cached: raw.cached, cacheWrite: raw.write, cacheWrite1h: 0, output: raw.output, reasoning: raw.reasoning };
}
/** `…/skills/<name>/SKILL.md` anywhere in a command, with either slash. */
const skillFile = /(?:[A-Za-z]:)?[^\s"'`;|&<>()=]*[\\/]skills[\\/][^\s"'`;|&<>()\\/]+[\\/]SKILL\.md/g;
function codexUse(entry: FileEntry, state: CodexState, use: SkillUse) {
  if (state.turnSkills.includes(use.name)) return;
  state.turnSkills.push(use.name); entry.uses.push(use);
}

/** One Codex rollout line. */
export function codexLine(entry: FileEntry, line: Buffer, offset: number) {
  if (!codexNeedles.some(n => line.includes(n))) return;
  let d: Record<string, any>; try { d = JSON.parse(line.toString('utf8')); } catch { return; }
  if (!d || typeof d !== 'object') return;
  const state = entry.state as CodexState; state.turnSkills ??= [];
  const p = d.payload && typeof d.payload === 'object' ? d.payload : {}, at = str(d.timestamp);
  if (d.type === 'session_meta') {
    // Only the first: later ones are a parent's, copied into a forked subagent's file.
    if (!state.thread) { state.thread = str(p.id) || undefined; entry.session ||= str(p.session_id) || str(p.id); entry.project ||= projectOf(str(p.cwd)); state.cwd ||= str(p.cwd) || undefined; }
    return;
  }
  if (d.type === 'turn_context') {
    if (p.model) state.model = str(p.model);
    if (p.cwd) { state.cwd = str(p.cwd).replace(/^file:\/\//, ''); entry.project ||= projectOf(state.cwd); }
    if (p.turn_id && p.turn_id !== state.turn) { state.turn = str(p.turn_id); state.turnSkills = []; }
    return;
  }
  if (d.type === 'token_usage_record') {
    if (state.thread && p.thread_id && p.thread_id !== state.thread) return;
    state.records = true;
    if (p.usage && typeof p.usage === 'object') addBucket(entry, state.model ?? 'unknown', at, codexTokens(codexRaw(p.usage)));
    return;
  }
  if (d.type === 'event_msg' && p.type === 'token_count') {
    const total = p.info?.total_token_usage;
    if (state.records || !total || typeof total !== 'object') return;
    const current = codexRaw(total), last = state.total;
    const grew = last && current.input + current.output >= last.input + last.output;
    const delta = grew ? { input: Math.max(0, current.input - last.input), cached: Math.max(0, current.cached - last.cached), write: Math.max(0, current.write - last.write), output: Math.max(0, current.output - last.output), reasoning: Math.max(0, current.reasoning - last.reasoning) } : current;
    state.total = current;
    if (delta.input + delta.output > 0) addBucket(entry, state.model ?? 'unknown', at, codexTokens(delta));
    return;
  }
  if (d.type !== 'response_item') return;
  if (p.type === 'message' && p.role === 'user') {
    for (const part of Array.isArray(p.content) ? p.content : []) {
      const text = str(part?.text); if (!text.startsWith('<skill>')) continue;
      const name = text.match(/<name>([^<]+)<\/name>/)?.[1]?.trim() ?? '', file = text.match(/<path>([^<]+)<\/path>/)?.[1]?.trim() ?? '';
      const folder = file ? path.dirname(file) : '';
      if (name || folder) codexUse(entry, state, { key: `codex:${str(p.id) || `${entry.session}:${offset}`}`, name: name || path.basename(folder), folder, signal: 'explicit', at });
    }
    return;
  }
  if (!['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) return;
  const command = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : JSON.stringify(p.action ?? '');
  for (const match of command.matchAll(skillFile)) {
    const relative = match[0].slice(0, -'/SKILL.md'.length), name = relative.split(/[\\/]/).at(-1) ?? '';
    // A relative path is the session's own folder's; `~/` is the home folder, which only the reader knows, so it stays as written.
    const folder = path.isAbsolute(relative) || relative.startsWith('~') || !state.cwd ? relative : path.join(state.cwd, relative);
    if (name) codexUse(entry, state, { key: `codex:${str(p.call_id) || str(p.id) || `${entry.session}:${offset}`}:${name}`, name, folder, signal: 'inferred', at });
  }
}
