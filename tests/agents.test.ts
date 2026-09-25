import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workbench } from '../packages/domain/workbench';
import { DeploymentService } from '../packages/deployment/service';
import { scanAgents, importAgents } from '../packages/domain/agents-import';
import { configCatalog } from '../packages/home/catalog';
import { revisionHash } from '../packages/domain/content';

test('the Settings scanner finds agents without a skills folder and omits imported definitions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-settings-agents-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  try {
    const home = path.join(root, 'home'), folder = path.join(home, '.copilot/agents');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'reviewer.md');
    fs.writeFileSync(file, '---\nname: reviewer\ndescription: Review code\n---\nReview carefully.');
    const target = wb.enroll({ name: 'Copilot', provider: 'copilot', root: home, scope: 'personal' });
    const deployment = new DeploymentService(wb);
    assert.equal(deployment.scan(target.id).entries[0].kind, 'agent');
    importAgents(wb, { files: [{ path: file, provider: 'copilot' }], confirm: true });
    assert.equal(deployment.scan(target.id).entries.length, 0);
    const skill = path.join(home, '.copilot/skills/reviewer'); fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: reviewer\ndescription: Review code\n---\nReview.');
    assert.equal(deployment.scan(target.id).entries[0].kind, 'skill');
    assert.equal(fs.existsSync(file), true);
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('agents import as drafts, retain native content, install for their own client and protect edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-agents-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const deployment = new DeploymentService(wb);
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  try {
    for (const provider of ['copilot', 'claude', 'codex'] as const) {
      const source = path.join(root, `source-${provider}`); fs.mkdirSync(source);
      const filename = provider === 'codex' ? 'reviewer.toml' : 'reviewer.md';
      const file = path.join(source, filename);
      const content = provider === 'codex' ? 'name = "reviewer"\ndescription = "Review code"\ndeveloper_instructions = "Read the diff"\nmodel = "example-model"\n' : '---\nname: reviewer\ndescription: Review code\ntools: Read\n---\nRead the diff.\n';
      fs.writeFileSync(file, content);
      assert.equal(scanAgents(wb, { root: source, provider }).length, 1);
      const result = importAgents(wb, { files: [{ path: file, provider }], confirm: true });
      assert.equal(result.failed.length, 0);
      const id = result.imported[0], item = wb.getItem(id), revision = wb.getRevision(id);
      assert.equal(item.kind, 'agent'); assert.equal(item.status, 'captured');
      assert.equal(revision.content, content); assert.equal(item.agent?.provider, provider);
      assert.equal(scanAgents(wb, { root: source, provider })[0].imported, true);
      assert.equal(importAgents(wb, { files: [{ path: file, provider }], confirm: true }).imported.length, 0);
      assert.notEqual(revisionHash(revision), revisionHash({ ...revision, agent: { provider, filename: 'different.md' } }));
      const target = wb.enroll({ name: provider, provider, root: home, scope: 'personal' });
      const installed = deployment.installSkill({ itemId: id, targetId: target.id, confirm: true });
      assert.equal(installed.destination, path.join(home, `.${provider}/agents`, filename));
      assert.equal(fs.readFileSync(installed.destination, 'utf8'), content);
      assert.equal(deployment.installations(id)[0].matches, true);
      assert.equal(deployment.compare({ itemId: id, targetId: target.id }).files[0].status, 'same');
      const project = wb.enroll({ name: 'project', provider, root: home, scope: 'project' });
      const projectInstall = deployment.installSkill({ itemId: id, targetId: project.id, confirm: true });
      assert.equal(projectInstall.destination, path.join(home, provider === 'copilot' ? '.github' : `.${provider}`, 'agents', filename));
      const wrong = wb.enroll({ name: 'wrong', provider: provider === 'claude' ? 'copilot' : 'claude', root: home, scope: 'project' });
      assert.throws(() => deployment.installSkill({ itemId: id, targetId: wrong.id, confirm: true }), /client/);
      fs.appendFileSync(installed.destination, '\nLocal edits');
      assert.throws(() => deployment.removeSkill({ itemId: id, targetId: target.id, confirm: true }), /differs/);
      fs.writeFileSync(installed.destination, content);
      deployment.removeSkill({ itemId: id, targetId: target.id, confirm: true });
      assert.equal(fs.existsSync(installed.destination), false);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
      assert.equal(wb.getItem(id).kind, 'agent');
    }
    const invalid = wb.create({ kind: 'agent', title: 'Needs repair', content: 'invalid', agent: { provider: 'codex', filename: 'repair.toml' } });
    assert.equal(deployment.installations(invalid.id).length, 0);
    assert.ok(wb.detail(invalid.id).validation.length);
    const agents = path.join(home, '.copilot', 'agents'); fs.mkdirSync(agents, { recursive: true }); fs.writeFileSync(path.join(agents, 'example.md'), 'example');
    assert.equal(configCatalog(home, [], {}).some(e => e.path.includes(`${path.sep}agents${path.sep}`)), false);
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('agent discovery includes configured personal homes and projects once each', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-agent-discovery-'));
  const wb = new Workbench(path.join(root, 'library'), path.join(root, 'private'));
  const previousHome = process.env.KILN_HOME; process.env.KILN_HOME = path.join(root, 'empty-home');
  try {
    const home = path.join(root, 'custom'), project = path.join(root, 'project');
    for (const [base, folder] of [[home, '.claude/agents'], [project, '.github/agents']]) {
      fs.mkdirSync(path.join(base, folder), { recursive: true });
      fs.writeFileSync(path.join(base, folder, 'review.md'), '---\nname: review\ndescription: Review code\n---\nReview.');
    }
    wb.enroll({ name: 'Claude', root: home, provider: 'claude', scope: 'personal' });
    wb.enroll({ name: 'Copilot project', root: project, provider: 'copilot', scope: 'project' });
    const entries = scanAgents(wb, {});
    assert.deepEqual(entries.map(e => e.provider).sort(), ['claude', 'copilot']);
  } finally { if (previousHome === undefined) delete process.env.KILN_HOME; else process.env.KILN_HOME = previousHome; wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
