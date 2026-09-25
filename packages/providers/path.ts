import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Where npm, Homebrew, Volta, Bun and the official installers put the `codex` and `claude` CLIs on macOS and Linux. An app started
 * from the Dock, Finder or a desktop launcher inherits a minimal PATH that usually has none of these.
 */
export function commonBinFolders(home: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return [];
  return [
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : ['/home/linuxbrew/.linuxbrew/bin']),
    '/usr/local/bin',
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, '.volta', 'bin'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.claude', 'local'),
  ];
}

/** Joins PATH lists in order of preference, dropping empty and repeated entries. */
export function mergePath(lists: (string | null | undefined)[], delimiter = path.delimiter): string {
  const seen = new Set<string>();
  for (const list of lists) for (const dir of (list ?? '').split(delimiter)) if (dir && !seen.has(dir)) seen.add(dir);
  return [...seen].join(delimiter);
}

const marker = '__KILN_PATH__';
/** Reads PATH from the output of `env` run between two markers, ignoring anything a shell's startup files print around it. */
export function parseShellPath(output: string): string | null {
  const start = output.indexOf(marker), end = output.lastIndexOf(marker);
  if (start < 0 || end <= start) return null;
  const line = output.slice(start + marker.length, end).split(/\r?\n/).find(entry => entry.startsWith('PATH='));
  return line ? line.slice(5).trim() || null : null;
}

/** PATH as the user's login shell sets it (nvm, asdf, mise, Homebrew shellenv, ...). Null if the shell fails or takes longer than `timeout`. */
export function loginShellPath(shell = process.env.SHELL || os.userInfo().shell || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), timeout = 5000) {
  return new Promise<string | null>(resolve => {
    try {
      const child = execFile(shell, ['-ilc', `echo ${marker}; env; echo ${marker}`], { timeout, encoding: 'utf8', env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } }, (error, stdout) => resolve(error && !stdout ? null : parseShellPath(stdout)));
      child.stdin?.end();
      child.on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

/** The PATH a desktop app on macOS or Linux should use: the login shell's, then what it was started with, then the usual CLI folders. */
export async function desktopPath(platform: NodeJS.Platform = process.platform, home = os.homedir(), current = process.env.PATH, shell: () => Promise<string | null> = () => loginShellPath()): Promise<string> {
  if (platform === 'win32') return current ?? '';
  return mergePath([await shell(), current, commonBinFolders(home, platform).join(':')], ':');
}
