import { WorkbenchError } from '../../packages/domain/errors';
import { kindSchema } from '../../packages/protocol/schema';

const switches = new Set(['full', 'json', 'human-reviewed', 'recursive', 'unfiled', 'keep-items', 'trash-items']);
const commandOptions: Record<string, string[]> = {
  'items list': ['query', 'collection', 'recursive', 'unfiled', 'status', 'kind', 'from', 'limit', 'offset', 'full'],
  'items read': ['revision', 'full'],
  'collections list': [],
  'collections create': ['name'],
  'collections rename': ['from', 'to'],
  'collections delete': ['name', 'keep-items', 'trash-items'],
  'items move': ['collection', 'unfiled'],
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
  const needsId = ['items read', 'items move', 'items update', 'items restore', 'approvals request', 'home read', 'home backups', 'home save', 'home backup', 'home restore', 'home remove'].includes(command);
  const maximum = command === 'items read' ? 100 : command === 'items move' ? 500 : needsId ? 1 : 0;
  if ((needsId && ids.length === 0) || ids.length > maximum) throw new WorkbenchError('INVALID_INPUT', command === 'items read' ? 'Provide 1–100 item IDs.' : command === 'items move' ? 'Provide 1–500 item IDs.' : `${command} expects ${needsId ? 'one ID' : 'no positional IDs'}.`);
  // Where items go is never a default: name a collection or say they leave every collection; likewise keep or trash on delete.
  const oneOf = (a: string, b: string, why: string) => { if (options.has(a) === options.has(b)) throw new WorkbenchError('INVALID_INPUT', `${command} needs exactly one of --${a} or --${b}: ${why}.`); };
  if (command === 'items move') oneOf('collection', 'unfiled', '--unfiled takes the items out of every collection');
  if (command === 'collections delete') oneOf('keep-items', 'trash-items', '--keep-items moves them up one level, --trash-items moves them to the trash');
  if (command === 'items list' && options.has('unfiled') && options.has('collection')) throw new WorkbenchError('INVALID_INPUT', '--unfiled lists items outside every collection; drop --collection.');
  if (command === 'items list' && options.has('recursive') && !options.has('collection')) throw new WorkbenchError('INVALID_INPUT', '--recursive needs --collection.');
  if (resource === 'collections') for (const name of ['name', 'from', 'to']) if (commandOptions[command]?.includes(name) && !options.has(name)) throw new WorkbenchError('INVALID_INPUT', `${command} needs --${name}.`);
  if (ids.length > 1 && options.has('revision')) throw new WorkbenchError('INVALID_INPUT', '--revision requires exactly one item ID.');
  if (options.has('kind') && !kindSchema.safeParse(options.get('kind')).success) throw new WorkbenchError('INVALID_INPUT', `--kind must be one of: ${kindSchema.options.join(', ')}.`);
  for (const name of ['limit', 'offset']) {
    if (!options.has(name)) continue;
    const value = Number(options.get(name));
    if (!Number.isSafeInteger(value) || value < (name === 'limit' ? 1 : 0) || (name === 'limit' && value > 500)) throw new WorkbenchError('INVALID_INPUT', name === 'limit' ? '--limit must be an integer from 1 to 500.' : '--offset must be a nonnegative integer.');
  }
  return { resource, action, ids, option: (name: string, fallback = '') => options.get(name) ?? fallback };
}
