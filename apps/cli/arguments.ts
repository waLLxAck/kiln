import { WorkbenchError } from '../../packages/domain/errors';

const switches = new Set(['full', 'json', 'human-reviewed']);
const commandOptions: Record<string, string[]> = {
  'items list': ['query', 'collection', 'status', 'limit', 'offset', 'full'],
  'items read': ['revision', 'full'],
  'collections list': [],
  'items create': ['file', 'title', 'kind', 'from', 'input', 'author', 'key'],
  'items update': ['file', 'expect', 'summary', 'input', 'key'],
  'items restore': ['revision', 'expect'],
  'approvals request': ['revision'],
  'approvals approve': ['input', 'human-reviewed'],
  'library export': ['file'],
  'library import': ['file'],
  'home list': [],
  'home read': [],
  'home backups': [],
  'home save': ['file', 'expect'],
  'home backup': ['name'],
  'home restore': ['name', 'expect'],
  'home add': ['path'],
  'home remove': [],
};
const globalOptions = ['library', 'local', 'json'];
const knownOptions = new Set([...globalOptions, ...Object.values(commandOptions).flat(), 'input']);

export function parseArguments(args: string[]) {
  const positional: string[] = [], options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const name = token.slice(2);
    if (!token.startsWith('--') || !knownOptions.has(name)) throw new WorkbenchError('INVALID_INPUT', `Unknown option: ${token}. See --help.`);
    if (options.has(name)) throw new WorkbenchError('INVALID_INPUT', `Repeated option: ${token}.`);
    if (switches.has(name)) { options.set(name, 'true'); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new WorkbenchError('INVALID_INPUT', `Missing value for ${token}.`);
    options.set(name, value);
  }
  const [resource, action, ...ids] = positional;
  if (!resource || !action) throw new WorkbenchError('INVALID_INPUT', 'Provide a resource and action. See --help.');
  const command = `${resource} ${action}`;
  const allowed = new Set([...globalOptions, ...(commandOptions[command] ?? ['input'])]);
  for (const name of options.keys()) if (!allowed.has(name)) throw new WorkbenchError('INVALID_INPUT', `Option --${name} is not supported by ${command}.`);
  const needsId = ['items read', 'items update', 'items restore', 'approvals request', 'home read', 'home backups', 'home save', 'home backup', 'home restore', 'home remove'].includes(command);
  const maximum = command === 'items read' ? 100 : needsId ? 1 : 0;
  if ((needsId && ids.length === 0) || ids.length > maximum) throw new WorkbenchError('INVALID_INPUT', command === 'items read' ? 'Provide 1–100 item IDs.' : `${command} expects ${needsId ? 'one ID' : 'no positional IDs'}.`);
  if (ids.length > 1 && options.has('revision')) throw new WorkbenchError('INVALID_INPUT', '--revision requires exactly one item ID.');
  for (const name of ['limit', 'offset']) {
    if (!options.has(name)) continue;
    const value = Number(options.get(name));
    if (!Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0) || (name === 'limit' && value > 500)) throw new WorkbenchError('INVALID_INPUT', name === 'limit' ? '--limit must be an integer from 1 to 500.' : '--offset must be a nonnegative integer.');
  }
  return { resource, action, ids, option: (name: string, fallback = '') => options.get(name) ?? fallback };
}
