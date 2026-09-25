import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { Workbench } from '../domain/workbench';
import { authoringSchema, type Authoring } from '../protocol/schema';
import { revisionHash, validateContent } from '../domain/content';
import { invariant } from '../domain/errors';
import { readSkillFolder } from '../domain/skills-import';
import { digest, hash, noLinks, now, readJson, safeRelative, writeJson } from '../storage/files';
import { applyInfrastructure, infrastructurePlan, standardStatus } from './standard';

export type MigrationEntry = { path: string; title: string; name: string; collection: string; hash: string; fileCount: number; bytes: number; validation: string[]; error: string | null };
type MigrationManifest = { schemaVersion: 1; sourceCommit: string; migratedAt: string; entries: { path: string; itemId: string; revision: string; sourceHash: string }[] };
function sourceBundle(root: string, relative: string): Authoring {
  safeRelative(relative); const file = path.join(root, relative); noLinks(file);
  const content = fs.readFileSync(file, 'utf8');
  // Follows links so a skill that keeps shared files elsewhere in the repository arrives complete.
  const files = readSkillFolder(path.dirname(file)); delete files['SKILL.md'];
  // The nearest licence is recorded as metadata only. Copying its text into every skill folder would add a file the
  // agent never reads and make every installed copy read as "different version" from the library.
  let ancestor = path.dirname(file), licence = 'Unknown';
  while (ancestor.startsWith(root)) {
    const name = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'].find(name => fs.existsSync(path.join(ancestor, name)) && fs.statSync(path.join(ancestor, name)).isFile());
    if (name) {
      const text = fs.readFileSync(path.join(ancestor, name), 'utf8');
      licence = /MIT License|Permission is hereby granted, free of charge/.test(text) ? 'MIT' : /Apache License/.test(text) ? 'Apache-2.0' : `See ${path.relative(root, path.join(ancestor, name)).replace(/\\/g, '/')}`;
      break;
    }
    if (ancestor === root) break; ancestor = path.dirname(ancestor);
  }
  let name = path.basename(path.dirname(file));
  try { const meta = parse(content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''); if (typeof meta?.name === 'string') name = meta.name; } catch { /* Invalid metadata still belongs in the visible catalog. */ }
  const collection = collectionFor(relative);
  return authoringSchema.parse({ title: name, kind: 'skill', content, files, source: `repository:${relative}`, licence, collection, tags: [relative.startsWith('mine/') ? 'authored' : 'imported'] });
}
const titleCase = (folder: string) => folder.split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
/** `mine/<org>/<skill>/SKILL.md` goes to "My skills · <Org>", other `mine/` skills to "My skills", `vendor/<x>/…` to "Vendor · <x>". */
function collectionFor(relative: string) {
  const parts = relative.split('/');
  if (parts[0] === 'mine') return parts.length >= 4 ? `My skills · ${titleCase(parts[1])}` : 'My skills';
  if (parts[0] === 'vendor') return `Vendor · ${parts[1]}`;
  return 'Imported skills';
}
/** SKILL.md files in a source: tracked files when it is a Git repository, otherwise a bounded walk of the folder. */
function skillFiles(source: string) {
  try { return execFileSync('git', ['-C', source, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(file => /(^|\/)SKILL\.md$/.test(file) && !file.startsWith('workbench/')); }
  catch {
    const found: string[] = [];
    const walk = (folder: string, prefix: string, depth: number) => {
      if (depth > 8 || found.length >= 5000) return;
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ['.git', 'node_modules', 'workbench'].includes(entry.name)) continue;
        if (entry.isDirectory()) walk(path.join(folder, entry.name), `${prefix}${entry.name}/`, depth + 1);
        else if (entry.name === 'SKILL.md') found.push(`${prefix}SKILL.md`);
      }
    };
    walk(source, '', 0); return found;
  }
}
function sourceCommit(source: string) { try { return execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'working-tree'; } }
/** Entries are keyed by source folder and relative path, so the same skill imported from two places stays two items. Paths inside the library itself keep their historical bare key. */
const entryKey = (root: string, source: string, relative: string) => path.resolve(source) === path.resolve(root) ? relative : `${path.resolve(source)}::${relative}`;
/**
 * Previews importing every SKILL.md from `source` (another repository or plain folder; defaults to the library itself for
 * libraries that grew up around a legacy skills tree). Nothing is written.
 */
