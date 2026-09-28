import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser/lib/esm/main';
import { codexAllows, skillMeta } from '../domain/invocation';
import { invariant } from '../domain/errors';
import { now } from '../storage/files';

/**
 * What a harness hands the model when a new session starts on this machine, estimated from files Kiln can read without running
 * anything (docs/SKILL_INVOCATION.md has the sources): the skill listing, instruction files, SessionStart hooks (listed, never
 * run, so their output is unknown), MCP servers (counted, not sized) and what is not published (the system prompt).
 * Files are re-read only when their size or modification time changes, so asking again after an install costs a few stats.
 */
export type Harness = 'claude' | 'codex' | 'copilot';
export type ContextSkill = {
  name: string; /** The skill's folder (a command's file for Claude's legacy commands). */ folder: string; /** Where it was found, as the user knows it: `~/.claude/skills`. */ where: string;
  scope: 'personal' | 'project'; /** In the listing the model gets. */ listed: boolean; /** Why it is not listed, or listed without its description. */ reason?: string;
  chars: number; tokens: number;
};
export type ContextFile = { path: string; label: string; chars: number; tokens: number; /** How it is reached, when not directly: "imported by ~/.claude/CLAUDE.md". */ note?: string; truncated?: boolean };
export type ContextHook = { command: string; source: string; matcher?: string };
export type ContextServer = { name: string; source: string };
export type HarnessContext = {
  id: Harness; label: string; /** The divisor behind every estimate for this harness. */ charsPerToken: number; /** Its configuration folder exists. */ present: boolean;
  /** Skills listed plus instruction files: everything Kiln can size. */ tokens: number;
  skills: { rows: ContextSkill[]; tokens: number; budget: string };
  instructions: { files: ContextFile[]; tokens: number };
  hooks: { rows: ContextHook[]; limit: string };
  mcp: { rows: ContextServer[]; note: string };
  /** What loads but cannot be sized from here. */ unknown: string[];
};
export type SessionStart = { harnesses: HarnessContext[]; project: string | null; /** Project folders Kiln knows, for the picker. */ projects: string[]; computedAt: string };

const MAX_FILE = 4 * 1024 * 1024;
const label: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot CLI' };
/** Anthropic's glossary: about 3.5 characters per token for Claude. OpenAI and Codex itself use about 4. */
const perToken: Record<Harness, number> = { claude: 3.5, codex: 4, copilot: 4 };
const tokens = (chars: number, harness: Harness) => Math.ceil(chars / perToken[harness]);

type Options = { home: string; env: NodeJS.ProcessEnv; platform?: NodeJS.Platform; /** Project folders Kiln knows (enrolled and added). */ projects?: () => string[] };
export class SessionStartMeter {
  private files = new Map<string, { stamp: string; value: unknown }>();
  constructor(private options: Options) {}

