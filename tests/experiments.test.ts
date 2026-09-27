import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workbench } from '../packages/domain/workbench';

/** 0.22.0 kept ten features behind switches in a machine-private `experiments` map; they are permanent now. */
function workbench() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-experiments-'));
  return { root, wb: new Workbench(path.join(root, 'library'), path.join(root, 'private')) };
}
test('a 0.22.0 settings file with experiment switches still opens, and the switches are ignored', () => {
  const { root, wb } = workbench();
  try {
    fs.mkdirSync(wb.local, { recursive: true });
    fs.writeFileSync(path.join(wb.local, 'settings.json'), JSON.stringify({ theme: 'dark', experiments: { codeEditor: true, autoSync: false, graduatedLongAgo: true } }));
    assert.equal(wb.settings().theme, 'dark');
    assert.equal('experiments' in wb.settings(), false);
    fs.writeFileSync(path.join(wb.local, 'settings.json'), JSON.stringify({ experiments: 'yes please' }));
    assert.equal(wb.settings().theme, 'light');
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('saving preferences drops the old experiments map from the file', () => {
  const { root, wb } = workbench();
  try {
    fs.mkdirSync(wb.local, { recursive: true });
    fs.writeFileSync(path.join(wb.local, 'settings.json'), JSON.stringify({ experiments: { autoSync: true } }));
    wb.saveSettings({ ...wb.settings(), theme: 'dark', experiments: { autoSync: true } });
    const saved = JSON.parse(fs.readFileSync(path.join(wb.local, 'settings.json'), 'utf8'));
    assert.equal(saved.theme, 'dark');
    assert.equal('experiments' in saved, false);
  } finally { wb.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
