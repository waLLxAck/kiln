import type { Bridge } from '../../../packages/protocol/schema';
declare global { interface Window { kiln: Bridge } }
const inflight = new Map<string, Promise<unknown>>();
const readMethods = new Set(['snapshot', 'items.read', 'items.list', 'deploy.installations', 'github.status', 'repository.status', 'repository.migrationPlan', 'providers.detect', 'agent.jobs']);
export function api<T = unknown>(method: string, args: unknown = {}): Promise<T> {
  if (!readMethods.has(method)) return window.kiln.call<T>(method, args).then(result => {
    if (['agent.chat', 'agent.start', 'agent.capture', 'agent.cancel'].includes(method)) window.dispatchEvent(new Event('kiln:agent-refresh'));
    return result;
  });
  const key = method + JSON.stringify(args);
  const existing = inflight.get(key); if (existing) return existing as Promise<T>;
  const request = window.kiln.call<T>(method, args).finally(() => inflight.delete(key));
  inflight.set(key, request); return request;
}
export const shortHash = (value: string) => value.slice(0, 8);
/** "6 Sept, 16:40" for this year; older dates add the year so "6 Sept" from three years ago is not mistaken for last week. */
export const date = (value: string) => { const when = new Date(value); return when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(when.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }); };
export { variablesIn } from '../../../packages/domain/text';
