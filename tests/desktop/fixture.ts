import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialiseRepository } from '../../packages/git/standard';

/** A standard Kiln repository with a bare local "GitHub" as origin, so approvals commit and push for real without a network. */
export function readyLibrary(root: string, name = 'library') {
  fs.mkdirSync(root, { recursive: true });
  const created = initialiseRepository({ parent: root, name });
  if (!created.committed) throw new Error(created.message);
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['-C', created.root, 'remote', 'add', 'origin', origin], { windowsHide: true, stdio: 'ignore' });
  return created.root;
}
/** Environment for launching the desktop app against `library`. Commit messages use the plain template, so tests never call Codex. */
export function desktopEnv(root: string, library = readyLibrary(root)) {
  return { ...process.env, KILN_LIBRARY: library, KILN_LOCAL: path.join(root, 'private'), KILN_PLAIN_COMMITS: '1' };
}
