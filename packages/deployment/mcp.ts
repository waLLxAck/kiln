import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { applyEdits, findNodeAtLocation, modify, parse as parseJsonc, parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser/lib/esm/main';
import type { Workbench } from '../domain/workbench';
import type { HomeFiles } from '../home/service';
import { editorConfigRoot } from '../home/catalog';
import { invariant, WorkbenchError } from '../domain/errors';
import { validateContent } from '../domain/content';
import { fromNative, MCP_NAME, mcpClientLabel, mcpClients, mcpIdentity, McpTranslationError, parseMcp, scrubSecrets, serialiseMcp, tomlTable, toNative, type McpClient, type McpServer } from '../domain/mcp-format';
import { hashSchema, idSchema, type Revision } from '../protocol/schema';
import { digest, hash, noLinks, now, readRecords, stable, withLock, writeJson } from '../storage/files';

/**
 * MCP servers installed into client configs. Unlike skills, a server is one entry in a file the client and the user also edit, so
 * Kiln changes only `mcpServers.<name>` (or `servers.<name>`, or the `[mcp_servers.<name>]` table) and leaves every other byte
 * alone: JSON through jsonc edits that keep comments and layout, TOML by replacing only that table's lines. Each write re-reads
 * the file under the library lock and refuses when it changed since it was read, checks that nothing but the entry differs
 * afterwards, keeps the previous file in Config files' versions (30 per file) and writes a receipt: the entry before and after, so
 * drift is visible and the latest install can be rolled back or removed. Receipts are machine-private, like skill receipts.
 */
export type McpScope = 'personal' | 'project';
/** One client's MCP config: personal (in the home folder) or a project's. `table` is the key path of the servers table. */
export type McpLocation = { client: McpClient; scope: McpScope; /** Project folder; empty for personal. */ project: string; file: string; format: 'json' | 'toml'; table: string[] };
export type McpReceipt = {
  id: string; itemId: string; revision: string; client: McpClient; scope: McpScope; project: string; file: string; name: string;
  /** Digest of the entry now in the file (none for a removal). */ hash: string | null;
  /** The entry that was there before, exactly as read, for rollback; null when there was none. */ previous: unknown; previousHash: string | null; previousRevision: string | null;
  status: 'applied' | 'rolled_back' | 'uninstalled'; method: 'installed' | 'updated' | 'replaced' | 'adopted' | 'unchanged' | 'removed' | 'rolled back';
  /** The Config files key under which the file before this change is kept; null when nothing was written. */ backup: string | null; createdAt: string;
};
/**
 * One client location for an item. installed: Kiln wrote the entry and it is unchanged since; drifted: Kiln wrote it and it was
 * edited; external: an entry with this name that Kiln did not write. `matches`: the entry describes the same server as the
 * current revision. `unsupported`: the client cannot run this definition (Codex and sse), so it has no switch.
 */
export type McpCopy = {
  client: McpClient; scope: McpScope; project: string; file: string; name: string;
  state: 'absent' | 'installed' | 'drifted' | 'external' | 'unreadable'; matches: boolean; outdated?: true; receiptId: string | null;
  /** Entry names Kiln wrote for this item before the server was renamed. */ renamed?: true; unsupported?: string; error?: string; hash: string | null;
};
export type McpStatus = { itemId: string; name: string; revision: string; approved: string | null; projects: { root: string; name: string }[]; copies: McpCopy[] };
export type McpFound = { client: McpClient; scope: McpScope | 'local'; project: string; file: string };
export type McpScanEntry = {
  /** Identity of the definition (without its description), the same wherever it was found. */ key: string; name: string; server: McpServer; found: McpFound[];
  /** Literal secrets replaced by `${NAME}` references before import. */ replaced: string[]; /** Client-only fields a definition does not keep. */ dropped: string[];
  /** The library item that already holds this definition. */ itemId: string | null;
};
export type McpScan = { servers: McpScanEntry[]; files: { client: McpClient; file: string; error?: string }[] };

const MAX_CONFIG = 20 * 1024 * 1024;
const personalFile: Record<McpClient, string> = { claude: '.claude.json', codex: 'config.toml', copilot: 'mcp-config.json', vscode: 'mcp.json', cursor: 'mcp.json' };
const projectFile: Record<McpClient, string> = { claude: '.mcp.json', codex: '.codex/config.toml', copilot: '.github/mcp.json', vscode: '.vscode/mcp.json', cursor: '.cursor/mcp.json' };
const tableOf = (client: McpClient) => client === 'codex' ? ['mcp_servers'] : client === 'vscode' ? ['servers'] : ['mcpServers'];
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** TOML dates and big integers as JSON would hold them, so parsed files compare and hash like JSON ones. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}, (_k, v) => typeof v === 'bigint' ? Number(v) : v)) as Record<string, unknown>;
const at = (data: unknown, keys: string[]) => keys.reduce<unknown>((value, key) => isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined, data);
/** The data without the value at `keys`, and without the tables around it once they are empty, so adding the first entry compares equal. */
const without = (data: Record<string, unknown>, keys: string[]) => {
  const copy = plain(data), parents: Record<string, unknown>[] = [copy];
  for (const key of keys.slice(0, -1)) { const next = parents.at(-1)![key]; if (!isRecord(next)) return copy; parents.push(next); }
  delete parents.at(-1)![keys.at(-1)!];
  for (let i = parents.length - 1; i > 0 && !Object.keys(parents[i]).length; i--) delete parents[i - 1][keys[i - 1]];
  return copy;
};
/** Where a location is, as the user reads it: `Claude Code · personal` or `Codex · Web app`. */
export const mcpLocationLabel = (copy: Pick<McpCopy, 'client' | 'scope' | 'project'>) => `${mcpClientLabel[copy.client]} · ${copy.scope === 'personal' ? 'personal' : path.basename(copy.project)}`;

