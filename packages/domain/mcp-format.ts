/**
 * MCP servers as library items: one client-neutral definition (JSON, below) and its translation to and from each client's own
 * config entry. Pure, so the renderer shows and checks definitions with the same code the installer uses.
 *
 * ```json
 * { "name": "github", "description": "…", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
 *   "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } }
 * { "name": "docs", "transport": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
 * ```
 * Values refer to environment variables as `${NAME}`; each client gets its own spelling (`${env:NAME}` for VS Code and Cursor,
 * `env_vars` and `bearer_token_env_var` for Codex). Secrets never belong in the definition.
 */
export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpServer = { name: string; description?: string; transport: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
export type McpClient = 'claude' | 'codex' | 'copilot' | 'vscode' | 'cursor';
export const mcpClients: McpClient[] = ['claude', 'codex', 'copilot', 'vscode', 'cursor'];
export const mcpClientLabel: Record<McpClient, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot CLI', vscode: 'VS Code', cursor: 'Cursor' };
export const mcpTransports: McpTransport[] = ['stdio', 'http', 'sse'];
/** Server names Kiln writes: safe as a JSON key, a TOML key and a file-name-like label in every client. */
export const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FIELDS = ['name', 'description', 'transport', 'command', 'args', 'env', 'url', 'headers'];
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type Problem = { message: string; line?: number };
/** 1-based line of the first `"key"` in the text, for pointing a problem at the field it is about. */
const lineOf = (text: string, key: string) => { const at = text.indexOf(JSON.stringify(key)); return at < 0 ? undefined : text.slice(0, at).split('\n').length; };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(v => typeof v === 'string');

/**
 * Whether a value is a literal credential rather than a reference: anything under a key named like a secret (token, key, password,
 * authorization) that is not built from `${VAR}` references, and anything that looks like a known token format wherever it is.
 */
export function looksSecret(key: string, value: string) {
  const literal = value.replace(REFERENCE, '').replace(/^\s*(Bearer|Basic|Token)\s*/i, '').trim();
  if (!literal) return false;
  if (/^(sk-[A-Za-z0-9_-]{16,}|sk-ant-|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|ya29\.|npm_[A-Za-z0-9]{20})/.test(literal)) return true;
  if (/(token|secret|passw(or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|^auth$|cookie)/i.test(key)) return literal.length >= 8 && !/\s/.test(literal) && !/^(https?:\/\/|[~./\\]|[A-Za-z]:[\\/])/.test(literal);
  return /^[A-Za-z0-9_\-+/=.]{40,}$/.test(literal) && /\d/.test(literal) && /[a-z]/.test(literal) && /[A-Z]/.test(literal);
}

const sorted = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
/** The definition in a stable key order with empty fields left out: what the library stores and what dedupe compares. */
export function normaliseMcp(server: McpServer): McpServer {
  const out: McpServer = { name: server.name, ...(server.description?.trim() ? { description: server.description.trim() } : {}), transport: server.transport };
  if (server.transport === 'stdio') {
    out.command = server.command ?? '';
    if (server.args?.length) out.args = [...server.args];
    if (server.env && Object.keys(server.env).length) out.env = sorted(server.env);
  } else {
    out.url = server.url ?? '';
    if (server.headers && Object.keys(server.headers).length) out.headers = sorted(server.headers);
  }
  return out;
}
export const serialiseMcp = (server: McpServer) => JSON.stringify(normaliseMcp(server), null, 2) + '\n';
/** What makes two definitions the same server wherever they were found: everything but the description. */
export const mcpIdentity = (server: McpServer) => { const { description: _description, ...rest } = normaliseMcp(server); return JSON.stringify(rest); };

/** Parses an item's content; `server` is null when it is not a usable definition, and `problems` says why (with lines). */
export function parseMcp(content: string): { server: McpServer | null; problems: Problem[] } {
  let value: unknown;
  try { value = JSON.parse(content); } catch (error) {
    const at = /position (\d+)/.exec(error instanceof Error ? error.message : '')?.[1];
    return { server: null, problems: [{ message: 'An MCP server definition is JSON: name, transport (stdio, http or sse), then command and args, or url.', line: at ? content.slice(0, Number(at)).split('\n').length : 1 }] };
  }
  if (!isRecord(value)) return { server: null, problems: [{ message: 'An MCP server definition is one JSON object.', line: 1 }] };
  const problems: Problem[] = [], line = (key: string) => lineOf(content, key);
  for (const key of Object.keys(value)) if (!FIELDS.includes(key)) problems.push({ message: `Unknown field “${key}”. A definition has ${FIELDS.join(', ')}.`, line: line(key) });
  const { name, transport, command, args, env, url, headers, description } = value;
  if (typeof name !== 'string' || !MCP_NAME.test(name)) problems.push({ message: 'Give the server a name of letters, digits, dots, hyphens or underscores (up to 64); clients list its tools under it.', line: line('name') ?? 1 });
  if (description !== undefined && typeof description !== 'string') problems.push({ message: 'description is text.', line: line('description') });
  if (!mcpTransports.includes(transport as McpTransport)) problems.push({ message: 'Set transport to stdio (a local command), http (streamable HTTP) or sse.', line: line('transport') ?? 1 });
  if (transport === 'stdio') {
    if (typeof command !== 'string' || !command.trim()) problems.push({ message: 'A stdio server needs the command that starts it.', line: line('command') ?? line('transport') });
    if (args !== undefined && !(Array.isArray(args) && args.every(a => typeof a === 'string'))) problems.push({ message: 'args is a list of strings.', line: line('args') });
    if (env !== undefined && !strings(env)) problems.push({ message: 'env maps variable names to text values.', line: line('env') });
    for (const key of ['url', 'headers']) if (value[key] !== undefined) problems.push({ message: `${key} belongs to http and sse servers; a stdio server ignores it.`, line: line(key) });
  } else if (transport === 'http' || transport === 'sse') {
    if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url)) problems.push({ message: `A${transport === 'http' ? 'n http' : 'n sse'} server needs its http(s) url.`, line: line('url') ?? line('transport') });
    if (headers !== undefined && !strings(headers)) problems.push({ message: 'headers maps header names to text values.', line: line('headers') });
    for (const key of ['command', 'args', 'env']) if (value[key] !== undefined) problems.push({ message: `${key} belongs to stdio servers; a${transport === 'http' ? 'n http' : 'n sse'} server ignores it.`, line: line(key) });
  }
  const secrets = (field: 'env' | 'headers', record: unknown) => { if (strings(record)) for (const [key, text] of Object.entries(record)) if (looksSecret(key, text)) problems.push({ message: `${field}.${key} looks like a literal secret. Store a reference such as \${${referenceName(key)}} and set the variable on each machine; the library is shared through Git.`, line: line(key) }); };
  secrets('env', env); secrets('headers', headers);
  if (Array.isArray(args)) for (const arg of args) if (typeof arg === 'string' && looksSecret('', arg.replace(/^--?[\w-]+=/, ''))) problems.push({ message: 'An argument looks like a literal secret. Pass it through an environment variable instead.', line: line('args') });
  if (problems.length) return { server: null, problems };
  return { server: normaliseMcp(value as McpServer), problems };
}
/** Content checks for an `mcp` item (content-checks.ts). */
export const mcpChecks = (content: string): Problem[] => parseMcp(content).problems;
/** An environment variable name for a secret found under `key`: `Authorization` → `AUTHORIZATION`. */
export const referenceName = (key: string) => key.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'SECRET';

