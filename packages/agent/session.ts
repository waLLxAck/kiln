import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProviderId } from '../protocol/schema';

/**
 * Where each CLI keeps the transcript of a session it can resume. Codex writes `sessions/<yyyy>/<mm>/<dd>/rollout-<local time>-<thread id>.jsonl`
 * under CODEX_HOME; Claude Code writes `projects/<working folder, non-alphanumerics dashed>/<session id>.jsonl` under its config folder.
 * Environment overrides are honoured so tests and custom installs stay isolated.
 */
const codexSessions = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const claudeProjects = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
export const claudeProjectFolder = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');
const SESSION_ID = /^[A-Za-z0-9_-]{8,80}$/;

function find(dir: string, depth: number, match: (name: string) => boolean): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && match(entry.name)) return full;
    if (entry.isDirectory() && depth > 0) { const found = find(full, depth - 1, match); if (found) return found; }
  }
  return null;
}
/** Absolute path of the CLI's own transcript for `id`, or null when this machine does not have it. */
export function findSession(provider: RunProviderId, id: string, cwd: string): string | null {
  if (!SESSION_ID.test(id)) return null;
  if (provider === 'codex') return find(codexSessions(), 3, name => name.startsWith('rollout-') && name.endsWith(`-${id}.jsonl`));
  const expected = path.join(claudeProjects(), claudeProjectFolder(cwd), `${id}.jsonl`);
  return fs.existsSync(expected) ? expected : find(claudeProjects(), 1, name => name === `${id}.jsonl`);
}
/** Puts a saved transcript back where the CLI looks for it, so a session attached to a library item can be resumed on this machine too. */
export function restoreSession(provider: RunProviderId, id: string, cwd: string, bytes: Buffer): string {
  if (!SESSION_ID.test(id)) throw new Error('Invalid session id.');
  let file: string;
  if (provider === 'codex') {
    const when = new Date(sessionMeta(bytes).startedAt || Date.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    const [y, m, d] = [String(when.getFullYear()), pad(when.getMonth() + 1), pad(when.getDate())];
    file = path.join(codexSessions(), y, m, d, `rollout-${y}-${m}-${d}T${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}-${id}.jsonl`);
  } else file = path.join(claudeProjects(), claudeProjectFolder(cwd), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
/** Provider, session id and start time read from the first lines of a saved transcript; empty fields when the file is not recognised. */
export function sessionMeta(bytes: Buffer): { provider: RunProviderId | null; id: string; startedAt: string } {
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 200_000)).split('\n').slice(0, 20);
  for (const line of head) {
    try {
      const record = JSON.parse(line) as { type?: string; payload?: { id?: string; timestamp?: string }; sessionId?: string; timestamp?: string };
      if (record.type === 'session_meta' && record.payload?.id) return { provider: 'codex', id: String(record.payload.id), startedAt: String(record.payload.timestamp ?? '') };
      if (typeof record.sessionId === 'string' && record.sessionId) return { provider: 'claude', id: record.sessionId, startedAt: String(record.timestamp ?? '') };
    } catch { /* Not a JSON line; keep looking. */ }
  }
  return { provider: null, id: '', startedAt: '' };
}
