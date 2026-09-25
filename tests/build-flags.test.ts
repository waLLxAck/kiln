import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopDefines, desktopFlags } from '../apps/desktop/build-flags';

test('Machines is shown in development and local builds, and coming soon in public builds unless asked for', () => {
  assert.equal(desktopFlags({}).machines, true, 'npm run dev, npm run build and the desktop tests');
  assert.equal(desktopFlags({ KILN_PUBLIC_BUILD: '1' }).machines, false, 'release.yml builds');
  assert.equal(desktopFlags({ KILN_PUBLIC_BUILD: '1', KILN_SHOW_MACHINES: '1' }).machines, true, 'overridden to test it in a public build');
  assert.equal(desktopFlags({ KILN_SHOW_MACHINES: '0' }).machines, false, 'the public page can be tried in a local build');
  assert.equal(desktopFlags({ KILN_PUBLIC_BUILD: '0' }).machines, true);
  assert.deepEqual(desktopDefines({ KILN_PUBLIC_BUILD: '1' }), { __KILN_SHOW_MACHINES__: 'false' });
  assert.deepEqual(desktopDefines({}), { __KILN_SHOW_MACHINES__: 'true' });
});
