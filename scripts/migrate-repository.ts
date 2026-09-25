import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService } from '../packages/deployment/service';
import { migrationPlan, applyMigration } from '../packages/git/migration';
import { privateRoot, selectLibrary } from '../packages/storage/config';
import { digest, hash, writeJson } from '../packages/storage/files';

const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the repository to migrate.');
const evidence = path.resolve('artifacts/skills-migration'); fs.mkdirSync(evidence, { recursive: true });
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean).filter(p => !p.startsWith('workbench/') && !p.startsWith('.kiln/') && !['kiln.json', 'KILN.md', '.github/workflows/kiln.yml'].includes(p));
const originals = () => Object.fromEntries(tracked.map(relative => [relative, hash(fs.readFileSync(path.join(root, relative)))]));
export function installedSnapshot() {
  const records: Record<string, string> = {};
  for (const directory of ['.agents/skills', '.claude/skills', '.codex/skills']) {
    const base = path.join(os.homedir(), directory);
    const walk = (at: string, relative: string, ancestors: Set<string>) => {
      const real = fs.realpathSync(at); if (ancestors.has(real)) throw new Error(`Cyclic skill link: ${at}`);
      const next = new Set(ancestors).add(real);
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const file = path.join(at, entry.name), key = `${directory}/${relative ? `${relative}/` : ''}${entry.name}`;
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) records[`${key}:link`] = fs.readlinkSync(file);
        if (fs.statSync(file).isDirectory()) walk(file, relative ? `${relative}/${entry.name}` : entry.name, next);
        else records[key] = hash(fs.readFileSync(file));
      }
    };
    if (fs.existsSync(base)) walk(base, '', new Set());
  }
  return records;
}
const before = { sourceFiles: originals(), installed: installedSnapshot() };
writeJson(path.join(evidence, 'before.json'), before);
const wb = new Workbench(root, privateRoot());
try {
  const plan = migrationPlan(root); writeJson(path.join(evidence, 'plan.json'), plan);
  const result = applyMigration(wb, plan.hash);
  const home = os.homedir();
  wb.enroll({ name: 'Personal Codex', root: home, provider: 'codex', scope: 'personal', profile: 'Personal' });
  wb.enroll({ name: 'Personal Claude Code', root: home, provider: 'claude', scope: 'personal', profile: 'Personal' });
  selectLibrary(root);
  const after = { sourceFiles: originals(), installed: installedSnapshot() };
  if (digest(before) !== digest(after)) throw new Error('Preservation check failed: original files or existing installations changed.');
  execFileSync(process.execPath, [path.join(root, '.kiln', 'validate.mjs')], { cwd: root, stdio: 'inherit' });
  const installations = new DeploymentService(wb).installations();
  const report = { ...result, sourceFilesPreserved: tracked.length, existingInstallationEntriesPreserved: Object.keys(before.installed).length, catalogItems: wb.listItems().length, validationWarnings: plan.entries.filter(e => e.validation.length).length, installationMatches: installations.length, existingDestinations: new Set(installations.map(i => i.destination)).size, privateDataRoot: wb.local };
  writeJson(path.join(evidence, 'result.json'), report); console.log(JSON.stringify(report, null, 2));
} finally { wb.close(); }
