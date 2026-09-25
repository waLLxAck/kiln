import fs from 'node:fs';
import { revisionIdentity } from '../protocol/revision';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { Workbench } from '../domain/workbench';
import { invariant } from '../domain/errors';
import { atomicWrite, digest, hash, noLinks, now, readJson, withLock, writeJson } from '../storage/files';
import { privateRoot } from '../storage/config';
import { gitStatus, isDedicated } from './service';

export const FORMAT_VERSION = 1;
export const INFRASTRUCTURE_VERSION = 2;
export const repositorySchema = z.object({ format: z.literal('kiln-library'), schemaVersion: z.literal(1), infrastructureVersion: z.number().int().positive(), repositoryId: z.string().uuid(), library: z.literal('workbench'), /** True for repositories Kiln created to be nothing but a library. Absent on repositories that adopted the layout in place. */ dedicated: z.boolean().optional() });

const validator = `import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b,'en')).map(([k,v]) => JSON.stringify(k)+':'+stable(v)).join(',') + '}' : JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const fail = message => { throw new Error(message); };
const validPath = name => typeof name === 'string' && name.length > 0 && !/[\\\\:*?"<>|\\x00-\\x1f]/.test(name) && !name.startsWith('/') && name.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p));
const identity = ${revisionIdentity.toString()};
const bundleHash = r => digest(identity(r, r.hashVersion ?? 1));
const readAssets = dir => {
  const result = {};
  const walk = (folder, prefix = '') => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('Linked assets are not portable');
      const relative = prefix + entry.name, file = path.join(folder, entry.name);
      if (!validPath(relative)) fail('Unsafe working asset path');
      if (entry.isDirectory()) walk(file, relative + '/');
      else if (entry.isFile()) result[relative] = fs.readFileSync(file).toString('base64');
      else fail('Unsupported asset type');
    }
  };
  if (fs.existsSync(dir)) { if (fs.lstatSync(dir).isSymbolicLink()) fail('Linked asset root'); walk(dir); }
  return result;
};
try {
  const manifest = read(path.join(root, 'kiln.json'));
  if (manifest.format !== 'kiln-library' || manifest.schemaVersion !== 1 || manifest.library !== 'workbench') fail('Unsupported repository format');
  const library = path.join(root, 'workbench'); let count = 0, revisions = 0;
  const itemsDirectory = path.join(library, 'items');
  for (const entry of fs.existsSync(itemsDirectory) ? fs.readdirSync(itemsDirectory, { withFileTypes:true }) : []) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail('Invalid item directory');
    if (!/^[a-f0-9-]{36}$/.test(entry.name)) fail('Invalid item ID');
    const dir = path.join(library, 'items', entry.name), item = read(path.join(dir, 'item.json'));
    if (item.id !== entry.name || !/^[a-f0-9]{64}$/.test(item.revision)) fail('Invalid item record');
    for (const file of fs.readdirSync(path.join(dir, 'revisions'))) {
      if (!/^[a-f0-9]{64}\\.json$/.test(file)) fail('Unexpected revision file');
      const r = read(path.join(dir, 'revisions', file));
      if (r.itemId !== item.id || r.hash !== file.slice(0,-5) || bundleHash(r) !== r.hash) fail('Revision integrity failure: ' + item.title);
      const names = Object.keys(r.files), folded = names.map(n => n.toLowerCase());
      if (names.some(n => !validPath(n)) || new Set(folded).size !== names.length) fail('Unsafe bundle paths');
      revisions++;
    }
    const current = read(path.join(dir, 'revisions', item.revision + '.json'));
    if (fs.readFileSync(path.join(dir,'content.md'),'utf8') !== current.content) fail('External edit needs reconciliation in Kiln: ' + item.title);
    if (digest(readAssets(path.join(dir,'files'))) !== digest(current.files)) fail('External asset edit needs reconciliation in Kiln: ' + item.title);
    count++;
  }
  console.log('Validated ' + count + ' items and ' + revisions + ' immutable revisions. Skill content was not executed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
`;
const workflow = `name: Validate Kiln library
on:
  push:
    paths: ['kiln.json', 'workbench/**', '.kiln/**', '.github/workflows/kiln.yml']
  pull_request:
    paths: ['kiln.json', 'workbench/**', '.kiln/**', '.github/workflows/kiln.yml']
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: '24'
      - run: node .kiln/validate.mjs
`;
const guide = `# Kiln library

This repository uses the standard Kiln format. Open it in Kiln to capture, test,
approve, install, uninstall, and sync resources with GitHub.

- \`kiln.json\`: repository identity and supported format version.
- \`workbench/items/<id>/item.json\`: stable identity and current revision.
- \`workbench/items/<id>/content.md\` and \`files/\`: editable content and supporting files.
- \`workbench/items/<id>/revisions/<hash>.json\`: complete immutable snapshots.
- \`workbench/approvals/\`, \`experiments/\`, \`activity/\`: provenance and decisions.
- \`.kiln/\`: app-managed infrastructure, integrity checks, and migration records.

Kiln ships versioned infrastructure updates for this fixed layout. Update previews
check ownership hashes; locally modified infrastructure is never silently replaced.
Machine paths, credentials, raw transcripts, deployment receipts, and search indexes
remain outside the repository. GitHub Actions validates data without running skills.

Imported skills begin unapproved. Existing installations remain externally managed.
Kiln cannot uninstall external copies or junctions. Approval belongs to exact bytes. Install copies an
approved snapshot; uninstall removes only a matching Kiln-owned snapshot. Editing a
skill cannot change an installed version until you approve and install that revision.

Legacy source directories, if present, are retained as migration sources for rollback
and provenance. Kiln authors only the standard workbench tree. Existing legacy paths
are not rewritten or removed during migration, so linked installations keep working.
Re-import an upstream source update as a new draft; review it before installing.

Run \`node .kiln/validate.mjs\` to verify repository integrity locally.
`;
export const infrastructureFiles: Record<string, string> = { '.kiln/validate.mjs': validator, '.github/workflows/kiln.yml': workflow, 'KILN.md': guide };