/**
 * Replaces literal secrets with `${NAME}` references before anything reaches the library: an env value becomes its own name,
 * a header its name (keeping a `Bearer ` scheme). `replaced` names what was changed, for the import to say so.
 */
export function scrubSecrets(server: McpServer, prefix = server.name): { server: McpServer; replaced: string[] } {
  const replaced: string[] = [];
  const scrub = (field: 'env' | 'headers', record?: Record<string, string>) => record && Object.fromEntries(Object.entries(record).map(([key, value]) => {
    if (!looksSecret(key, value)) return [key, value];
    replaced.push(`${field}.${key}`);
    const name = field === 'env' ? referenceName(key) : referenceName(`${prefix}_${key === 'Authorization' ? 'token' : key}`);
    const scheme = /^\s*(Bearer|Basic|Token)\s+/i.exec(value)?.[0] ?? '';
    return [key, `${scheme}\${${name}}`];
  }));
  const args = server.args?.map(arg => { const flag = /^(--?[\w-]+=)(.*)$/.exec(arg); if (!looksSecret('', flag ? flag[2] : arg)) return arg; replaced.push('args'); return flag ? `${flag[1]}\${${referenceName(flag[1])}}` : `\${${referenceName(`${prefix}_arg`)}}`; });
  return { server: normaliseMcp({ ...server, ...(server.env ? { env: scrub('env', server.env) } : {}), ...(server.headers ? { headers: scrub('headers', server.headers) } : {}), ...(args ? { args } : {}) }), replaced };
}