export function migrationPlan(root: string, source = root) {
  noLinks(root); invariant(path.isAbsolute(root), 'INVALID_PATH', 'Repository root must be absolute.');
  noLinks(source); invariant(path.isAbsolute(source) && fs.existsSync(source) && fs.statSync(source).isDirectory(), 'INVALID_PATH', 'Choose an existing folder to import skills from.');
  const paths = skillFiles(source);
  const commit = sourceCommit(source);
  const entries: MigrationEntry[] = paths.map(relative => {
    try {
      const bundle = sourceBundle(source, relative);
      return { path: relative, title: bundle.title, name: bundle.title, collection: bundle.collection, hash: revisionHash(bundle), fileCount: Object.keys(bundle.files).length + 1, bytes: Buffer.byteLength(bundle.content) + Object.values(bundle.files).reduce((total, value) => total + Buffer.byteLength(value, 'base64'), 0), validation: validateContent(bundle), error: null };
    } catch (error) { return { path: relative, title: path.basename(path.dirname(relative)), name: '', collection: 'Imported skills', hash: '', fileCount: 0, bytes: 0, validation: [], error: error instanceof Error ? error.message : String(error) }; }
  });
  const manifestFile = path.join(root, '.kiln', 'migration.json');
  const previous = fs.existsSync(manifestFile) ? readJson(manifestFile) as MigrationManifest : { entries: [] };
  let unchanged = 0, conflicts = 0;
  for (const entry of entries) {
    const prior = previous.entries.find(p => p.path === entryKey(root, source, entry.path));
    if (prior?.sourceHash === entry.hash) unchanged++;
    else if (prior) { const itemFile = path.join(root, 'workbench', 'items', prior.itemId, 'item.json'); if (fs.existsSync(itemFile) && (readJson(itemFile) as { revision: string }).revision !== prior.revision) conflicts++; }
  }
  return { root, source, commit, entries, unchanged, conflicts, pending: entries.filter(e => !e.error).length - unchanged - conflicts, count: entries.length, importable: entries.filter(e => !e.error).length, totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0), hash: digest({ source: path.resolve(source), commit, entries }), infrastructure: infrastructurePlan(root) };
}
export function applyMigration(wb: Workbench, expected: string, source = wb.root) {
  const plan = migrationPlan(wb.root, source); invariant(plan.hash === expected, 'MIGRATION_CHANGED', 'The source changed. Refresh the import preview.');
  invariant(plan.importable === plan.count, 'MIGRATION_REVIEW_REQUIRED', 'Some skill bundles need attention before import. No skills were silently skipped.');
  applyInfrastructure(wb.root, plan.infrastructure.hash);
  const manifestPath = path.join(wb.root, '.kiln', 'migration.json');
  const prior = fs.existsSync(manifestPath) ? readJson(manifestPath) as MigrationManifest : { entries: [] };
  const entries: MigrationManifest['entries'] = [...prior.entries];
  let imported = 0, updated = 0, unchanged = 0; const conflicts: string[] = [];
  for (const entry of plan.entries) {
    const key = entryKey(wb.root, source, entry.path);
    const existing = entries.find(e => e.path === key), bundle = sourceBundle(source, entry.path);
    if (path.resolve(source) !== path.resolve(wb.root)) bundle.source = `${path.resolve(source)}:${entry.path}`;
    if (existing) {
      if (existing.sourceHash === entry.hash) { unchanged++; continue; }
      const item = wb.getItem(existing.itemId);
      if (item.revision !== existing.revision) { conflicts.push(entry.path); continue; }
      const changed = wb.update({ id: item.id, expect: item.revision, value: bundle, summary: `Imported source update at ${plan.commit.slice(0, 8)}` });
      existing.revision = changed.revision; existing.sourceHash = entry.hash; updated++;
    } else {
      const item = wb.create(bundle, `migration:${key}:${entry.hash}`);
      entries.push({ path: key, itemId: item.id, revision: item.revision, sourceHash: entry.hash }); imported++;
    }
    // A durable map makes interrupted bulk migration repeatable.
    writeJson(manifestPath, { schemaVersion: 1, sourceCommit: plan.commit, migratedAt: now(), entries });
  }
  const result = { imported, updated, unchanged, conflicts, total: entries.length, sourceCommit: plan.commit, completedAt: now() };
  writeJson(path.join(wb.root, '.kiln', 'migration-result.json'), result); wb.refresh(); return result;
}