// TOML: the entry's own tables, found by their headers, are the only lines replaced.
/** Key path of a `[a.b."c d"]` header, or null for a line that is not one. */
function headerPath(line: string): string[] | null {
  const match = /^\s*\[\[?(.+?)\]\]?\s*(?:#.*)?$/.exec(line); if (!match) return null;
  const parts: string[] = []; let rest = match[1].trim();
  while (rest) {
    let key: string;
    if (rest[0] === '"') { const end = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0]; if (!end) return null; key = JSON.parse(end); rest = rest.slice(end.length); }
    else if (rest[0] === "'") { const end = rest.indexOf("'", 1); if (end < 0) return null; key = rest.slice(1, end); rest = rest.slice(end + 1); }
    else { const bare = /^[A-Za-z0-9_-]+/.exec(rest)?.[0]; if (!bare) return null; key = bare; rest = rest.slice(bare.length); }
    parts.push(key); rest = rest.trim();
    if (rest.startsWith('.')) rest = rest.slice(1).trim(); else if (rest) return null;
  }
  return parts;
}
/**
 * The TOML text with `[table.name]` (and its subtables) replaced by `value`, or removed when `value` is undefined. Other lines,
 * including comments and blank lines between tables, are kept as they are. An entry written another way (an inline table, dotted
 * keys) is refused rather than rewritten.
 */
