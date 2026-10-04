import type { Bridge } from '../../../packages/protocol/schema';
declare global { interface Window { kiln: Bridge } }
const inflight = new Map<string, Promise<unknown>>();
/** Reads shared while one is on its way, and given up after a while so a lost reply can't pin a screen for good. */
const readMethods = new Set(['snapshot', 'items.read', 'items.list', 'items.origins', 'deploy.installations', 'github.status', 'repository.status', 'repository.migrationPlan', 'providers.detect', 'agent.jobs', 'publish.jobs', 'context.sessionStart', 'home.list', 'home.read', 'backend.status']);
const READ_TIMEOUT_MS = 20_000;
/** Reads that wait on the network or a folder scan by design, and the status probe, which must answer quickly or not at all. */
const readTimeouts: Record<string, number> = { 'github.status': 45_000, 'repository.migrationPlan': 60_000, 'deploy.installations': 60_000, 'backend.status': 5_000 };
/** `fresh` skips a matching read already on its way (an explicit Retry); `timeoutMs` overrides the read timeout, or gives any other call one. */
export type CallOptions = { fresh?: boolean; timeoutMs?: number };
/** Rejects with `TIMEOUT: …` once the reply is `ms` late; the call itself may still finish in the backend. */
function deadline<T>(call: Promise<T>, method: string, ms: number): Promise<T> {
  if (!ms) return call;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(method === 'desktop.ready'
      ? `TIMEOUT: Kiln could not finish opening the library within ${Math.round(ms / 1000)} s. Try again, or restart Kiln.`
      : `TIMEOUT: Kiln did not answer ${method} within ${Math.round(ms / 1000)} s.`)), ms);
    call.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export function api<T = unknown>(method: string, args: unknown = {}, options: CallOptions = {}): Promise<T> {
  if (!readMethods.has(method)) return deadline(window.kiln.call<T>(method, args), method, options.timeoutMs ?? 0).then(result => {
    if (['agent.chat', 'agent.start', 'agent.capture', 'agent.cancel'].includes(method)) window.dispatchEvent(new Event('kiln:agent-refresh'));
    return result;
  });
  const key = method + JSON.stringify(args);
  const existing = options.fresh ? undefined : inflight.get(key); if (existing) return existing as Promise<T>;
  const request: Promise<T> = deadline(window.kiln.call<T>(method, args), method, options.timeoutMs ?? readTimeouts[method] ?? READ_TIMEOUT_MS).finally(() => { if (inflight.get(key) === request) inflight.delete(key); });
  inflight.set(key, request); return request;
}
/** The desktop app's `process.platform`; Windows when the bridge does not say (older preload, tests of the web build). */
export const platform = window.kiln?.platform ?? 'win32';
/** What this platform calls the app that shows files in folders. */
export const fileManager = platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : 'your file manager';
export const shortHash = (value: string) => value.slice(0, 8);
export { date } from './dates';
export { variablesIn } from '../../../packages/domain/text';
