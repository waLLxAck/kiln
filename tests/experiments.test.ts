import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../packages/domain/workbench';
import { environmentExperiments, experimentIds, experimentOn, experiments } from '../packages/protocol/experiments';

function workbench() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-experiments-'));
  return { root, wb: new Workbench(path.join(root, 'library'), path.join(root, 'private')) };
}
test('every experiment has an id, a title and a description, and ids are unique', () => {
  assert.equal(new Set(experimentIds).size, experiments.length);
  for (const e of experiments) { assert.match(e.id, /^[a-z][A-Za-z]+$/); assert.ok(e.title.length > 3); assert.ok(e.description.length > 20); }
});
/** Runs `check` without a KILN_EXPERIMENTS inherited from the shell, which would turn flags on for this process. */
function withoutEnvironment(check: () => void) {
  const previous = process.env.KILN_EXPERIMENTS; delete process.env.KILN_EXPERIMENTS;
  try { check(); } finally { if (previous === undefined) delete process.env.KILN_EXPERIMENTS; else process.env.KILN_EXPERIMENTS = previous; }
}
test('experiments are off by default and switch on and off one at a time', () => withoutEnvironment(() => {
  const { root, wb } = workbench();
  try {
    assert.deepEqual(wb.settings().experiments, {});
    for (const id of experimentIds) assert.equal(experimentOn(wb.settings(), id), false);
    assert.equal(experimentOn(wb.setExperiment({ id: 'installUpdates', enabled: true }), 'installUpdates'), true);
    assert.equal(experimentOn(wb.settings(), 'codeEditor'), false, 'turning one on leaves the others off');
    wb.setExperiment({ id: 'installUpdates', enabled: false });
    assert.equal(experimentOn(wb.settings(), 'installUpdates'), false);
    assert.throws(() => wb.setExperiment({ id: 'notAFlag', enabled: true }));
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
}));
test('saving preferences keeps the experiments chosen in Settings', () => {
  const { root, wb } = workbench();
  try {
    wb.setExperiment({ id: 'autoSync', enabled: true });
    wb.saveSettings({ ...wb.settings(), theme: 'dark', experiments: {} });
    assert.equal(wb.settings().theme, 'dark');
    assert.equal(experimentOn(wb.settings(), 'autoSync'), true);
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('a settings file naming a removed or broken flag still opens', () => withoutEnvironment(() => {
  const { root, wb } = workbench();
  try {
    fs.mkdirSync(wb.local, { recursive: true });
    fs.writeFileSync(path.join(wb.local, 'settings.json'), JSON.stringify({ experiments: { graduatedLongAgo: true, codeEditor: true } }));
    assert.equal(experimentOn(wb.settings(), 'codeEditor'), true);
    fs.writeFileSync(path.join(wb.local, 'settings.json'), JSON.stringify({ experiments: 'yes please' }));
    assert.deepEqual(wb.settings().experiments, {});
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
}));
test('KILN_EXPERIMENTS turns flags on for the process without writing them to settings', () => {
  assert.deepEqual(environmentExperiments(''), {});
  assert.deepEqual(environmentExperiments('codeEditor, nope ,autoSync'), { codeEditor: true, autoSync: true });
  assert.equal(Object.keys(environmentExperiments('all')).length, experiments.length);
  const { root, wb } = workbench();
  const previous = process.env.KILN_EXPERIMENTS;
  try {
    process.env.KILN_EXPERIMENTS = 'betterSearch';
    assert.equal(experimentOn(wb.settings(), 'betterSearch'), true);
    wb.saveSettings(wb.settings());
    delete process.env.KILN_EXPERIMENTS;
    assert.equal(experimentOn(wb.settings(), 'betterSearch'), false, 'the environment flag was not saved');
  } finally { if (previous === undefined) delete process.env.KILN_EXPERIMENTS; else process.env.KILN_EXPERIMENTS = previous; wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