// Client formats.
/** Thrown when a definition cannot be expressed in a client's format; the message says what to change. */
export class McpTranslationError extends Error {}
const toEnvColon = (text: string) => text.replace(REFERENCE, (_m, name) => `\${env:${name}}`);
const fromEnvColon = (text: string) => text.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => `\${${name}}`);
const mapValues = (record: Record<string, string> | undefined, map: (text: string) => string) => record && Object.fromEntries(Object.entries(record).map(([k, v]) => [k, map(v)]));
const only = (reference: string) => /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(reference)?.[1];

/**
 * The entry a client's config holds for this server, in that client's shape: `mcpServers.<name>` for Claude Code, Copilot CLI and
 * Cursor, `servers.<name>` for VS Code, `[mcp_servers.<name>]` for Codex. Descriptions stay in the library; no client reads them.
 */
export function toNative(client: McpClient, input: McpServer): Record<string, unknown> {
  const server = normaliseMcp(input), stdio = server.transport === 'stdio';
  if (client === 'codex') {
    if (server.transport === 'sse') throw new McpTranslationError('Codex runs stdio and streamable HTTP servers only; this one uses sse.');
    if (stdio) {
      const env: Record<string, string> = {}, forward: string[] = [];
      for (const [key, value] of Object.entries(server.env ?? {})) {
        if (only(value) === key) forward.push(key);
        else if (value.includes('${')) throw new McpTranslationError(`Codex passes environment variables through under their own name only: set env.${key} to \${${key}} or to a plain value.`);
        else env[key] = value;
      }
      return { command: server.command, ...(server.args ? { args: server.args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(forward.length ? { env_vars: forward } : {}) };
    }
    const headers: Record<string, string> = {}, fromEnv: Record<string, string> = {}; let bearer: string | undefined;
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      const token = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
      if (key.toLowerCase() === 'authorization' && token) bearer = token;
      else if (only(value)) fromEnv[key] = only(value)!;
      else if (value.includes('${')) throw new McpTranslationError(`Codex reads a header either as plain text or whole from one variable: set headers.${key} to \${NAME}${key.toLowerCase() === 'authorization' ? ' or Bearer ${NAME}' : ''}.`);
      else headers[key] = value;
    }
    return { url: server.url, ...(bearer ? { bearer_token_env_var: bearer } : {}), ...(Object.keys(headers).length ? { http_headers: headers } : {}), ...(Object.keys(fromEnv).length ? { env_http_headers: fromEnv } : {}) };
  }
  if (client === 'copilot') return stdio ? { type: 'local', command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}), tools: ['*'] } : { type: server.transport, url: server.url, ...(server.headers ? { headers: server.headers } : {}), tools: ['*'] };
  if (client === 'cursor') return stdio ? { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: mapValues(server.env, toEnvColon) } : {}) } : { url: server.url, ...(server.headers ? { headers: mapValues(server.headers, toEnvColon) } : {}) };
  const colon = client === 'vscode' ? toEnvColon : (text: string) => text;
  return stdio ? { type: 'stdio', command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.env ? { env: mapValues(server.env, colon) } : {}) } : { type: server.transport, url: server.url, ...(server.headers ? { headers: mapValues(server.headers, colon) } : {}) };
}

