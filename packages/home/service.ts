import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { invariant } from '../domain/errors';
import { atomicWrite, digest, hash, noLinks, now, readJson, writeJson } from '../storage/files';
import { configCatalog } from './catalog';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser/lib/esm/main';

/** Which agent or shell reads the file. Drives the icon and the wording in the tab. */
export type HomeFileKind = 'claude' | 'agents' | 'codex' | 'copilot' | 'vscode' | 'powershell' | 'custom';
export type HomeFile = { scope?: string; template?: string; instruction?: boolean; key: string; kind: HomeFileKind; label: string; description: string; path: string; exists: boolean; size: number; modifiedAt: string | null; /** sha256 of the bytes on disk, null when missing. Save sends it back as `expect`. */ hash: string | null; /** Set when the file cannot be managed, for example because the path is a link. */ error?: string; /** Only files the user added can be removed from the list. */ removable: boolean };
export type HomeFileContent = { key: string; path: string; exists: boolean; /** Text with line endings normalised to LF and any byte-order mark removed. */ content: string; hash: string | null; eol: 'lf' | 'crlf'; bom: boolean; size: number; modifiedAt: string | null };
export type HomeBackup = { name: string; at: string; size: number };
export type HomeList = { home: string; files: HomeFile[] };
type Shell = 'pwsh' | 'powershell';
type Profiles = Partial<Record<Shell, { host: string; all: string }>>;
type Options = { home?: string; privateRoot?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; projects?: () => string[]; /** Finds each shell's profile paths. Defaults to asking the shells themselves; tests inject a stub. */ probe?: (shell: Shell) => Promise<{ host: string; all: string } | null> };

const TEXT_FILE = /\.(md|txt|ps1|psm1|json|jsonc|rules|ya?ml|toml|ini|cfg|conf|sh|bashrc|zshrc|gitconfig)$/i;
const LIMIT = 2_000_000, KEEP_BACKUPS = 30;
const keySchema = z.string().min(1).max(120);
const shellLabel: Record<Shell, string> = { pwsh: 'PowerShell 7', powershell: 'Windows PowerShell 5.1' };
/** Asks a shell where its profiles live, so redirected Documents folders and OneDrive are honoured. Null when the shell is not installed. */
export const probeShell = (shell: Shell) => new Promise<{ host: string; all: string } | null>(resolve => {
  const child = execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', '[pscustomobject]@{host=$PROFILE.CurrentUserCurrentHost; all=$PROFILE.CurrentUserAllHosts} | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (error, stdout) => {
    if (error) return resolve(null);
    try { resolve(z.object({ host: z.string().min(1), all: z.string().min(1) }).parse(JSON.parse(stdout.trim()))); } catch { resolve(null); }
  });
  child.on('error', () => resolve(null));
});

