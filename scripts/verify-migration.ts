import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, readJson, writeJson } from '../packages/storage/files';

const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the migrated repository path.');
const evidence = path.resolve('artifacts/skills-migration');
const baseline = readJson(path.join(evidence, 'before.json')) as { sourceFiles: Record<string, string>; installed: Record<string, string> };
const live = readJson(path.join(evidence, 'live-install-result.json')) as { destinations: string[] };
const changed: string[] = [];
for (const [relative, expected] of Object.entries(baseline.sourceFiles)) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected) changed.push(relative);
}
for (const [relative, expected] of Object.entries(baseline.installed)) {
  const linked = relative.endsWith(':link');
  const file = path.join(os.homedir(), linked ? relative.slice(0, -5) : relative);
  if (!fs.existsSync(file) || (linked ? fs.readlinkSync(file) : hash(fs.readFileSync(file))) !== expected) changed.push(relative);
}
for (const file of live.destinations) if (fs.existsSync(file)) changed.push(`Disposable installation remains: ${file}`);
if (changed.length) throw new Error(`Preservation check failed: ${changed.join(', ')}`);
const validation = execFileSync(process.execPath, ['.kiln/validate.mjs'], { cwd: root, encoding: 'utf8' }).trim();
const report = { verifiedAt: new Date().toISOString(), sourceFilesUnchanged: Object.keys(baseline.sourceFiles).length, installedEntriesUnchanged: Object.keys(baseline.installed).length, disposableDestinationsAbsent: live.destinations.length, validation };
writeJson(path.join(evidence, 'final-preservation.json'), report);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
