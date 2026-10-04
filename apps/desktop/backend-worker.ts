import { parentPort, workerData } from 'node:worker_threads';
import { AgentService } from '../../packages/agent/service';
import { runFinished } from '../../packages/agent/run-notice';
import { Workbench } from '../../packages/domain/workbench';
import { Router } from '../../packages/domain/router';
import { WorkbenchError } from '../../packages/domain/errors';
import { pureReads, requestName } from './backend-routes';
import { z } from 'zod';
const log = (event: string, fields?: Record<string, unknown>) => parentPort!.postMessage({ telemetry: { event, fields } });
const failure = (error: unknown) => ({ code: error instanceof WorkbenchError ? error.code : error instanceof z.ZodError ? 'INVALID_INPUT' : 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) });
// A promise nobody waited on is logged, not fatal. An uncaught exception is logged and ends the worker; the main process restarts it.
process.on('unhandledRejection', reason => log('worker.unhandledRejection', { message: reason instanceof Error ? reason.message : String(reason) }));
process.on('uncaughtException', error => { log('worker.uncaughtException', { message: error.message }); process.exit(1); });
// The main process watches for silence: a worker stuck in synchronous work stops sending these (Backend's `worker.stall`).
setInterval(() => parentPort!.postMessage({ heartbeat: true }), 1000).unref();
// Ordinary desktop actions are programmatic. Only explicit agent actions invoke a provider.
const routerOptions = { log, composer: null };
const open = (root: string) => {
  const started = Date.now(), workbench = new Workbench(root, workerData.local);
  workbench.diagnostics = log;
  log('workbench.opened', { durationMs: Date.now() - started, warnings: workbench.warnings.length });
  return workbench;
};
let wb: Workbench;
try { wb = open(workerData.root); }
catch (error) {
  // Kiln cannot open this library (another process holds it, or it was made by a newer version); the main process says why.
  parentPort!.postMessage({ fatal: failure(error) }); process.exit(1);
}
let router = new Router(wb!, routerOptions);
const newAgentService = (workbench: Workbench) => {
  const service = new AgentService(workbench, log, undefined, undefined, undefined, workerData.cli);
  // main.ts shows a desktop notification only while Kiln is not in front; the event is sent for every finished run.
  service.onFinished = job => parentPort!.postMessage({ agentFinished: runFinished(job, id => { try { return workbench.getItem(id).title; } catch { return undefined; } }) });
  return service;
};
let agent = newAgentService(wb!);
parentPort!.postMessage({ ready: true });
// One owner and one queue preserve ordering across both desktop windows.
let queue = Promise.resolve();
/** Identical pure reads waiting to run, by method and arguments; one result answers every request for it. */
const reads = new Map<string, number[]>();
parentPort!.on('message', request => {
  const run = async (ids: number[] = [request.id]) => {
    for (const id of ids) parentPort!.postMessage({ started: id });
    try {
      let data;
      if (request.method === 'attach') {
        if (agent.running || agent.queued) throw new Error('Wait for or cancel active Codex runs before changing libraries.');
        if (router.publisher.busy) throw new Error('An approval is still being pushed to GitHub. Wait for it to finish before changing libraries.');
        const next = open(request.args[0]);
        router.fleet.stop(); wb.close(); wb = next; router = new Router(wb, routerOptions); agent = newAgentService(wb);
        data = { local: wb.local, canonical: wb.canonical };
      } else if (request.method === 'paths') data = { local: wb.local, canonical: wb.canonical };
      else if (request.method === 'rpc' && request.args[0] === 'agent.capture') data = agent.capture(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.start') data = agent.start(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.chat') data = agent.chat(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.exportSession') data = agent.exportSession(request.args[1].id);
      else if (request.method === 'rpc' && request.args[0] === 'agent.jobs') data = agent.list();
      else if (request.method === 'rpc' && request.args[0] === 'agent.job') data = agent.job(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.chatHistory') data = agent.chatHistory(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.models') data = await agent.models();
      else if (request.method === 'rpc' && request.args[0] === 'agent.cancel') data = agent.cancel(request.args[1].id);
      else if (request.method === 'rpc' && request.args[0] === 'trials.delete') data = agent.deleteTrial(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.tuneProposal') data = agent.tuneProposal(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.tuneAccept') data = agent.tuneAccept(request.args[1]);
      else if (request.method === 'rpc' && request.args[0] === 'agent.tuneDiscard') data = agent.tuneDiscard(request.args[1]);
      else if (request.method === 'rpc') data = await router.call(...request.args as [string, unknown]);
      else {
        const allowed = ['settings', 'saveSettings', 'snapshot', 'getRevision', 'observe', 'referencePath', 'importFile', 'importResource', 'addAttachment', 'removeAttachment', 'importLibrary', 'exportLibrary'];
        if (!allowed.includes(request.method)) throw new Error('Unsupported worker operation');
        data = await (wb as any)[request.method](...request.args);
      }
      if (request.method === 'rpc' && ['git.sync','git.checkpoint','git.merge','git.finishMerge','sync.pull','sync.push'].includes(request.args[0])) wb.invalidateGit();
      for (const id of ids) parentPort!.postMessage({ id, data });
    } catch (error) {
      for (const id of ids) parentPort!.postMessage({ id, error: failure(error) });
    }
  };
  // Pure reads run beside the queue, after the messages already waiting have arrived, so a burst of identical ones (a snapshot
  // from each window and each focus) is read once.
  const name = requestName(request.method, request.args);
  if (pureReads.has(name)) {
    const key = JSON.stringify([request.method, request.args]), waiting = reads.get(key);
    if (waiting) { waiting.push(request.id); return; }
    reads.set(key, [request.id]);
    setImmediate(() => { const ids = reads.get(key)!; reads.delete(key); if (ids.length > 1) log('backend.coalesced', { method: name, count: ids.length }); void run(ids); });
    return;
  }
  // Read-only calls run beside the queue. Usage reads session logs in chunks and yields between them, so it never holds the queue.
  // So do calls that wait on the network or the Git queue (pulls, merges, the Settings Git buttons, installing what is marked
  // after its fetch, fetching a GitHub repository to import): the Git queue orders them, and their local changes are made in one
  // synchronous step once the wait is over, so nothing queued behind them waits for GitHub.
  if (request.method === 'rpc' && ['agent.jobs', 'agent.job', 'agent.chatHistory', 'agent.models', 'agent.cancel', 'publish.jobs', 'github.status', 'github.repositories', 'github.kilnRepositories', 'github.defaultRepository', 'github.loginStatus', 'providers.detect', 'repository.defaultParent', 'repository.inspect', 'sync.status', 'sync.fetch', 'fleet.view', 'repos.scan', 'repos.preview', 'repos.registries', 'repos.mine', 'usage.scan', 'usage.report', 'usage.item', 'usage.prices', 'git.sync', 'sync.pull', 'sync.push', 'git.merge', 'git.finishMerge', 'skills.sync', 'repos.import', 'repos.source'].includes(request.args[0])) void run();
  else queue = queue.then(() => run());
});