/** The instruction files agents read from the home folder, plus shell profiles: list, read, save with a backup, restore. Files outside the library are edited in place; Kiln keeps the last few versions privately. */
export class HomeFiles {
  readonly home: string;
  private readonly privateRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly probe: NonNullable<Options['probe']>;
  private profiles?: Promise<Profiles>;
  constructor(private options: Options = {}) {
    this.home = options.home ?? process.env.KILN_HOME ?? os.homedir(); this.privateRoot = options.privateRoot ?? path.join(os.homedir(), '.kiln'); this.platform = options.platform ?? process.platform; this.probe = options.probe ?? probeShell;
  }
  private configFile() { return path.join(this.privateRoot, 'home-files.json'); }
  private projects(): string[] {
    const file = path.join(this.privateRoot, 'config-projects.json');
    const saved = fs.existsSync(file) ? z.array(z.string()).parse(readJson(file)) : [];
    return [...new Set([...(this.options.projects?.() ?? []), ...saved].map(root => path.resolve(root)))];
  }
  addProject(input: unknown) {
    const { path: root } = z.object({ path: z.string().min(1) }).parse(input);
    invariant(path.isAbsolute(root), 'INVALID_PATH', 'Choose a project by its full path.'); noLinks(root);
    invariant(fs.existsSync(root) && fs.statSync(root).isDirectory(), 'INVALID_PATH', 'Choose an existing project folder.');
    writeJson(path.join(this.privateRoot, 'config-projects.json'), [...new Set([...this.projects(), path.resolve(root)])]);
    return { path: root };
  }
  private extras(): string[] {
    if (!fs.existsSync(this.configFile())) return [];
    try { return z.object({ files: z.array(z.string()).default([]) }).parse(readJson(this.configFile())).files; } catch { return []; }
  }
  private async shellProfiles(): Promise<Profiles> {
    this.profiles ??= (async () => {
      const shells: Shell[] = this.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh'];
      const found = await Promise.all(shells.map(async shell => [shell, await this.probe(shell)] as const));
      const result: Profiles = {};
      for (const [shell, value] of found) if (value) result[shell] = value;
      // Windows always ships PowerShell 5.1; if asking it failed, its documented default location still applies.
      if (this.platform === 'win32' && !result.powershell) { const folder = path.join(this.home, 'Documents', 'WindowsPowerShell'); result.powershell = { host: path.join(folder, 'Microsoft.PowerShell_profile.ps1'), all: path.join(folder, 'profile.ps1') }; }
      return result;
    })();
    return this.profiles;
  }
  private async entries(): Promise<Omit<HomeFile, 'exists' | 'size' | 'modifiedAt' | 'hash' | 'error'>[]> {
    const fixed = configCatalog(this.home, this.projects(), this.options.env ?? (this.options.home || process.env.KILN_HOME ? {} : process.env), this.platform);
    const profiles = await this.shellProfiles();
    const shells = (Object.entries(profiles) as [Shell, { host: string; all: string }][]).flatMap(([shell, paths]) => [
      { key: `${shell}-host`, kind: 'powershell' as const, label: `${shellLabel[shell]} profile`, description: `Runs every time ${shellLabel[shell]} starts in the console: aliases, functions, prompt and PATH changes.`, path: paths.host, removable: false },
      // The all-hosts profile is rare; listing it only when it exists keeps the tab short.
      ...(fs.existsSync(paths.all) ? [{ key: `${shell}-all`, kind: 'powershell' as const, label: `${shellLabel[shell]} profile · all hosts`, description: `Runs when ${shellLabel[shell]} starts in any host, including editor terminals.`, path: paths.all, removable: false }] : []),
    ]);
    const extras = this.extras().map(file => ({ key: `custom-${digest(file.toLowerCase()).slice(0, 16)}`, kind: 'custom' as const, label: path.basename(file), description: path.dirname(file), path: file, removable: true }));
    return [...fixed, ...shells, ...extras];
  }
  private stat(file: string): Pick<HomeFile, 'exists' | 'size' | 'modifiedAt' | 'hash' | 'error'> {
    try {
      noLinks(file);
      if (!fs.existsSync(file)) return { exists: false, size: 0, modifiedAt: null, hash: null };
      const stat = fs.statSync(file); invariant(stat.isFile(), 'INVALID_FILE', 'This path is not a regular file.');
      invariant(stat.size <= LIMIT, 'FILE_TOO_LARGE', 'Files over 2 MB are not edited in Kiln.');
      return { exists: true, size: stat.size, modifiedAt: stat.mtime.toISOString(), hash: hash(fs.readFileSync(file)) };
    } catch (error) { return { exists: false, size: 0, modifiedAt: null, hash: null, error: error instanceof Error ? error.message : String(error) }; }
  }
  async list(): Promise<HomeList> { return { home: this.home, files: (await this.entries()).map(entry => ({ ...entry, ...this.stat(entry.path) })) }; }
  private async entry(key: string) { const found = (await this.entries()).find(e => e.key === keySchema.parse(key)); invariant(found, 'FILE_UNKNOWN', 'This file is not in the list. Refresh and try again.'); return found; }
  private decode(bytes: Buffer) {
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const text = bytes.toString('utf8', bom ? 3 : 0);
    return { bom, eol: text.includes('\r\n') ? 'crlf' as const : 'lf' as const, content: text.replaceAll('\r\n', '\n') };
  }
  private encode(content: string, eol: 'lf' | 'crlf', bom: boolean) { return Buffer.from((bom ? '﻿' : '') + (eol === 'crlf' ? content.replaceAll('\n', '\r\n') : content), 'utf8'); }
  async read(key: string): Promise<HomeFileContent> {
    const entry = await this.entry(key); noLinks(entry.path);
    if (!fs.existsSync(entry.path)) return { key, path: entry.path, exists: false, content: '', hash: null, eol: 'lf', bom: false, size: 0, modifiedAt: null };
    const stat = fs.statSync(entry.path); invariant(stat.isFile(), 'INVALID_FILE', 'This path is not a regular file.'); invariant(stat.size <= LIMIT, 'FILE_TOO_LARGE', 'Files over 2 MB are not edited in Kiln.');
    const bytes = fs.readFileSync(entry.path);
    return { key, path: entry.path, exists: true, hash: hash(bytes), size: stat.size, modifiedAt: stat.mtime.toISOString(), ...this.decode(bytes) };
  }
  private backupDir(key: string) { return path.join(this.privateRoot, 'home-backups', key); }
  private keep(key: string, file: string, bytes: Buffer) {
    const dir = this.backupDir(key); fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, `${now().replaceAll(':', '-')}${path.extname(file) || '.txt'}`), bytes);
    for (const name of fs.readdirSync(dir).sort().reverse().slice(KEEP_BACKUPS)) fs.rmSync(path.join(dir, name), { force: true });
  }
  /** Writes the editor text back. `expect` is the hash the editor loaded (null for a file that did not exist); a mismatch means the file changed on disk meanwhile and nothing is written. The previous bytes are kept as a backup. */
  async save(input: unknown): Promise<HomeFileContent> {
    const data = z.object({ key: keySchema, expect: z.string().nullable(), content: z.string().max(LIMIT) }).parse(input);
    const entry = await this.entry(data.key); noLinks(entry.path);
    try {
      if (/\.toml$/i.test(entry.path)) parseToml(data.content);
      if (/\.jsonc?$/i.test(entry.path)) {
        if (entry.kind === 'vscode' || entry.path.endsWith('.jsonc')) {
          const errors: ParseError[] = []; parseJsonc(data.content, errors, { allowTrailingComma: true });
          invariant(!errors.length, 'INVALID_CONFIG', 'Invalid JSON configuration. Fix the syntax before saving.');
        } else JSON.parse(data.content);
      }
    } catch (error) { invariant(false, 'INVALID_CONFIG', `Configuration was not saved: ${error instanceof Error ? error.message : String(error)}`); }
    const current = fs.existsSync(entry.path) ? fs.readFileSync(entry.path) : null;
    invariant((current ? hash(current) : null) === data.expect, 'FILE_CHANGED', 'This file changed on disk since you opened it. Reload it, compare, then save again. Your text is still in the editor.');
    const shape = current ? this.decode(current) : { eol: 'lf' as const, bom: false };
    const bytes = this.encode(data.content.replaceAll('\r\n', '\n'), shape.eol, shape.bom);
    if (current && !current.equals(bytes)) this.keep(data.key, entry.path, current);
    atomicWrite(entry.path, bytes);
    return this.read(data.key);
  }
  async backups(key: string): Promise<HomeBackup[]> {
    await this.entry(key); const dir = this.backupDir(key);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().reverse().map(name => { const stamp = path.parse(name).name; return { name, at: stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/, '$1:$2:$3'), size: fs.statSync(path.join(dir, name)).size }; });
  }
  private backupFile(key: string, name: string) {
    invariant(/^[\w.-]+$/.test(name) && !name.includes('..'), 'INVALID_PATH', 'Unknown backup.');
    const file = path.join(this.backupDir(key), name); invariant(fs.existsSync(file), 'BACKUP_MISSING', 'This backup no longer exists.'); return file;
  }
  async backup(input: unknown): Promise<{ name: string; content: string }> {
    const data = z.object({ key: keySchema, name: z.string().min(1).max(80) }).parse(input); await this.entry(data.key);
    return { name: data.name, content: this.decode(fs.readFileSync(this.backupFile(data.key, data.name))).content };
  }
  /** Puts a kept version back. The version being replaced is kept too, so a restore is always reversible. */
  async restore(input: unknown): Promise<HomeFileContent> {
    const data = z.object({ key: keySchema, name: z.string().min(1).max(80), expect: z.string().nullable() }).parse(input);
    const { content } = await this.backup(data);
    return this.save({ key: data.key, expect: data.expect, content });
  }
  /** Adds any text file on this machine to the list, for example a project's CLAUDE.md. The file itself is untouched. */
  add(input: unknown): { key: string } {
    const { path: file } = z.object({ path: z.string().min(1).max(1000) }).parse(input);
    invariant(path.isAbsolute(file), 'INVALID_PATH', 'Choose a file by its full path.'); noLinks(file);
    invariant(fs.existsSync(file) && fs.statSync(file).isFile(), 'INVALID_FILE', 'Choose an existing file.');
    invariant(TEXT_FILE.test(file) || !path.extname(file), 'INVALID_FILE', 'Only text files (Markdown, PowerShell, JSON, YAML, TOML, INI, shell) can be edited here.');
    invariant(fs.statSync(file).size <= LIMIT, 'FILE_TOO_LARGE', 'Files over 2 MB are not edited in Kiln.');
    const resolved = path.resolve(file); const extras = this.extras();
    if (!extras.some(e => e.toLowerCase() === resolved.toLowerCase())) writeJson(this.configFile(), { files: [...extras, resolved] });
    return { key: `custom-${digest(resolved.toLowerCase()).slice(0, 16)}` };
  }
  /** Forgets a file the user added. Nothing on disk changes; its kept versions are removed. */
  async remove(input: unknown) {
    const { key } = z.object({ key: keySchema }).parse(input); const entry = await this.entry(key);
    invariant(entry.removable, 'NOT_REMOVABLE', 'Built-in files stay in the list.');
    writeJson(this.configFile(), { files: this.extras().filter(e => e.toLowerCase() !== entry.path.toLowerCase()) });
    fs.rmSync(this.backupDir(key), { recursive: true, force: true });
    return { key };
  }
}
