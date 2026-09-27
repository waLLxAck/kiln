import fs from 'node:fs';
import { MAX_ATTACHMENT_BYTES } from '../protocol/limits';
import { invariant } from '../domain/errors';
import { IGNORED_SKILL_ENTRIES } from '../domain/skills-import';
import { bundleFiles, contained, digest, noLinks, safeRelative } from '../storage/files';

export type InstalledCopy = { content: string; files: Record<string, string>; /** Entries left out by the importer's rules, relative to the copy. */ ignored: string[]; /** The state hash of the bytes read (as a deployment hashes a folder), so exactness needs no second read. */ hash: string };
/**
 * Reads an installed copy for "Keep these changes" (experimental keepOutsideEdits) with the skill importer's rules: the same
 * ignored entries, 25 MB cap, bundle checks and UTF-8 SKILL.md. Unlike the importer nothing is followed: the copy itself, a folder
 * above it or any entry inside that is a link is refused, so only files that live inside the copy's own folder are read.
 * An agent definition is its single file, capped at 2 MB like the agent importer.
 */
export function readInstalledCopy(destination: string, kind: 'skill' | 'agent'): InstalledCopy {
  noLinks(destination);
  const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
  invariant(stat, 'TARGET_CHANGED', 'There is no installed copy here any more.');
  if (kind === 'agent') {
    invariant(stat.isFile() && stat.size <= 2_000_000, 'INVALID_AGENT', 'The installed agent definition must be a regular file smaller than 2 MB.');
    const bytes = fs.readFileSync(destination);
    return { content: bytes.toString('utf8'), files: {}, ignored: [], hash: digest({ '.instruction': bytes.toString('base64') }) };
  }
  invariant(stat.isDirectory(), 'INVALID_TARGET', 'The installed skill is not a folder.');
  const files: Record<string, string> = {}, ignored: string[] = []; let size = 0;
  const visit = (directory: string, relative: string, depth: number) => {
    invariant(depth <= 12, 'INVALID_TARGET', 'The installed copy is nested too deeply to keep.');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (IGNORED_SKILL_ENTRIES.includes(entry.name)) { ignored.push(name); continue; }
      invariant(!entry.isSymbolicLink(), 'SYMLINK_REJECTED', `The copy contains a link (${name}). Kiln only keeps files that live inside the folder itself.`);
      safeRelative(name);
      const full = contained(destination, name);
      if (entry.isDirectory()) visit(full, name, depth + 1);
      else if (entry.isFile()) { size += fs.statSync(full).size; invariant(size <= MAX_ATTACHMENT_BYTES, 'ASSET_TOO_LARGE', 'The installed copy exceeds 25 MB.'); files[name] = fs.readFileSync(full).toString('base64'); }
      else ignored.push(name);
    }
  };
  visit(destination, '', 0);
  invariant(Object.hasOwn(files, 'SKILL.md'), 'INVALID_FILE', 'The installed copy has no SKILL.md.');
  const hash = digest(files), content = Buffer.from(files['SKILL.md'], 'base64').toString('utf8'); delete files['SKILL.md'];
  bundleFiles(files);
  return { content, files, ignored, hash };
}