export function tomlWith(text: string, table: string, name: string, value: Record<string, unknown> | undefined, parsed: Record<string, unknown>) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', lines = text.length ? text.split(/\r?\n/) : [];
  const headers = lines.map((line, i) => ({ i, path: headerPath(line) })).filter((h): h is { i: number; path: string[] } => h.path !== null);
  const mine = (keys: string[]) => keys.length >= 2 && keys[0] === table && keys[1] === name;
  const blocks = headers.filter(h => mine(h.path)).map(h => {
    const next = headers.find(other => other.i > h.i)?.i ?? lines.length;
    let end = next - 1; while (end > h.i && (!lines[end].trim() || /^\s*#/.test(lines[end]))) end--;
    return { start: h.i, end };
  }).reduce<{ start: number; end: number }[]>((merged, b) => {
    // A table and its subtables separated only by blank lines are one block, so removing them leaves no extra gap.
    const previous = merged.at(-1);
    if (previous && lines.slice(previous.end + 1, b.start).every(l => !l.trim())) previous.end = b.end; else merged.push({ ...b });
    return merged;
  }, []);
  invariant(blocks.length || at(parsed, [table, name]) === undefined, 'TOML_LAYOUT_UNSUPPORTED', `“${name}” is written inline in this file, not as a [${table}.${name}] table. Rewrite it as a table in Config files, then try again.`);
  const block = value ? tomlTable(table, name, value) : [];
  if (!blocks.length) {
    if (!value) return text;
    const body = [...lines]; while (body.length && !body.at(-1)!.trim()) body.pop();
    return [...body, ...(body.length ? [''] : []), ...block].join(eol) + eol;
  }
  const out: string[] = [];
  lines.forEach((line, i) => {
    const inBlock = blocks.find(b => i >= b.start && i <= b.end);
    if (!inBlock) { out.push(line); return; }
    if (i === blocks[0].start) out.push(...block);
  });
  // Removing a table between two blank lines would leave two; keep one.
  if (!value) { const start = blocks[0].start; if (start > 0 && out[start - 1] !== undefined && !out[start - 1].trim() && out[start] !== undefined && !out[start].trim()) out.splice(start, 1); }
  return out.join(eol);
}
/**
 * The JSON text with `keys` set to `value` (or removed), keeping comments, indentation and line endings. The new value is
 * written in the file's own indentation and spliced in after the last sibling, so neighbouring entries keep their bytes (a
 * formatter pass would re-wrap them).
 */
export function jsonWith(text: string, keys: string[], value: unknown) {
  if (!text.trim()) {
    if (value === undefined) return text;
    const nested = keys.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
    return JSON.stringify(nested, null, 2) + '\n';
  }
  if (value === undefined) return applyEdits(text, modify(text, keys, undefined, {}));
  const eol = text.includes('\r\n') ? '\r\n' : '\n', found = /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ', unit = found.includes('\t') ? '\t' : found;
  const root = parseTree(text); invariant(root?.type === 'object', 'INVALID_CONFIG', 'The file is not a JSON object.');
  const indentAt = (offset: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', offset - 1) + 1))![0];
  const pretty = (v: unknown, base: string) => JSON.stringify(v, null, unit).split('\n').join(eol + base);
  const splice = (offset: number, length: number, content: string) => text.slice(0, offset) + content + text.slice(offset + length);
  const existing = findNodeAtLocation(root, keys);
  if (existing?.parent) return splice(existing.offset, existing.length, pretty(value, indentAt(existing.parent.offset)));
  let depth = keys.length - 1, parent: JsonNode | undefined;
  for (; depth >= 0; depth--) { parent = depth === 0 ? root : findNodeAtLocation(root, keys.slice(0, depth)); if (parent) break; }
  invariant(parent?.type === 'object', 'INVALID_CONFIG', `“${keys.slice(0, depth).join('.')}” in this file is not an object.`);
  const nested = keys.slice(depth + 1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), value), property = (base: string) => `${JSON.stringify(keys[depth])}: ${pretty(nested, base)}`;
  const last = parent.children?.at(-1);
  if (!last) { const base = indentAt(parent.offset); return splice(parent.offset, parent.length, `{${eol}${base}${unit}${property(base + unit)}${eol}${base}}`); }
  const multiline = text.slice(parent.offset, last.offset).includes('\n'), base = multiline ? indentAt(last.offset) : indentAt(parent.offset);
  return splice(last.offset + last.length, 0, multiline ? `,${eol}${base}${property(base)}` : `, ${property(base)}`);
}

type Loaded = { bytes: Buffer | null; hash: string | null; text: string; bom: boolean; data: Record<string, unknown>; mode: number | null };
function parseConfig(format: McpLocation['format'], text: string, file: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    if (format === 'toml') return plain(parseToml(text));
    const errors: ParseError[] = [], value = parseJsonc(text, errors, { allowTrailingComma: true });
    invariant(!errors.length && isRecord(value), 'INVALID_CONFIG', 'not a JSON object');
    return value;
  } catch (error) { throw new WorkbenchError('INVALID_CONFIG', `${file} could not be read (${error instanceof Error ? error.message : String(error)}). Fix it in Config files first; nothing was changed.`); }
}
/** Replaces a file atomically with the permissions the old one had, so a private config (~/.claude.json) stays private. */
function writePreserving(file: string, bytes: Buffer, mode: number | null) {
  noLinks(file); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`, fd = fs.openSync(temp, 'wx', mode ?? 0o644);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { if (mode !== null) fs.chmodSync(temp, mode); fs.renameSync(temp, file); } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}

export class McpServers {
  constructor(private wb: Workbench, private home: HomeFiles) {}
  private receiptsDir() { return path.join(this.wb.local, 'mcp-receipts'); }
  receipts(itemId?: string) { return readRecords(this.receiptsDir(), v => v as McpReceipt).filter(r => !itemId || r.itemId === itemId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  private latest(file: string, name: string, receipts = this.receipts()) { return receipts.filter(r => r.file === path.resolve(file) && r.name === name).at(-1); }
  private owns(receipt: McpReceipt | undefined, itemId: string): receipt is McpReceipt { return receipt?.status === 'applied' && (receipt.itemId === itemId || this.wb.mergedTarget(receipt.itemId) === itemId); }

  /** A client's config file, personal or in `project`. Null for VS Code on a system without a known settings folder. */
  location(client: McpClient, project = ''): McpLocation | null {
    const { home, env } = this.home, table = tableOf(client), format = client === 'codex' ? 'toml' as const : 'json' as const;
    if (project) { invariant(path.isAbsolute(project), 'INVALID_PATH', 'Choose a project by its full path.'); return { client, scope: 'project', project: path.resolve(project), file: path.join(path.resolve(project), ...projectFile[client].split('/')), format, table }; }
    const folder = client === 'claude' ? env.CLAUDE_CONFIG_DIR || home : client === 'codex' ? env.CODEX_HOME || path.join(home, '.codex') : client === 'copilot' ? env.COPILOT_HOME || path.join(home, '.copilot')
      : client === 'cursor' ? path.join(home, '.cursor') : (() => { const root = editorConfigRoot(home, env, process.platform); return root ? path.join(root, 'Code', 'User') : null; })();
    return folder ? { client, scope: 'personal', project: '', file: path.join(folder, personalFile[client]), format, table } : null;
  }
  private load(location: McpLocation): Loaded {
    noLinks(location.file);
    const stat = fs.statSync(location.file, { throwIfNoEntry: false });
    if (!stat) return { bytes: null, hash: null, text: '', bom: false, data: {}, mode: null };
    invariant(stat.isFile(), 'INVALID_FILE', `${location.file} is not a regular file.`);
    invariant(stat.size <= MAX_CONFIG, 'FILE_TOO_LARGE', `${location.file} is over 20 MB; Kiln does not edit it.`);
    const bytes = fs.readFileSync(location.file), bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, text = bytes.toString('utf8', bom ? 3 : 0);
    return { bytes, hash: hash(bytes), text, bom, data: parseConfig(location.format, text, location.file), mode: stat.mode & 0o777 };
  }
  /**
   * Sets (or removes, for undefined) one server entry. Nothing but that entry may differ afterwards, the file must still be the
   * bytes `loaded` read, and the previous bytes are kept as a Config files version. Returns that version's key.
   */
  private write(location: McpLocation, loaded: Loaded, name: string, value: unknown) {
    const keys = [...location.table, name];
    let next: string;
    try { next = location.format === 'toml' ? tomlWith(loaded.text, location.table[0], name, value as Record<string, unknown> | undefined, loaded.data) : jsonWith(loaded.text, keys, value); }
    catch (error) { if (error instanceof WorkbenchError) throw error; throw new WorkbenchError('INVALID_CONFIG', `${location.file}: ${error instanceof Error ? error.message : String(error)}`); }
    const after = parseConfig(location.format, next, location.file);
    invariant(stable(at(after, keys) ?? null) === stable(value === undefined ? null : plain(value)) && stable(without(after, keys)) === stable(without(loaded.data, keys)), 'WRITE_VERIFY_FAILED', `Kiln could not change only the “${name}” entry in ${location.file}; nothing was written. Edit it in Config files instead.`);
    const bytes = Buffer.from((loaded.bom ? '﻿' : '') + next, 'utf8');
    const current = fs.existsSync(location.file) ? hash(fs.readFileSync(location.file)) : null;
    invariant(current === loaded.hash, 'FILE_CHANGED', `${location.file} changed while Kiln was writing; nothing was written. Try again.`);
    const backup = loaded.bytes ? this.home.keepVersion(location.file, loaded.bytes) : null;
    writePreserving(location.file, bytes, loaded.mode);
    return backup;
  }
  private receipt(input: Omit<McpReceipt, 'id' | 'createdAt' | 'file'> & { file: string }): McpReceipt {
    const receipt: McpReceipt = { ...input, file: path.resolve(input.file), id: randomUUID(), createdAt: now() };
    writeJson(path.join(this.receiptsDir(), `${receipt.id}.json`), receipt); return receipt;
  }
  private server(revision: Revision): McpServer {
    invariant(revision.kind === 'mcp', 'NOT_AN_MCP_SERVER', 'Only MCP server items are installed into MCP configs.');
    const { server, problems } = parseMcp(revision.content); invariant(server, 'VALIDATION_FAILED', problems.map(p => p.message).join('\n')); return server;
  }
  private native(client: McpClient, server: McpServer) {
    try { return toNative(client, server); } catch (error) { if (error instanceof McpTranslationError) throw new WorkbenchError('CLIENT_UNSUPPORTED', error.message); throw error; }
  }
  /** Whether a client's entry describes this server, ignoring layout, key order and the description. */
  private same(client: McpClient, entry: unknown, server: McpServer) { const read = fromNative(client, server.name, entry); return Boolean(read && !read.dropped.length && mcpIdentity(read.server) === mcpIdentity(server)); }
  /** The revision an update installs: the current one when it is approved here, else the newest local approval. */
  private approvedRevision(itemId: string) {
    const item = this.wb.getItem(itemId), local = this.wb.approvals().filter(a => a.itemId === itemId && a.trust === 'local');
    const revision = local.some(a => a.revision === item.revision) ? item.revision : local.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.revision;
    try { return revision ? this.wb.getRevision(itemId, revision) : null; } catch { return null; }
  }
  /** Project folders MCP servers can go into: enrolled and added projects, plus any that hold one of this item's entries. */
  projects(itemId?: string, extra?: string) {
    invariant(!extra || path.isAbsolute(extra), 'INVALID_PATH', 'Choose a project by its full path.');
    const roots = [...this.wb.targets().filter(t => t.scope === 'project').map(t => t.root), ...this.home.savedProjects(), ...(itemId ? this.receipts(itemId).filter(r => r.project).map(r => r.project) : []), ...(extra ? [extra] : [])];
    return [...new Map(roots.map(root => [path.resolve(root), path.resolve(root)])).values()].filter(root => { try { return fs.statSync(root).isDirectory(); } catch { return false; } }).map(root => ({ root, name: path.basename(root) }));
  }

  /**
   * Every client location for an item: what is there under its server name, and whether Kiln wrote it. `project` adds a folder
   * that is not one of your projects yet (the preview before installing there). Reads files; writes nothing.
   */
  status(input: unknown): McpStatus {
    const { itemId, project } = z.object({ itemId: idSchema, project: z.string().min(1).optional() }).parse(input);
    const item = this.wb.getItem(itemId), revision = this.wb.getRevision(itemId), server = this.server(revision);
    const approved = this.approvedRevision(itemId), approvedServer = approved && approved.kind === 'mcp' ? parseMcp(approved.content).server : null;
    const receipts = this.receipts(), projects = this.projects(itemId, project), copies: McpCopy[] = [];
    const locations = [...mcpClients.map(client => this.location(client)), ...projects.flatMap(p => mcpClients.map(client => this.location(client, p.root)))].filter((l): l is McpLocation => l !== null);
    for (const location of locations) {
      const base = { client: location.client, scope: location.scope, project: location.project, file: location.file };
      let unsupported: string | undefined, proposed: string | null = null;
      try { proposed = digest(this.native(location.client, server)); } catch (error) { unsupported = error instanceof Error ? error.message : String(error); }
      let loaded: Loaded;
      try { loaded = this.load(location); } catch (error) { copies.push({ ...base, name: server.name, state: 'unreadable', matches: false, receiptId: null, hash: null, error: error instanceof Error ? error.message : String(error), ...(unsupported ? { unsupported } : {}) }); continue; }
      const names = new Set([server.name, ...receipts.filter(r => r.file === path.resolve(location.file) && this.owns(this.latest(location.file, r.name, receipts), item.id)).map(r => r.name)]);
      for (const name of names) {
        const entry = at(loaded.data, [...location.table, name]), owner = this.latest(location.file, name, receipts), mine = this.owns(owner, item.id) ? owner : undefined;
        if (name !== server.name && (entry === undefined || !mine)) continue;
        const current = entry === undefined ? null : digest(entry);
        const state: McpCopy['state'] = entry === undefined ? 'absent' : mine ? (current === mine.hash ? 'installed' : 'drifted') : 'external';
        let outdated = false;
        if (mine && state === 'installed' && approved && approvedServer && mine.revision !== approved.hash) { try { outdated = digest(this.native(location.client, approvedServer)) !== mine.hash; } catch { outdated = false; } }
        copies.push({ ...base, name, state, matches: entry !== undefined && proposed !== null && name === server.name && this.same(location.client, entry, server), receiptId: mine?.id ?? null, hash: loaded.hash, ...(outdated ? { outdated: true as const } : {}), ...(name !== server.name ? { renamed: true as const } : {}), ...(unsupported && name === server.name ? { unsupported } : {}) });
      }
    }
    return { itemId, name: server.name, revision: revision.hash, approved: approved?.hash ?? null, projects, copies };
  }

  /**
   * What installing into one location would meet: the entry there now and the entry Kiln would write, both in the client's own
   * shape, the file hash an install must still find (`expect`), and the latest receipt Kiln holds for the entry. Writes nothing.
   */
  preview(input: unknown) {
    const data = z.object({ itemId: idSchema, client: z.enum(mcpClients as [McpClient, ...McpClient[]]), project: z.string().min(1).optional(), name: z.string().regex(MCP_NAME).optional() }).parse(input);
    const server = this.server(this.wb.getRevision(data.itemId)), location = this.target(data), name = data.name ?? server.name;
    let proposed: unknown = null, unsupported: string | undefined;
    try { proposed = name === server.name ? this.native(data.client, server) : null; } catch (error) { unsupported = error instanceof Error ? error.message : String(error); }
    const loaded = this.load(location), current = at(loaded.data, [...location.table, name]), receipt = this.latest(location.file, name) ?? null;
    return { file: location.file, name, exists: loaded.bytes !== null, hash: loaded.hash, current: current ?? null, proposed, receipt: receipt && receipt.itemId === data.itemId ? receipt : null, ...(unsupported ? { unsupported } : {}) };
  }
  private target(input: { client: McpClient; project?: string }) {
    if (input.project) { noLinks(input.project); invariant(fs.existsSync(input.project) && fs.statSync(input.project).isDirectory(), 'INVALID_PATH', 'Choose an existing project folder.'); }
    const location = this.location(input.client, input.project ?? ''); invariant(location, 'CLIENT_UNSUPPORTED', `${mcpClientLabel[input.client]} has no personal MCP config on this system.`); return location;
  }
  /**
   * Installs the current revision into one client location, approving it first when needed (like a skill's Install). Absent: the
   * entry is added. Kiln's unchanged entry: updated. An identical entry Kiln did not write: adopted without writing. A different
   * entry, or Kiln's entry edited since: refused unless `replace`, which keeps the old entry in the receipt and the old file as a
   * version. `expect` is the file hash a preview showed; a different file refuses.
   */
  install(input: unknown) {
    const data = z.object({ itemId: idSchema, client: z.enum(mcpClients as [McpClient, ...McpClient[]]), project: z.string().min(1).optional(), replace: z.boolean().default(false), expect: hashSchema.nullable().optional(), confirm: z.literal(true) }).parse(input);
    let item = this.wb.getItem(data.itemId);
    invariant(!item.deletedAt, 'ITEM_DELETED', 'Restore this item before installing it.');
    const revision = this.wb.getRevision(item.id), errors = validateContent(revision); invariant(!errors.length, 'VALIDATION_FAILED', errors.join('\n'));
    const server = this.server(revision), location = this.target(data), native = this.native(data.client, server), wanted = digest(native);
    let approved = false;
    if (!this.wb.approvals().some(a => a.itemId === item.id && a.revision === revision.hash && a.trust === 'local')) {
      this.wb.approve({ id: item.id, revision: revision.hash, reviewer: os.userInfo().username, scope: 'Installed from Kiln', note: 'Approved by choosing Install in Kiln.', waivedChecks: 'Installed directly; no trial evidence linked.' });
      item = this.wb.getItem(item.id); approved = true;
    }
    if (location.project && !this.home.savedProjects().some(root => path.resolve(root) === location.project) && !this.wb.targets().some(t => path.resolve(t.root) === location.project)) this.home.addProject({ path: location.project });
    const receipt = withLock(this.wb.canonical, () => {
      const loaded = this.load(location);
      invariant(data.expect === undefined || data.expect === loaded.hash, 'FILE_CHANGED', `${location.file} changed since you looked at it. Nothing was written; check it again.`);
      const entry = at(loaded.data, [...location.table, server.name]), owner = this.latest(location.file, server.name), mine = this.owns(owner, item.id) ? owner : undefined;
      const common = { itemId: item.id, revision: revision.hash, client: data.client, scope: location.scope, project: location.project, file: location.file, name: server.name, status: 'applied' as const };
      const previous = { previous: entry ?? null, previousHash: entry === undefined ? null : digest(entry), previousRevision: mine?.revision ?? null };
      if (entry !== undefined && mine && digest(entry) === mine.hash && mine.hash === wanted) return mine.revision === revision.hash ? { ...mine, method: 'unchanged' as const } : this.receipt({ ...common, ...previous, hash: wanted, method: 'unchanged', backup: null });
      if (entry !== undefined && (!mine || digest(entry) !== mine.hash) && this.same(data.client, entry, server)) return this.receipt({ ...common, ...previous, hash: digest(entry), method: 'adopted', backup: null });
      const method = entry === undefined ? 'installed' : mine && digest(entry) === mine.hash ? 'updated' : 'replaced';
      invariant(method !== 'replaced' || data.replace, mine ? 'TARGET_DRIFTED' : 'TARGET_UNMANAGED', mine ? `The “${server.name}” entry in ${location.file} was edited outside Kiln. Choose Replace to write the library version; the edited entry is kept in the receipt and the file in Config files versions.` : `${location.file} already has a different “${server.name}” server. Import it into the library, or choose Replace to write the library version over it (the old entry is kept).`);
      const backup = this.write(location, loaded, server.name, native);
      this.wb.record('deployed', `${method === 'updated' ? 'Updated' : 'Installed'} MCP server “${server.name}” for ${mcpLocationLabel(location)}; start a new session to use it`, item.id, revision.hash);
      return this.receipt({ ...common, ...previous, hash: wanted, method, backup });
    });
    return { itemId: item.id, revision: revision.hash, approved, method: receipt.method, file: location.file, receipt };
  }
  /**
   * Removes only this server's entry. Kiln's unchanged entry and an identical external one go without asking; anything else needs
   * `force`. The removed entry stays in the receipt and the file before it in Config files versions. `name` removes an entry
   * Kiln wrote under an earlier server name.
   */
  remove(input: unknown) {
    const data = z.object({ itemId: idSchema, client: z.enum(mcpClients as [McpClient, ...McpClient[]]), project: z.string().min(1).optional(), name: z.string().regex(MCP_NAME).optional(), force: z.boolean().default(false), expect: hashSchema.nullable().optional(), confirm: z.literal(true) }).parse(input);
    const item = this.wb.getItem(data.itemId), revision = this.wb.getRevision(item.id), server = this.server(revision), location = this.target(data);
    const name = data.name ?? server.name;
    return withLock(this.wb.canonical, () => {
      const owner = this.latest(location.file, name), mine = this.owns(owner, item.id) ? owner : undefined;
      invariant(name === server.name || mine, 'TARGET_UNMANAGED', `Kiln did not write a “${name}” entry for this item there.`);
      const loaded = this.load(location);
      invariant(data.expect === undefined || data.expect === loaded.hash, 'FILE_CHANGED', `${location.file} changed since you looked at it. Nothing was removed; check it again.`);
      const entry = at(loaded.data, [...location.table, name]);
      const common = { itemId: item.id, revision: mine?.revision ?? revision.hash, client: data.client, scope: location.scope, project: location.project, file: location.file, name, status: 'uninstalled' as const, hash: null, method: 'removed' as const, previousRevision: mine?.revision ?? null };
      if (entry === undefined) { if (mine) this.receipt({ ...common, previous: null, previousHash: null, backup: null }); return { itemId: item.id, method: 'absent' as const, file: location.file }; }
      const unchanged = mine ? digest(entry) === mine.hash : name === server.name && this.same(data.client, entry, server);
      invariant(unchanged || data.force, mine ? 'TARGET_DRIFTED' : 'TARGET_UNMANAGED', `The “${name}” entry in ${location.file} differs from your library. Import it first to keep it, or choose Remove anyway (the entry is kept in the receipt, the file in Config files versions).`);
      const backup = this.write(location, loaded, name, undefined);
      this.wb.record('uninstalled', `Removed MCP server “${name}” from ${mcpLocationLabel(location)}; the rest of the file is unchanged`, item.id, revision.hash);
      const receipt = this.receipt({ ...common, previous: entry, previousHash: digest(entry), backup });
      return { itemId: item.id, method: 'removed' as const, file: location.file, receipt };
    });
  }
  /** Puts back the entry the latest install replaced (or removes the entry when there was none), if nobody edited it since. */
  rollback(input: unknown) {
    const data = z.object({ receiptId: idSchema, confirm: z.literal(true) }).parse(input);
    return withLock(this.wb.canonical, () => {
      const receipt = this.receipts().find(r => r.id === data.receiptId);
      invariant(receipt && receipt.status === 'applied', 'RECEIPT_NOT_FOUND', 'Choose an install that is still in place.');
      invariant(this.latest(receipt.file, receipt.name)?.id === receipt.id, 'STALE_RECEIPT', 'Only the latest install of an entry can be rolled back.');
      const location = this.location(receipt.client, receipt.project); invariant(location && location.file === receipt.file, 'INVALID_PATH', 'This config file is no longer where Kiln installed the server.');
      const loaded = this.load(location), entry = at(loaded.data, [...location.table, receipt.name]);
      invariant(entry !== undefined && digest(entry) === receipt.hash, 'TARGET_DRIFTED', 'The entry changed after Kiln installed it. Rollback will not overwrite those changes.');
      const backup = receipt.previousHash === receipt.hash ? null : this.write(location, loaded, receipt.name, receipt.previous ?? undefined);
      writeJson(path.join(this.receiptsDir(), `${receipt.id}.json`), { ...receipt, status: 'rolled_back' });
      const restored = receipt.previous !== null && receipt.previousRevision !== null;
      this.wb.record('rolled_back', `Rolled back MCP server “${receipt.name}” in ${mcpLocationLabel(location)}`, receipt.itemId, receipt.previousRevision ?? receipt.revision);
      return this.receipt({ ...receipt, revision: receipt.previousRevision ?? receipt.revision, hash: receipt.previousHash, previous: entry, previousHash: receipt.hash, previousRevision: receipt.revision, status: restored ? 'applied' : 'rolled_back', method: 'rolled back', backup });
    });
  }

  // Import.
  /** Library MCP items by the identity of their current definition. */
  private libraryKeys() {
    const keys = new Map<string, string>();
    for (const item of this.wb.listItems().filter(i => i.kind === 'mcp')) { try { const { server } = parseMcp(this.wb.getRevision(item.id).content); if (server) keys.set(digest(mcpIdentity(server)), item.id); } catch { /* A damaged item is reported by library warnings. */ } }
    return keys;
  }
  /**
   * Every MCP server configured on this machine that the library does not hold: personal configs of each client, Claude's
   * per-project entries in ~/.claude.json, and the project configs of known projects (and of projects ~/.claude.json lists).
   * The same definition found in several places is one entry listing each place. Entries Kiln installed are left out. Literal
   * secrets are replaced by references before anything is shown or imported.
   */
  scan(): McpScan {
    const receipts = this.receipts(), libraryKeys = this.libraryKeys(), groups = new Map<string, McpScanEntry>(), files: McpScan['files'] = [];
    const claude = this.location('claude')!;
    let claudeProjects: string[] = [], claudeState: Record<string, unknown> = {};
    try { claudeState = this.load(claude).data; claudeProjects = isRecord(claudeState.projects) ? Object.keys(claudeState.projects) : []; } catch { /* Reported when the file itself is read below. */ }
    const projectRoots = [...new Set([...this.projects().map(p => p.root), ...claudeProjects.filter(p => path.isAbsolute(p)).map(p => path.resolve(p))])].filter(root => { try { return fs.statSync(root).isDirectory(); } catch { return false; } }).slice(0, 300);
    const add = (found: McpFound, name: string, value: unknown) => {
      if (this.latest(found.file, name, receipts)?.status === 'applied' && found.scope !== 'local') return;
      const read = fromNative(found.client, MCP_NAME.test(name) ? name : name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'server', value); if (!read) return;
      const { server, replaced } = scrubSecrets(read.server), key = digest(mcpIdentity(server));
      const group = groups.get(key) ?? { key, name: server.name, server, found: [], replaced: [], dropped: [], itemId: libraryKeys.get(key) ?? null };
      group.found.push(found); group.replaced = [...new Set([...group.replaced, ...replaced])]; group.dropped = [...new Set([...group.dropped, ...read.dropped])];
      groups.set(key, group);
    };
    const read = (location: McpLocation) => {
      try {
        const loaded = this.load(location); if (loaded.bytes) files.push({ client: location.client, file: location.file });
        const table = at(loaded.data, location.table); if (isRecord(table)) for (const [name, value] of Object.entries(table)) add({ client: location.client, scope: location.scope, project: location.project, file: location.file }, name, value);
      } catch (error) { files.push({ client: location.client, file: location.file, error: error instanceof Error ? error.message : String(error) }); }
    };
    for (const client of mcpClients) { const location = this.location(client); if (location) read(location); }
    if (isRecord(claudeState.projects)) for (const [project, state] of Object.entries(claudeState.projects)) {
      const servers = isRecord(state) ? state.mcpServers : undefined;
      if (isRecord(servers)) for (const [name, value] of Object.entries(servers)) add({ client: 'claude', scope: 'local', project: path.resolve(project), file: claude.file }, name, value);
    }
    for (const root of projectRoots) for (const client of mcpClients) read(this.location(client, root)!);
    const servers = [...groups.values()].sort((a, b) => Number(Boolean(a.itemId)) - Number(Boolean(b.itemId)) || a.name.localeCompare(b.name));
    return { servers, files };
  }
  /** Imports scanned servers as drafts, by the keys `scan` returned (or every new one with `all`). The configs are not touched. */
  importServers(input: unknown) {
    const data = z.object({ keys: z.array(hashSchema).max(1000).default([]), all: z.boolean().default(false), collection: z.string().max(200).default('MCP servers') }).parse(input);
    const scan = this.scan(), created: { id: string; title: string; revision: string }[] = [], skipped: { key: string; reason: string }[] = [];
    for (const key of data.all ? scan.servers.filter(s => !s.itemId).map(s => s.key) : data.keys) {
      const entry = scan.servers.find(s => s.key === key);
      if (!entry) { skipped.push({ key, reason: 'no longer found on this machine' }); continue; }
      if (entry.itemId) { skipped.push({ key, reason: 'already in the library' }); continue; }
      const places = [...new Set(entry.found.map(f => mcpClientLabel[f.client]))].join(', ');
      const item = this.wb.create({ title: entry.name, kind: 'mcp', description: entry.server.description ?? '', content: serialiseMcp(entry.server), collection: data.collection, tags: ['imported'], source: `local:${entry.found[0].file}`, licence: 'Unknown', files: {} }, undefined, false);
      this.wb.record('imported', `Imported MCP server “${entry.name}” (found in ${places})`, item.id, item.revision);
      created.push({ id: item.id, title: item.title, revision: item.revision });
    }
    return { created, skipped };
  }
}
