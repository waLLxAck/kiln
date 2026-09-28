/**
 * Another machine for the fleet spec: a clone of the same "GitHub" with its own private data, driven through Kiln's router.
 * Run with tsx in its own process: Playwright's loader cannot load the router's dependencies (jsonc-parser's ESM build).
 *
 *   tsx tests/desktop/second-machine.ts <library> <private> <home> setup|sync
 */
import { Workbench } from '../../packages/domain/workbench';
import { Router } from '../../packages/domain/router';

const [library, local, home, step] = process.argv.slice(2);
const wb = new Workbench(library, local), router = new Router(wb, { composer: null });
try {
  if (step === 'setup') {
    router.call('fleet.rename', { name: 'studio-pc' });
    wb.enroll({ name: 'Agents', root: home, provider: 'codex', scope: 'personal', profile: 'Personal' });
    await router.fleet.idle();
    console.log(JSON.stringify({ id: router.fleet.identity().id }));
  } else {
    const synced = await router.call('skills.sync');
    console.log(JSON.stringify(synced));
  }
} finally { router.fleet.stop(); wb.close(); }
process.exit(0);
