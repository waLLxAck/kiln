import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Provider, ProviderId } from '../protocol/schema';

export const providerIds = ['codex', 'claude', 'copilot'] as const;
export const providerLabel: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot' };
/** Folder under an enrolled root where the provider discovers skills. */
export const skillsFolder = (id: ProviderId, scope: 'personal' | 'project' = 'personal') => id === 'codex' ? '.agents/skills' : id === 'claude' ? '.claude/skills' : scope === 'personal' ? '.copilot/skills' : '.github/skills';

export function detectProviders(): Provider[] {
  const home = os.homedir();
  return providerIds.map(id => {
    const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    const executable = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).flatMap(dir => extensions.map(ext => path.join(dir.replace(/^"|"$/g, ''), id + ext))).find(file => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
    let version = 'Unknown'; let error: string | undefined;
    if (executable && !/\.(cmd|bat)$/i.test(executable)) {
      try { version = execFileSync(executable, ['--version'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).trim(); }
      catch { error = 'Version detection failed. Open the official client to diagnose.'; }
    } else if (executable) version = 'Windows command shim found; version shown by official client';
    return { id, label: providerLabel[id], available: Boolean(executable), executable, version, authentication: 'owned by official client' as const, modes: ['manual'] as ['manual'], skillsRoot: path.join(home, ...skillsFolder(id).split('/')), personalRoot: home, ...(error ? { error } : {}) };
  });
}
