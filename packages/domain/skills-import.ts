import { MAX_ATTACHMENT_BYTES } from '../protocol/limits';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Workbench } from './workbench';
import { invariant } from './errors';
import { revisionHash, validateContent } from './content';
import { authoringSchema, type Authoring } from '../protocol/schema';
import { bundleFiles, digest, safeRelative } from '../storage/files';
import { providerIds, skillsFolder } from '../providers/service';

const LIMIT = MAX_ATTACHMENT_BYTES;
/**
 * Reads a skill folder for import, following links so a skill that points at shared files elsewhere arrives complete.
 * Unlike the library's own bundle reader this dereferences symlinks and junctions; a cycle guard and the 25 MB cap keep it bounded.
 */
export function readSkillFolder(root: string): Record<string, string> {
  const files: Record<string, string> = {}; let size = 0; const seen = new Set<string>();
  const visit = (directory: string, relative: string, depth: number) => {
    let real: string; try { real = fs.realpathSync(directory).toLowerCase(); } catch { return; }
    if (seen.has(real) || depth > 12) return; seen.add(real);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '__pycache__', '.DS_Store'].includes(entry.name)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      let stat: fs.Stats; try { stat = fs.statSync(full); } catch { continue; } // A dangling link has nothing to copy.
      safeRelative(name);
      if (stat.isDirectory()) visit(full, name, depth + 1);
      else if (stat.isFile()) { size += stat.size; invariant(size <= LIMIT, 'ASSET_TOO_LARGE', `Skill folder exceeds 25 MB: ${root}`); files[name] = fs.readFileSync(full).toString('base64'); }
    }
  };
  visit(root, '', 0); bundleFiles(files); return files;
}
/** The frontmatter `name`, falling back to the folder name when the frontmatter is missing or malformed. */
export function skillTitle(folder: string, content: string) {
  try { const meta = parse(content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''); if (typeof meta?.name === 'string' && meta.name.trim()) return meta.name.trim(); } catch { /* Invalid metadata still gets a title. */ }
  return path.basename(folder);
}
/** A complete skill bundle from a folder holding SKILL.md, with every supporting and linked file. */
export function skillBundle(folder: string, source: string, extra: Partial<Pick<Authoring, 'collection' | 'tags' | 'licence'>> = {}): Authoring {
  const file = path.join(folder, 'SKILL.md');
  invariant(fs.existsSync(file) && fs.statSync(file).isFile(), 'INVALID_FILE', `No SKILL.md in ${folder}`);
  const content = fs.readFileSync(file, 'utf8');
  const files = readSkillFolder(folder); delete files['SKILL.md'];
  return authoringSchema.parse({ title: skillTitle(folder, content), kind: 'skill', content, files, source, licence: 'Unknown', collection: 'Imported skills', tags: ['imported'], ...extra });
}
/** Content identity independent of title, tags or source: the same SKILL.md and files anywhere count as the same skill. */
export const contentKey = (value: { content: string; files: Record<string, string> }) => digest({ content: value.content.replace(/\r\n/g, '\n'), files: value.files });

/** Folders where installed agents look for skills on this machine. */
export function localSkillRoots(home = os.homedir()) {
  return [...new Set([...providerIds.map(id => path.join(home, ...skillsFolder(id).split('/'))), path.join(home, '.codex', 'skills')])];
}
export type LocalSkill = { root: string; name: string; path: string; realPath: string; linked: boolean; hasSkillFile: boolean; /** True when the library already holds identical content. */ imported: boolean; fileCount: number; validation: string[]; error: string | null };
/** Every skill folder in the local agent folders, once each even when one folder is a link to another, marked when the library already has it. */
export function scanLocalSkills(wb: Workbench, roots = localSkillRoots()): { roots: string[]; entries: LocalSkill[] } {
  const known = new Set<string>();
  for (const item of wb.listItems().filter(i => i.kind === 'skill')) { try { known.add(contentKey(wb.getRevision(item.id))); } catch { /* A damaged item cannot be matched; it is reported elsewhere. */ } }
  const seen = new Set<string>(); const entries: LocalSkill[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(root, entry.name);
      let realPath = full; let error: string | null = null;
      try { realPath = fs.realpathSync(full); } catch { error = 'The link points at a folder that no longer exists.'; }
      if (!error && !fs.statSync(realPath).isDirectory()) continue;
      if (!error && seen.has(realPath.toLowerCase())) continue; seen.add(realPath.toLowerCase());
      const hasSkillFile = !error && fs.existsSync(path.join(realPath, 'SKILL.md'));
      let imported = false, fileCount = 0, validation: string[] = [];
      if (hasSkillFile) {
        try { const bundle = skillBundle(realPath, `local:${full}`); imported = known.has(contentKey(bundle)); fileCount = Object.keys(bundle.files).length + 1; validation = validateContent(bundle); }
        catch (e) { error = e instanceof Error ? e.message : String(e); }
      }
      entries.push({ root, name: entry.name, path: full, realPath, linked: entry.isSymbolicLink(), hasSkillFile, imported, fileCount, validation, error });
    }
  }
  return { roots, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
}
/** Copies the chosen local skill folders into the library as drafts. Folders stay where they are; identical content is not duplicated. */
export function importLocalSkills(wb: Workbench, input: unknown) {
  const data = z.object({ paths: z.array(z.string().min(1)).min(1).max(2000), confirm: z.literal(true) }).parse(input);
  const known = new Map<string, string>();
  for (const item of wb.listItems().filter(i => i.kind === 'skill')) { try { known.set(contentKey(wb.getRevision(item.id)), item.id); } catch { /* skip */ } }
  const imported: string[] = [], unchanged: string[] = [], failed: { path: string; error: string }[] = [];
  for (const folder of data.paths) {
    try {
      invariant(path.isAbsolute(folder), 'INVALID_PATH', 'Skill folders must be absolute paths.');
      const real = fs.realpathSync(folder);
      const bundle = skillBundle(real, `local:${folder}`);
      const key = contentKey(bundle);
      if (known.has(key)) { unchanged.push(folder); continue; }
      const item = wb.create(bundle, `local:${folder}:${key}`);
      known.set(key, item.id); imported.push(item.id);
      wb.record('imported', `Imported “${bundle.title}” from ${folder}`, item.id, item.revision);
    } catch (e) { failed.push({ path: folder, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { imported, unchanged, failed };
}
export { revisionHash };