  /** Reads and parses `file` once per size and modification time; null when missing, unreadable, too large or not a file. */
  private cached<T>(file: string, parse: (text: string) => T): T | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { this.files.delete(file); return null; }
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    const stamp = `${stat.size}:${stat.mtimeMs}`, hit = this.files.get(file);
    if (hit?.stamp === stamp) return hit.value as T;
    let value: T | null = null;
    try { value = parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
    this.files.set(file, { stamp, value }); return value;
  }
  private text(file: string) { return this.cached(file, text => text); }
  private json(file: string) { return this.cached(file, text => { const value = parseJsonc(text); return value && typeof value === 'object' ? value as Record<string, unknown> : null; }); }
  private toml(file: string) { return this.cached(file, text => parseToml(text) as Record<string, unknown>); }
  private dirs(folder: string) {
    try { return fs.readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name).sort(); } catch { return []; }
  }
  private mdFiles(folder: string) {
    try { return fs.readdirSync(folder, { withFileTypes: true }).filter(e => (e.isFile() || e.isSymbolicLink()) && /\.md$/i.test(e.name)).map(e => e.name).sort(); } catch { return []; }
  }
  /** `~/…` for paths in the home folder, so rows read as the user knows them. */
  private show(file: string) { const home = path.resolve(this.options.home), full = path.resolve(file); return full === home ? '~' : full.startsWith(home + path.sep) ? `~/${path.relative(home, full).split(path.sep).join('/')}` : full; }
  private get dirsOf() {
    const { env, home } = this.options;
    return { claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), codex: env.CODEX_HOME || path.join(home, '.codex'), copilot: env.COPILOT_HOME || path.join(home, '.copilot') };
  }

  measure(input: unknown = {}): SessionStart {
    const { project } = z.object({ project: z.string().min(1).optional() }).parse(input ?? {});
    if (project) invariant(path.isAbsolute(project) && fs.existsSync(project) && fs.statSync(project).isDirectory(), 'INVALID_PATH', 'Choose an existing project folder.');
    const root = project ? path.resolve(project) : null;
    const projects = [...new Set((this.options.projects?.() ?? []).map(p => path.resolve(p)))].filter(p => fs.existsSync(p)).sort((a, b) => a.localeCompare(b));
    return { harnesses: [this.claude(root), this.codex(root), this.copilot(root)], project: root, projects, computedAt: now() };
  }

  // Skills.
  /**
   * One skill folder, as a harness lists it. `entry` formats the listed line from name, description and SKILL.md path; `hidden`
   * says why it is left out (or null); duplicates by name keep the first found, as each client's precedence does.
   */
  private skillRows(harness: Harness, roots: { folder: string; scope: 'personal' | 'project'; commands?: boolean }[], entry: (name: string, description: string, file: string) => string, hidden: (meta: ReturnType<typeof skillMeta> & { folder: string; file: string; name: string }) => { reason: string; chars?: number } | null) {
    const rows: ContextSkill[] = [], seen = new Set<string>();
    for (const root of roots) {
      const names = root.commands ? this.mdFiles(root.folder) : this.dirs(root.folder);
      for (const name of names) {
        const folder = path.join(root.folder, name), file = root.commands ? folder : path.join(folder, 'SKILL.md');
        const content = this.text(file); if (content === null) continue;
        const meta = skillMeta(content), skill = meta.name || (root.commands ? name.replace(/\.md$/i, '') : name);
        const line = entry(skill, [meta.description, harness === 'claude' ? meta.whenToUse : ''].filter(Boolean).join(' '), file);
        const base = { name: skill, folder, where: this.show(root.folder), scope: root.scope };
        if (seen.has(skill)) { rows.push({ ...base, listed: false, reason: 'Same name as another skill here; counted once', chars: 0, tokens: 0 }); continue; }
        seen.add(skill);
        const off = hidden({ ...meta, folder, file, name: skill });
        const chars = off ? off.chars ?? 0 : line.length;
        rows.push({ ...base, listed: !off || Boolean(off.chars), ...(off ? { reason: off.reason } : {}), chars, tokens: tokens(chars, harness) });
      }
    }
    return rows;
  }
  /** The project folder and each folder above it up to the repository root (the Git root), nearest first. */
  private upToRepository(project: string) {
    const chain: string[] = [];
    for (let dir = project; ; dir = path.dirname(dir)) {
      chain.push(dir);
      if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
    }
    return fs.existsSync(path.join(chain.at(-1)!, '.git')) ? chain : [project];
  }
  /** Every folder from `project` up to the filesystem root, nearest first. */
  private ancestors(project: string) { const chain: string[] = []; for (let dir = project; ; dir = path.dirname(dir)) { chain.push(dir); if (path.dirname(dir) === dir) return chain; } }

  // Instruction files.
  private file(file: string, harness: Harness, note?: string, limit?: number): ContextFile | null {
    const content = this.text(file); if (content === null || !content.trim()) return null;
    const chars = limit !== undefined ? Math.min(limit, content.length) : content.length;
    return { path: file, label: this.show(file), chars, tokens: tokens(chars, harness), ...(note ? { note } : {}), ...(limit !== undefined && content.length > limit ? { truncated: true } : {}) };
  }
  /** A CLAUDE.md and the files it imports with `@path`, up to four hops, each once. Code spans and fenced blocks are skipped. */
  private withImports(file: string, into: ContextFile[], seen: Set<string>, note?: string, depth = 0) {
    const resolved = path.resolve(file); if (seen.has(resolved)) return; seen.add(resolved);
    const row = this.file(resolved, 'claude', note); if (!row) return;
    into.push(row);
    if (depth >= 4) return;
    const text = (this.text(resolved) ?? '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const match of text.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+[\w\-/])/g)) {
      const target = match[1].startsWith('~/') ? path.join(this.options.home, match[1].slice(2)) : path.resolve(path.dirname(resolved), match[1]);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) this.withImports(target, into, seen, `imported by ${this.show(resolved)}`, depth + 1);
    }
  }
  /** Rules files without `paths:` front-matter, which load at launch like CLAUDE.md. */
  private rules(folder: string, into: ContextFile[]) {
    for (const name of this.mdFiles(folder)) {
      const file = path.join(folder, name), content = this.text(file);
      if (content === null || /^paths\s*:/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '')) continue;
      const row = this.file(file, 'claude', 'rule'); if (row) into.push(row);
    }
  }

  // Hooks and MCP servers.
  /** SessionStart hooks in a settings or hooks file of any of the three formats: `hooks.SessionStart` (or `sessionStart`) entries with `command`, `bash` or `powershell`, nested under `hooks` for Claude and Codex. */
  private hooks(file: string): ContextHook[] {
    const value = this.json(file), hooks = value?.hooks; if (!hooks || typeof hooks !== 'object') return [];
    const key = Object.keys(hooks).find(k => k.toLowerCase() === 'sessionstart'), list = key ? (hooks as Record<string, unknown>)[key] : null;
    const rows: ContextHook[] = [];
    const visit = (entries: unknown, matcher?: string) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (Array.isArray(e.hooks)) { visit(e.hooks, typeof e.matcher === 'string' && e.matcher ? e.matcher : matcher); continue; }
        const command = [e.command, e.bash, e.powershell, e.prompt].find(v => typeof v === 'string' && v.trim()) as string | undefined;
        rows.push({ command: command ?? `(${typeof e.type === 'string' ? e.type : 'hook'} without a command)`, source: this.show(file), ...(matcher ? { matcher } : {}) });
      }
    };
    visit(list); return rows;
  }
  private servers(value: unknown, source: string): ContextServer[] {
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().map(name => ({ name, source: this.show(source) })) : [];
  }
  private total(skills: ContextSkill[], files: ContextFile[]) { return skills.reduce((n, s) => n + s.tokens, 0) + files.reduce((n, f) => n + f.tokens, 0); }

  private claude(project: string | null): HarnessContext {
    const dir = this.dirsOf.claude, home = this.options.home;
    // skillOverrides: personal settings, then the project's shared and local settings; the later file wins for a name.
    const settingsFiles = [path.join(dir, 'settings.json'), ...(project ? [path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')] : [])];
    const overrides: Record<string, string> = {}; let maxChars = 1536;
    for (const file of settingsFiles) {
      const settings = this.json(file); if (!settings) continue;
      if (settings.skillOverrides && typeof settings.skillOverrides === 'object') Object.assign(overrides, settings.skillOverrides);
      if (typeof settings.skillListingMaxDescChars === 'number' && settings.skillListingMaxDescChars > 0) maxChars = settings.skillListingMaxDescChars;
    }
    const roots = [{ folder: path.join(dir, 'skills'), scope: 'personal' as const }, { folder: path.join(dir, 'commands'), scope: 'personal' as const, commands: true },
      ...(project ? [{ folder: path.join(project, '.claude', 'skills'), scope: 'project' as const }, { folder: path.join(project, '.claude', 'commands'), scope: 'project' as const, commands: true }] : [])];
    const skills = this.skillRows('claude', roots, (name, description) => `- ${name}: ${description.slice(0, maxChars)}`, meta => {
      const override = overrides[meta.name];
      if (override === 'off') return { reason: 'Turned off in settings (skillOverrides)' };
      if (override === 'user-invocable-only') return { reason: 'You only, in settings (skillOverrides)' };
      if (!meta.model) return { reason: 'You only: disable-model-invocation' };
      if (override === 'name-only') return { reason: 'Name only, in settings (skillOverrides)', chars: `- ${meta.name}`.length };
      return null;
    });
    const files: ContextFile[] = [], seen = new Set<string>();
    this.withImports(path.join(dir, 'CLAUDE.md'), files, seen);
    this.rules(path.join(dir, 'rules'), files);
    if (project) {
      const before = files.length;
      for (const folder of this.ancestors(project).reverse()) for (const name of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
        const file = path.join(folder, name); if (path.resolve(file) !== path.resolve(dir, 'CLAUDE.md')) this.withImports(file, files, seen);
      }
      const found = files.length > before;
      this.rules(path.join(project, '.claude', 'rules'), files);
      // AGENTS.md only when no CLAUDE.md is found in the project or above it.
      if (!found) { const agents = this.file(path.join(project, 'AGENTS.md'), 'claude', 'read because there is no CLAUDE.md'); if (agents) files.push(agents); }
      // Auto memory: the first 200 lines or 25 KB of the project's MEMORY.md.
      const memory = path.join(dir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'MEMORY.md'), text = this.text(memory);
      if (text?.trim()) { const head = text.split('\n').slice(0, 200).join('\n').slice(0, 25_000); files.push({ path: memory, label: this.show(memory), chars: head.length, tokens: tokens(head.length, 'claude'), note: 'auto memory: first 200 lines or 25 KB', ...(head.length < text.length ? { truncated: true } : {}) }); }
    }
    const hooks = settingsFiles.flatMap(file => this.hooks(file));
    const state = this.json(this.options.env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json'));
    const projectsState = state?.projects && typeof state.projects === 'object' ? state.projects as Record<string, { mcpServers?: unknown }> : {};
    const mcp = [...this.servers(state?.mcpServers, path.join(home, '.claude.json')), ...(project ? [...this.servers(projectsState[project]?.mcpServers, path.join(home, '.claude.json')), ...this.servers(this.json(path.join(project, '.mcp.json'))?.mcpServers, path.join(project, '.mcp.json'))] : [])];
    const style = settingsFiles.map(file => this.json(file)?.outputStyle).filter((s): s is string => typeof s === 'string').at(-1);
    return {
      id: 'claude', label: label.claude, charsPerToken: perToken.claude, present: fs.existsSync(dir), tokens: this.total(skills, files),
      skills: { rows: skills, tokens: skills.reduce((n, s) => n + s.tokens, 0), budget: `The listing is capped at 1% of the context window; past it, descriptions of the skills you use least are dropped. Each entry is cut at ${maxChars.toLocaleString('en')} characters.` },
      instructions: { files, tokens: files.reduce((n, f) => n + f.tokens, 0) },
      hooks: { rows: hooks, limit: 'Output is added to context, up to 10,000 characters per hook.' },
      mcp: { rows: mcp, note: 'Only tool names and server instructions load at start (tool search is on by default).' },
      unknown: ['System prompt: size not published.', ...(style && style !== 'default' ? [`Output style “${style}”: its instructions load too.`] : []), 'Plugin skills, hooks and MCP servers are not counted.'],
    };
  }

  private codex(project: string | null): HarnessContext {
    const dir = this.dirsOf.codex, home = this.options.home;
    const config = this.toml(path.join(dir, 'config.toml'));
    // [[skills.config]] entries with enabled = false, by SKILL.md path (or its folder) or by name.
    const off = (Array.isArray((config?.skills as { config?: unknown })?.config) ? (config!.skills as { config: Record<string, unknown>[] }).config : []).filter(entry => entry.enabled === false);
    const disabled = (name: string, file: string) => off.some(entry => entry.name === name || (typeof entry.path === 'string' && [file, path.dirname(file)].includes(path.resolve(entry.path.replace(/^~(?=\/|\\)/, home)))));
    const roots = [{ folder: path.join(home, '.agents', 'skills'), scope: 'personal' as const }, { folder: path.join(dir, 'skills'), scope: 'personal' as const },
      ...(project ? [...this.upToRepository(project).map(folder => ({ folder: path.join(folder, '.agents', 'skills'), scope: 'project' as const })), { folder: path.join(project, '.codex', 'skills'), scope: 'project' as const }] : [])];
    const skills = this.skillRows('codex', roots, (name, description, file) => `- ${name}: ${description.length > 1024 ? description.slice(0, 1024) + '...' : description} (file: ${file})`, meta => {
      if (disabled(meta.name, meta.file)) return { reason: 'Turned off in config.toml' };
      const policy = this.text(path.join(meta.folder, 'agents', 'openai.yaml'));
      return policy !== null && !codexAllows(policy) ? { reason: 'You only: allow_implicit_invocation: false' } : null;
    });
    const files: ContextFile[] = [];
    const global = this.file(path.join(dir, 'AGENTS.override.md'), 'codex') ?? this.file(path.join(dir, 'AGENTS.md'), 'codex'); if (global) files.push(global);
    if (project) {
      // From the repository root down to the project, one file per folder, until project_doc_max_bytes (32 KiB) is reached.
      let left = typeof config?.project_doc_max_bytes === 'number' ? config.project_doc_max_bytes : 32 * 1024;
      const fallbacks = Array.isArray(config?.project_doc_fallback_filenames) ? (config!.project_doc_fallback_filenames as unknown[]).filter((n): n is string => typeof n === 'string') : [];
      for (const folder of this.upToRepository(project).reverse()) {
        if (left <= 0) break;
        const row = ['AGENTS.override.md', 'AGENTS.md', ...fallbacks].map(name => this.file(path.join(folder, name), 'codex', undefined, left)).find(Boolean);
        if (row) { files.push(row); left -= row.chars; }
      }
    }
    const hookFiles = [path.join(dir, 'hooks.json'), ...(project ? [path.join(project, '.codex', 'hooks.json')] : [])];
    const mcp = [...this.servers(config?.mcp_servers, path.join(dir, 'config.toml')), ...(project ? this.servers(this.toml(path.join(project, '.codex', 'config.toml'))?.mcp_servers, path.join(project, '.codex', 'config.toml')) : [])];
    return {
      id: 'codex', label: label.codex, charsPerToken: perToken.codex, present: fs.existsSync(dir), tokens: this.total(skills, files),
      skills: { rows: skills, tokens: skills.reduce((n, s) => n + s.tokens, 0), budget: 'The listing is capped at 2% of the context window (8,000 characters when it is unknown); descriptions are shortened first, then skills left out.' },
      instructions: { files, tokens: files.reduce((n, f) => n + f.tokens, 0) },
      hooks: { rows: hookFiles.flatMap(file => this.hooks(file)), limit: 'Output is added as developer context, up to about 2,500 tokens per hook.' },
      mcp: { rows: mcp, note: 'Whether tool definitions load at start is not documented; not counted.' },
      unknown: ['System prompt and Codex’s bundled system skills: size not published.', 'Hooks written inside config.toml are not listed.'],
    };
  }

  private copilot(project: string | null): HarnessContext {
    const dir = this.dirsOf.copilot, home = this.options.home;
    const roots = [{ folder: path.join(dir, 'skills'), scope: 'personal' as const }, { folder: path.join(home, '.agents', 'skills'), scope: 'personal' as const },
      ...(project ? ['.github', '.agents', '.claude'].map(name => ({ folder: path.join(project, name, 'skills'), scope: 'project' as const })) : [])];
    const skills = this.skillRows('copilot', roots, (name, description) => `- ${name}: ${description.slice(0, 1024)}`, meta => meta.model ? null : { reason: 'You only: disable-model-invocation (whether Copilot still lists it is not documented)' });
    const files: ContextFile[] = [];
    const personal = this.file(path.join(dir, 'copilot-instructions.md'), 'copilot'); if (personal) files.push(personal);
    if (project) {
      const places = [...new Set([this.upToRepository(project).at(-1)!, project])];
      for (const folder of places) {
        for (const name of ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md', path.join('.github', 'copilot-instructions.md')]) { const row = this.file(path.join(folder, name), 'copilot'); if (row) files.push(row); }
        const instructions = path.join(folder, '.github', 'instructions');
        const walk = (d: string, depth: number): void => { if (depth > 6) return; let entries: fs.Dirent[] = []; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f, depth + 1); else if (/\.instructions\.md$/i.test(e.name)) { const row = this.file(f, 'copilot'); if (row) files.push(row); } } };
        walk(instructions, 0);
      }
    }
    const hookFiles = [...this.jsonIn(path.join(dir, 'hooks')), path.join(dir, 'settings.json'), ...(project ? [...this.jsonIn(path.join(project, '.github', 'hooks')), path.join(project, '.github', 'copilot', 'settings.json'), path.join(project, '.github', 'copilot', 'settings.local.json')] : [])];
    const mcpOf = (file: string) => { const value = this.json(file); return this.servers(value?.mcpServers ?? value?.servers, file); };
    return {
      id: 'copilot', label: label.copilot, charsPerToken: perToken.copilot, present: fs.existsSync(dir), tokens: this.total(skills, files),
      skills: { rows: skills, tokens: skills.reduce((n, s) => n + s.tokens, 0), budget: 'No listing budget is documented. Copilot reads each skill’s name and description to decide when to use it.' },
      instructions: { files, tokens: files.reduce((n, f) => n + f.tokens, 0) },
      hooks: { rows: hookFiles.flatMap(file => this.hooks(file)), limit: 'A sessionStart hook can add context; no size limit is documented.' },
      mcp: { rows: [...mcpOf(path.join(dir, 'mcp-config.json')), ...(project ? mcpOf(path.join(project, '.github', 'mcp.json')) : [])], note: 'Whether tool definitions load at start is not documented; not counted.' },
      unknown: ['System prompt: size not published.', 'Skills turned off with “copilot skill disable” are not visible to Kiln.'],
    };
  }
  private jsonIn(folder: string) { try { return fs.readdirSync(folder).filter(n => /\.json$/i.test(n)).sort().map(n => path.join(folder, n)); } catch { return []; } }
}
