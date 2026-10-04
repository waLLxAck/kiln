import fs from 'node:fs';
import path from 'node:path';
import { invariant } from '../domain/errors';
import { systemLink } from '../storage/files';

/**
 * `noLinks` for many paths in one pass: each folder on the way from the drive root is checked once, not once per path. Listing
 * a hundred config files under the same few folders otherwise costs two calls per folder per file, which adds up on Windows.
 * Same rule and message as `noLinks`: a link anywhere on the path is refused unless the operating system owns it.
 */
export function linkGuard() {
  const verdicts = new Map<string, string>();
  const check = (current: string) => {
    let verdict = verdicts.get(current);
    if (verdict === undefined) {
      let linked = false;
      try { linked = fs.lstatSync(current).isSymbolicLink() && fs.existsSync(current) && !systemLink(current); } catch { /* Absent: nothing to refuse. */ }
      verdicts.set(current, verdict = linked ? `Linked path must be handled by its existing manager: ${current}` : '');
    }
    invariant(!verdict, 'SYMLINK_REJECTED', verdict);
  };
  return (absolute: string) => {
    const resolved = path.resolve(absolute), root = path.parse(resolved).root;
    let current = root;
    for (const part of resolved.slice(root.length).split(path.sep)) { current = path.join(current, part); check(current); }
  };
}
