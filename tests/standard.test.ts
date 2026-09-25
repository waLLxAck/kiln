import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { MAX_ATTACHMENT_BYTES } from '../packages/protocol/limits';
import { Workbench } from '../packages/domain/workbench';
import { initialiseRepository, standardStatus, infrastructurePlan, applyInfrastructure } from '../packages/git/standard';
import { migrationPlan, applyMigration } from '../packages/git/migration';
import { DeploymentService } from '../packages/deployment/service';
import { bundleFiles, readJson, writeJson } from '../packages/storage/files';

test('new repositories share the versioned layout and infrastructure updates respect ownership', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln standard '));
  try {
    const result = initialiseRepository({ parent, name: 'my-skills' });
    assert.equal(standardStatus(result.root).standard, true);
    const validation = execFileSync(process.execPath, ['.kiln/validate.mjs'], { cwd: result.root, encoding: 'utf8' });
    assert.match(validation, /Validated 0 items/);
    const cloned = path.join(parent, 'fresh clone');
    execFileSync('git', ['clone', result.root, cloned], { stdio: 'pipe' });
    assert.match(execFileSync(process.execPath, ['.kiln/validate.mjs'], { cwd: cloned, encoding: 'utf8' }), /Validated 0 items/);
    assert.equal(infrastructurePlan(result.root).files.every(f => f.operation === 'unchanged'), true);
    fs.appendFileSync(path.join(result.root, '.kiln', 'validate.mjs'), '\n// local change');
    const plan = infrastructurePlan(result.root); assert.equal(plan.files.find(f => f.relative === '.kiln/validate.mjs')!.blocked, true);
    assert.throws(() => applyInfrastructure(result.root, plan.hash), /locally modified/);
    assert.match(fs.readFileSync(path.join(result.root, '.kiln', 'validate.mjs'), 'utf8'), /local change/);
    const manifest = readJson(path.join(result.root, 'kiln.json')) as Record<string, unknown>;
    writeJson(path.join(result.root, 'kiln.json'), { ...manifest, infrastructureVersion: 999 });
    assert.throws(() => infrastructurePlan(result.root), /newer infrastructure/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('migration includes complete bundles, invalid skills and licensing without executing source code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln migration '));
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln migration private '));
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
  let wb: Workbench | undefined;
  try {
    git(['init']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(root, 'mine', 'nested', 'scripts'), { recursive: true });
    const source = '---\nname: migrate-me\ndescription: Migration fixture.\n---\nRead the supporting script.';
    fs.writeFileSync(path.join(root, 'mine', 'nested', 'SKILL.md'), source);
    fs.writeFileSync(path.join(root, 'mine', 'nested', 'scripts', 'never-run.js'), 'throw new Error("must not execute")');
    fs.writeFileSync(path.join(root, 'mine', 'LICENSE'), 'MIT License\nPermission is hereby granted, free of charge');
    fs.mkdirSync(path.join(root, 'vendor', 'broken'), { recursive: true }); fs.writeFileSync(path.join(root, 'vendor', 'broken', 'SKILL.md'), 'Malformed but preserved.');
    git(['add', '.']); git(['commit', '-m', 'Legacy sources']);
    wb = new Workbench(root, privateDir); const plan = migrationPlan(root);
    assert.equal(plan.count, 2); assert.equal(plan.importable, 2);
    const first = applyMigration(wb, plan.hash); assert.equal(first.imported, 2);
    const again = applyMigration(wb, migrationPlan(root).hash); assert.equal(again.unchanged, 2); assert.equal(wb.listItems().length, 2);
    const item = wb.listItems().find(i => i.title === 'migrate-me')!;
    assert.ok(wb.getRevision(item.id).files['scripts/never-run.js']); assert.equal(wb.getRevision(item.id).files['LICENSE.upstream'], undefined); assert.equal(item.licence, 'MIT');
    assert.equal(fs.readFileSync(path.join(root, 'mine', 'nested', 'SKILL.md'), 'utf8'), source);
    assert.equal(wb.listItems().every(i => i.status === 'captured'), true);
    execFileSync(process.execPath, ['.kiln/validate.mjs'], { cwd: root, stdio: 'pipe' });
    fs.appendFileSync(path.join(wb.itemDir(item.id), 'files', 'scripts', 'never-run.js'), '\nExternal change');
    assert.throws(() => execFileSync(process.execPath, ['.kiln/validate.mjs'], { cwd: root, stdio: 'pipe' }), /Command failed/);
  } finally { wb?.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(privateDir, { recursive: true, force: true }); }
});

test('large canonical assets validate without regular-expression stack exhaustion', () => {
  const content = Buffer.alloc(8_000_000, 91).toString('base64');
  assert.doesNotThrow(() => bundleFiles({ 'assets/large.dat': content }));
  assert.throws(() => bundleFiles({ 'assets/bad': content + '!' }), /Invalid base64/);
  assert.throws(() => bundleFiles({ 'assets/oversize': Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }), /25 MB/);
});

test('uninstall removes only current owned bytes and reinstall does not inherit stale ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Kiln uninstall '));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  try {
    const targetRoot = path.join(root, 'target'); fs.mkdirSync(targetRoot);
    const target = wb.enroll({ name: 'Local', root: targetRoot, provider: 'codex', scope: 'personal', profile: 'Test' });
    const item = wb.create({ title: 'Temporary', kind: 'skill', content: '---\nname: temporary\ndescription: Test fixture.\n---\nReturn OK.' });
    wb.approve({ id: item.id, revision: item.revision, reviewer: 'Test', scope: 'Test', note: 'Test', waivedChecks: 'Fixture' });
    const service = new DeploymentService(wb); const plan = service.plan({ itemId: item.id, revision: item.revision, targetId: target.id });
    const receipt = service.apply({ planId: plan.id, expectState: null, confirm: true });
    const removed = service.uninstall({ receiptId: receipt.id, expectState: receipt.hash, confirm: true });
    assert.equal(removed.status, 'uninstalled'); assert.equal(fs.existsSync(plan.destination), false); assert.equal(wb.getItem(item.id).id, item.id);
    assert.equal(service.installations().length, 0); assert.equal(service.drift().length, 0);
    const next = service.plan({ itemId: item.id, revision: item.revision, targetId: target.id }); assert.equal(next.blocked, null);
    const installed = service.apply({ planId: next.id, expectState: null, confirm: true });
    fs.writeFileSync(path.join(next.destination, 'user-file.txt'), 'Preserve me');
    assert.throws(() => service.uninstall({ receiptId: installed.id, expectState: installed.hash, confirm: true }), /changed outside/);
    assert.equal(fs.readFileSync(path.join(next.destination, 'user-file.txt'), 'utf8'), 'Preserve me');
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
