import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Provider, ProviderId } from '../protocol/schema';
import { capture } from '../agent/process';

export const providerIds = ['codex', 'claude', 'copilot'] as const;
export const providerLabel: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot' };
/** Folder under an enrolled root where the provider discovers skills. */
export const skillsFolder = (id: ProviderId, scope: 'personal' | 'project' = 'personal') => id === 'codex' ? '.agents/skills' : id === 'claude' ? '.claude/skills' : scope === 'personal' ? '.copilot/skills' : '.github/skills';

/** A client found on PATH is checked again (one stat) on each lookup; one that was not found is looked for again after this long. */
const MISS_TTL_MS = 30_000;
/** Versions are read once per executable for this long. Only Settings and the run pickers show them. */
const VERSION_TTL_MS = 10 * 60_000;
const found = new Map<string, { executable: string | null; at: number }>();
const versions = new Map<string, { at: number; value: Promise<{ version: string; error?: string }> }>();
const isShim = (file: string) => /\.(cmd|bat)$/i.test(file);

/**
 * Where an official client is on PATH: a file lookup only, nothing is started. On Windows the native `.exe` wins over an npm `.cmd`/`.bat`
 * shim, which runners start through cmd.exe themselves. Cached per PATH value, so starting a run costs one stat.
 */
export function findExecutable(id: ProviderId, searchPath = process.env.PATH ?? process.env.Path ?? '', platform: NodeJS.Platform = process.platform): string | null {
  const key = `${platform}\0${id}\0${searchPath}`, cached = found.get(key);
  if (cached && (cached.executable ? fs.existsSync(cached.executable) : Date.now() - cached.at < MISS_TTL_MS)) return cached.executable;
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const executable = searchPath.split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean).flatMap(dir => extensions.map(ext => path.join(dir.replace(/^"|"$/g, ''), id + ext))).find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) ?? null;
  found.set(key, { executable, at: Date.now() });
  return executable;
}

/** `--version` of a native client, read without blocking (5 s at most) and cached. A Windows command shim is not started for it. */
export function providerVersion(executable: string): Promise<{ version: string; error?: string }> {
  if (isShim(executable)) return Promise.resolve({ version: 'Windows command shim found; version shown by official client' });
  const cached = versions.get(executable);
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value;
  const failed = { version: 'Unknown', error: 'Version detection failed. Open the official client to diagnose.' };
  const value = capture(executable, ['--version'], { timeoutMs: 5000, limit: 2000 }).then((result): { version: string; error?: string } => result.code === 0 && !result.timedOut ? { version: result.stdout.trim() } : failed, () => failed);
  // A failed check is not kept: the next Settings visit asks again.
  void value.then(result => { if (result.error) versions.delete(executable); });
  versions.set(executable, { at: Date.now(), value });
  return value;
}

/** Every official client with its version, for Settings and the run pickers. Runs need only `findExecutable`. */
export async function detectProviders(): Promise<Provider[]> {
  const home = os.homedir();
  return Promise.all(providerIds.map(async id => {
    const executable = findExecutable(id);
    const { version, error } = executable ? await providerVersion(executable) : { version: 'Unknown', error: undefined };
    return { id, label: providerLabel[id], available: Boolean(executable), executable, version, authentication: 'owned by official client' as const, modes: ['manual'] as ['manual'], skillsRoot: path.join(home, ...skillsFolder(id).split('/')), personalRoot: home, ...(error ? { error } : {}) };
  }));
}
