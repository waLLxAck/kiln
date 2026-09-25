import { parentPort, workerData } from 'node:worker_threads';
import { AgentService } from '../../packages/agent/service';
import { Workbench } from '../../packages/domain/workbench';
import { Router } from '../../packages/domain/router';
import { WorkbenchError } from '../../packages/domain/errors';
import { z } from 'zod';
const log = (event: string, fields?: Record<string, unknown>) => parentPort!.postMessage({ telemetry: { event, fields } });
// Ordinary desktop actions are programmatic. Only explicit agent actions invoke a provider.
const routerOptions = { log, composer: null };
let wb = new Workbench(workerData.root, workerData.local);
let router = new Router(wb, routerOptions);
const newAgentService = (workbench: Workbench) => new AgentService(workbench, log, undefined, undefined, undefined, workerData.cli);
let agent = newAgentService(wb);
// One owner and one queue preserve ordering across both desktop windows.
let queue = Promise.resolve();
parentPort!.on('message', request => {
  const run = async () => {
    parentPort!.postMessage({ started: request.id });
    try {
      let data;
      if (request.method === 'attach') {
        if (agent.running) throw new Error('Wait for or cancel active Codex runs before changing libraries.');
        if (router.publisher.busy) throw new Error('An approval is still being pushed to GitHub. Wait for it to finish before changing libraries.');
        const next = new Workbench(request.args[0], workerData.local);
        wb.close(); wb = next; router = new Router(wb, routerOptions); agent = newAgentService(wb);
        data = { local: wb.local, canonical: wb.canonical };
      } else if (request.method === 'paths') data = { local: wb.local, canonical: wb.canonical };
      else if (request.method === 'rpc' && request.args[0] === 'agent.capture') data = agent.capture(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.start') data = agent.start(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.chat') data = agent.chat(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.exportSession') data = agent.exportSession(request.args[1].id);
      else if (request.method === 'rpc' && request.args[0] === 'agent.jobs') data = agent.list();
      else if (request.method === 'rpc' && request.args[0] === 'agent.models') data = await agent.models();
      else if (request.method === 'rpc' && request.args[0] === 'agent.cancel') data = agent.cancel(request.args[1].id);
      else if (request.method === 'rpc' && request.args[0] === 'trials.delete') data = agent.deleteTrial(request.args[1]);
      else if (request.method === 'rpc') data = await router.call(...request.args as [string, unknown]);
      else {
        const allowed = ['settings', 'saveSettings', 'snapshot', 'getRevision', 'observe', 'referencePath', 'importFile', 'importResource', 'addAttachment', 'removeAttachment', 'importLibrary', 'exportLibrary'];
        if (!allowed.includes(request.method)) throw new Error('Unsupported worker operation');
        data = await (wb as any)[request.method](...request.args);
      }
      if (request.method === 'rpc' && ['git.sync','git.checkpoint','git.merge','git.finishMerge'].includes(request.args[0])) wb.invalidateGit();
      parentPort!.postMessage({ id: request.id, data });
    } catch (error) {
      parentPort!.postMessage({ id: request.id, error: { code: error instanceof WorkbenchError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) } });
    }
  };
  if (request.method === 'rpc' && ['agent.jobs', 'agent.models', 'agent.cancel', 'publish.jobs', 'github.status', 'github.repositories', 'github.kilnRepositories', 'github.defaultRepository', 'github.loginStatus', 'providers.detect', 'repository.defaultParent', 'repository.inspect'].includes(request.args[0])) void run();
  else queue = queue.then(run);
});