/**
 * Reads a client's entry back into a definition; null when it is not a server Kiln can describe (no command or url). Fields the
 * definition has no place for (timeouts, tool filters, `envFile`, `cwd`) are left out, and `dropped` names them.
 */
export function fromNative(client: McpClient, name: string, value: unknown): { server: McpServer; dropped: string[] } | null {
  if (!isRecord(value)) return null;
  const text = (v: unknown) => typeof v === 'string' ? v : undefined;
  const record = (v: unknown) => isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean').map(([k, x]) => [k, String(x)])) : undefined;
  const known = new Set(['type', 'command', 'args', 'env', 'url', 'headers', ...(client === 'codex' ? ['env_vars', 'bearer_token_env_var', 'http_headers', 'env_http_headers'] : []), ...(client === 'copilot' ? ['tools'] : [])]);
  const dropped = Object.keys(value).filter(k => !known.has(k) || (client === 'copilot' && k === 'tools' && JSON.stringify(value.tools) !== '["*"]'));
  const command = text(value.command), url = text(value.url ?? (value as { serverUrl?: unknown }).serverUrl);
  const type = text(value.type)?.toLowerCase();
  const transport: McpTransport | null = command && !['http', 'sse', 'streamable-http'].includes(type ?? '') ? 'stdio' : url ? (type === 'sse' ? 'sse' : 'http') : null;
  if (!transport) return null;
  const args = Array.isArray(value.args) ? value.args.map(String) : undefined;
  let env = record(value.env), headers = record(value.headers);
  if (client === 'codex') {
    for (const key of Array.isArray(value.env_vars) ? value.env_vars.map(String) : []) env = { ...env, [key]: `\${${key}}` };
    headers = { ...record(value.http_headers) };
    for (const [key, variable] of Object.entries(record(value.env_http_headers) ?? {})) headers[key] = `\${${variable}}`;
    if (typeof value.bearer_token_env_var === 'string') headers.Authorization = `Bearer \${${value.bearer_token_env_var}}`;
  }
  if (client === 'vscode' || client === 'cursor') { env = mapValues(env, fromEnvColon); headers = mapValues(headers, fromEnvColon); }
  const server = normaliseMcp({ name, transport, command, args, env, url, headers });
  return { server, dropped };
}
const tomlKey = (key: string) => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (isRecord(value)) { const entries = Object.entries(value); return entries.length ? `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join(', ')} }` : '{}'; }
  throw new McpTranslationError('This value cannot be written to TOML.');
}
/** Codex's `[mcp_servers.<name>]` table as lines: one `key = value` per field, nested tables inline. */
export const tomlTable = (table: string, name: string, value: Record<string, unknown>) => [`[${tomlKey(table)}.${tomlKey(name)}]`, ...Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)];
/** An entry as it reads in the client's own file: a TOML table for Codex, `"name": { … }` for the JSON clients. */
export const nativeText = (client: McpClient, name: string, value: unknown) => client === 'codex' && isRecord(value) ? tomlTable('mcp_servers', name, value).join('\n') : `${JSON.stringify(name)}: ${JSON.stringify(value, null, 2)}`;
/** Plain words for how a server starts: `npx -y @scope/server` or its URL. Arguments with spaces are quoted. */
export const mcpCommandLine = (server: McpServer) => server.transport === 'stdio' ? [server.command ?? '', ...(server.args ?? [])].map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ') : server.url ?? '';