export function standardStatus(root: string) {
  const file = path.join(root, 'kiln.json');
  if (!fs.existsSync(file)) return { standard: false, schemaVersion: null, infrastructureVersion: null, current: false };
  const manifest = repositorySchema.parse(readJson(file));
  return { standard: true, ...manifest, current: manifest.infrastructureVersion === INFRASTRUCTURE_VERSION };
}
export function infrastructurePlan(root: string) {
  const status = standardStatus(root);
  invariant(!status.standard || status.infrastructureVersion! <= INFRASTRUCTURE_VERSION, 'NEWER_INFRASTRUCTURE', 'This repository uses newer infrastructure. Update Kiln before changing it.');
  noLinks(root); const ownerFile = path.join(root, '.kiln', 'infrastructure.json');
  const owners = fs.existsSync(ownerFile) ? (readJson(ownerFile) as { files: Record<string, string> }).files : {};
  const files = Object.entries(infrastructureFiles).map(([relative, content]) => {
    const file = path.join(root, relative); noLinks(file);
    const current = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
    return { relative, current, proposed: hash(content), operation: current === hash(content) ? 'unchanged' : current ? 'update' : 'create', blocked: Boolean(current && current !== hash(content) && owners[relative] !== current) };
  });
  return { version: INFRASTRUCTURE_VERSION, root, files, hash: digest(files) };
}
export function applyInfrastructure(root: string, expected: string) {
  return withLock(path.join(root, 'workbench'), () => {
    const plan = infrastructurePlan(root);
    invariant(plan.hash === expected, 'INFRASTRUCTURE_CHANGED', 'Infrastructure changed after the preview.');
    invariant(!plan.files.some(f => f.blocked), 'INFRASTRUCTURE_UNMANAGED', 'A destination contains locally modified or unmanaged infrastructure. Review it before upgrading.');
    for (const file of plan.files) if (file.operation !== 'unchanged') atomicWrite(path.join(root, file.relative), infrastructureFiles[file.relative]);
    writeJson(path.join(root, '.kiln', 'infrastructure.json'), { version: INFRASTRUCTURE_VERSION, files: Object.fromEntries(plan.files.map(f => [f.relative, f.proposed])) });
    const marker = path.join(root, 'kiln.json');
    const old = fs.existsSync(marker) ? repositorySchema.parse(readJson(marker)) : { format: 'kiln-library', schemaVersion: 1, repositoryId: randomUUID(), library: 'workbench' };
    writeJson(marker, { ...old, infrastructureVersion: INFRASTRUCTURE_VERSION });
    return standardStatus(root);
  });
}
const folderInput = z.object({ parent: z.string().min(1), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/) });
/** Where new repositories go unless the user picks somewhere else. */
export const defaultParent = () => path.join(os.homedir(), 'Kiln');
/** What is at `<parent>/<name>` before creating there: nothing, a Kiln repository that can be reused, or something else. */
export function inspectRepositoryFolder(input: unknown) {
  const data = folderInput.parse(input);
  const root = path.join(data.parent, data.name);
  if (!fs.existsSync(root)) return { root, exists: false, kiln: false, git: false, remote: '', items: 0 };
  const state = gitStatus(root);
  const kiln = fs.existsSync(path.join(root, 'kiln.json')) && isDedicated(root);
  const itemsDir = path.join(root, 'workbench', 'items');
  return { root, exists: true, kiln, git: state.attached, remote: state.remote, items: fs.existsSync(itemsDir) ? fs.readdirSync(itemsDir).length : 0 };
}
export function initialiseRepository(input: unknown) {
  const data = folderInput.parse(input);
  invariant(path.isAbsolute(data.parent), 'INVALID_PATH', 'Choose a parent folder.'); fs.mkdirSync(data.parent, { recursive: true });
  noLinks(data.parent); invariant(fs.statSync(data.parent).isDirectory(), 'INVALID_PATH', 'Choose an existing parent folder.');
  const root = path.join(data.parent, data.name);
  if (fs.existsSync(root)) {
    // A folder prepared by an earlier attempt that never reached GitHub is picked up again instead of blocking on a name.
    const state = gitStatus(root);
    const empty = !fs.existsSync(path.join(root, 'workbench', 'items')) || fs.readdirSync(path.join(root, 'workbench', 'items')).length === 0;
    invariant(fs.existsSync(path.join(root, 'kiln.json')) && isDedicated(root) && state.attached && !state.remote && empty, 'FOLDER_EXISTS', 'That folder already exists and is not an empty Kiln repository waiting to be published. Choose another name.');
    return { root, committed: Boolean(state.commit), message: state.commit ? 'Reusing the Kiln repository prepared earlier.' : 'Repository folder exists but has no commit. Configure your Git name/email, then try again.' };
  }
  fs.mkdirSync(root); const wb = new Workbench(root, privateRoot());
  try { applyInfrastructure(root, infrastructurePlan(root).hash); }
  finally { wb.close(); }
  const marker = path.join(root, 'kiln.json'); writeJson(marker, { ...repositorySchema.parse(readJson(marker)), dedicated: true });
  execFileSync('git', ['-c', 'core.hooksPath=', 'init', '--initial-branch=main', root], { windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'add', '--', 'kiln.json', 'KILN.md', '.kiln', '.github/workflows/kiln.yml', 'workbench'], { windowsHide: true, stdio: 'pipe' });
  try { execFileSync('git', ['-c', 'core.hooksPath=', '-C', root, 'commit', '-m', 'Create standard Kiln library'], { windowsHide: true, stdio: 'pipe' }); }
  catch { return { root, committed: false, message: 'Repository created. Configure your Git name/email, then create the initial checkpoint before publishing.' }; }
  return { root, committed: true, message: 'Standard Kiln repository created.' };
}
