import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Item, Receipt } from '../protocol/schema';
import { atomicWrite, now } from '../storage/files';
import { addTokens, costAt, defaultPrices, noTokens, normaliseModel, priceFor, pricesChecked, totalTokens, type PriceTable, type TokenCounts } from './prices';
import { claudeLine, codexLine, localDay, newEntry, type FileEntry, type Harness, type Signal, type SkillUse } from './transcripts';

/**
 * The Usage view's data: skill use and token spend read from this machine's own Claude Code and Codex session logs, plus Kiln's
 * own agent runs. Nothing here calls an API or writes to the library repository; the cache and any price overrides live in the
 * library's machine-private folder (`<local>/usage/`), and only counts, names, folders, models and days are kept from the logs.
 *
 * Logs can run to gigabytes, so reading is incremental: each file's size, modification time and the byte offset of its last
 * complete line are remembered, a changed file is read on from there, and a pass stops after a byte and time budget (the
 * desktop asks again until `complete`). Reads are streamed in 1 MB chunks with the event loop free between them.
 */
export type ScanStatus = { files: number; bytes: number; pending: number; complete: boolean; scannedAt: string | null; roots: { claude: string; codex: string } };
/** One skill as the logs saw it: a library item when it maps to one, or an unmanaged name. Counts are for the chosen window. */
export type SkillRow = {
  key: string; name: string; itemId: string | null; title: string; status: Item['status'] | null; harnesses: Harness[];
  uses: number; /** Uses in the window before this one, for the trend. */ previous: number; total: number; /** Uses only inferred (a SKILL.md read), in the window. */ inferred: number;
  signals: Signal[]; lastUsed: string | null; activeDays: number; projects: string[]; /** Uses per day for the last 30 days, oldest first. */ daily: number[];
  /** The skill's folder as the logs name it, for import. */ folder: string | null; /** Not in the library and its folder holds a SKILL.md Kiln can import. */ importable: boolean;
  /** Session tokens attributed to this skill: each session's tokens split evenly among the skills used in it. Not exact. */ attributed: TokenCounts; attributedCost: number | null;
};
export type UnusedRow = { itemId: string; title: string; status: Item['status']; copies: number; lastUsed: string | null };
export type SpendRow = { key: string; label: string; tokens: TokenCounts; /** Estimated dollars for the priced part; null when nothing in it has a price. */ cost: number | null; /** Tokens with no price in the table. */ unpriced: number; sessions?: number; runs?: number };
export type UsageReport = {
  days: number; since: string | null; scan: ScanStatus; skills: SkillRow[]; unused: UnusedRow[];
  spend: { total: SpendRow; byModel: SpendRow[]; byProject: SpendRow[]; byHarness: SpendRow[]; /** All time, newest first. */ byMonth: SpendRow[]; kiln: { total: SpendRow; byKind: SpendRow[]; byItem: SpendRow[] } };
  prices: { table: PriceTable; edited: string[]; checked: string };
};
export type ItemUsage = { itemId: string; days: number; uses: number; total: number; lastUsed: string | null; activeDays: number; projects: number; inferred: number };
/** What the report needs from the library: skills with the names they install as, and where Kiln installed them. */
export type LibraryView = { skills: { id: string; title: string; status: Item['status']; names: string[] }[]; /** Every item's title, for Kiln's runs. */ titles: Record<string, string>; receipts: Receipt[]; /** Copies of library items on this machine; only the report's `unused` list needs them. */ copies?: () => { itemId: string }[] };

type Cache = { schemaVersion: 1; scannedAt: string | null; files: Record<string, FileEntry> };
type Options = { local: string; home: string; env: NodeJS.ProcessEnv };
type JobUsage = { kind: string; provider: string; model: string; itemId: string; day: string; tokens: TokenCounts };

const CHUNK = 1024 * 1024;
const DAY = 86_400_000;
const SPARK = 30;
/** Keys compare across platforms: forward slashes, no trailing slash, Windows paths without case. */
const folderKey = (folder: string) => { const f = folder.replace(/[\\/]+$/, '').replaceAll('\\', '/'); return /^[a-z]:\//i.test(f) ? f.toLowerCase() : f; };
const nameKey = (name: string) => name.trim().toLowerCase();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

export class UsageService {
  private cache?: Cache;
  private running: Promise<ScanStatus> | null = null;
  /** When the cache was last written; a pass that leaves logs unread saves at most every few seconds (see `pass`). */
  private savedAt = 0;
  private jobs = new Map<string, { mtimeMs: number; usage: JobUsage | null }>();
  constructor(private options: Options) {}

  get folder() { return path.join(this.options.local, 'usage'); }
  /** Where Claude Code and Codex keep their logs here: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` when set, as the clients do. */
  get roots() {
    const { env, home } = this.options;
    return { claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'), codex: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'sessions') };
  }
  private load(): Cache {
    if (this.cache) return this.cache;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.folder, 'cache.json'), 'utf8')) as Cache;
      if (value?.schemaVersion === 1 && value.files && typeof value.files === 'object') return this.cache = value;
    } catch { /* No cache yet, or a damaged one: start over. */ }
    return this.cache = { schemaVersion: 1, scannedAt: null, files: {} };
  }
  private save() { atomicWrite(path.join(this.folder, 'cache.json'), JSON.stringify(this.load())); }

  /** Every log file, with its harness. Claude subagent files sit below their session's folder; Codex archives beside its sessions. */
  private list(): { file: string; harness: Harness }[] {
    const found: { file: string; harness: Harness }[] = [];
    const walk = (folder: string, harness: Harness, depth: number) => {
      let entries: fs.Dirent[]; try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory() && depth < 6) walk(full, harness, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && (harness === 'claude' || entry.name.startsWith('rollout-'))) found.push({ file: full, harness });
      }
    };
    const { claude, codex } = this.roots;
    walk(claude, 'claude', 0); walk(codex, 'codex', 0); walk(path.join(path.dirname(codex), 'archived_sessions'), 'codex', 0);
    return found;
  }
  /** Every log file with its size and modification time; files that vanish while listed are left out. */
  private stats() { return this.list().flatMap(({ file, harness }) => { try { const stat = fs.statSync(file); return [{ file, harness, stat }]; } catch { return []; } }); }
  status(listed = this.stats()): ScanStatus {
    const cache = this.load(); let bytes = 0, pending = 0, files = 0;
    for (const { file, stat } of listed) {
      files++; bytes += stat.size;
      const entry = cache.files[file];
      pending += !entry ? stat.size : entry.size === stat.size && entry.mtimeMs === stat.mtimeMs ? 0 : stat.size < entry.offset ? stat.size : stat.size - entry.offset;
    }
    return { files, bytes, pending, complete: pending === 0, scannedAt: cache.scannedAt, roots: this.roots };
  }

  /**
   * One pass over the logs: new and grown files are read on from where the last pass stopped, a file that shrank is read again
   * from the start (what it recorded is replaced), and a file that disappeared keeps what it recorded. Stops after `maxBytes` or
   * `maxMs`, with `complete: false` if anything is left. Concurrent calls share the pass that is running.
   */
  scan(input: unknown = {}): Promise<ScanStatus> {
    const { maxBytes, maxMs } = z.object({ maxBytes: z.number().int().positive().default(512 * CHUNK), maxMs: z.number().int().positive().default(1000) }).parse(input ?? {});
    return this.running ??= this.pass(maxBytes, maxMs).finally(() => { this.running = null; });
  }
  /** Scans until nothing is left (the CLI). */
  async scanAll() { let status = await this.scan({ maxBytes: 2 ** 40, maxMs: 2 ** 30 }); while (!status.complete) status = await this.scan({ maxBytes: 2 ** 40, maxMs: 2 ** 30 }); return status; }

  private async pass(maxBytes: number, maxMs: number): Promise<ScanStatus> {
    // The log tree is walked and stat'ed once per pass; the status at the end uses the same listing.
    const cache = this.load(), started = Date.now(), listed = this.stats(), present = new Set(listed.map(f => f.file));
    let budget = maxBytes, changed = false;
    for (const [file, entry] of Object.entries(cache.files)) if (!present.has(file) && !entry.gone) { entry.gone = true; changed = true; }
    // Newest first, so a first scan shows recent weeks early.
    const work = listed
      .filter(({ file, stat }) => { const e = cache.files[file]; return !e || e.gone || e.size !== stat.size || e.mtimeMs !== stat.mtimeMs; })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const { file, harness, stat } of work) {
      if (budget <= 0 || Date.now() - started > maxMs) break;
      let entry = cache.files[file];
      if (!entry || entry.harness !== harness || stat.size < entry.offset) entry = cache.files[file] = newEntry(harness);
      entry.gone = undefined;
      const read = await this.read(file, entry, stat.size, entry.offset + budget, started, maxMs);
      budget -= read.bytes; changed = true;
      entry.size = stat.size; entry.mtimeMs = stat.mtimeMs;
      // A file only partly read keeps a stamp that cannot match, so the next pass carries on with it. One read to its end is done,
      // even when its last line is still being written: that line is read once the file changes again.
      if (!read.reached) entry.mtimeMs = -1;
    }
    const status = this.status(listed);
    // The whole cache is one JSON file, so it is written when a scan finishes and otherwise at most every 5 seconds: the desktop
    // asks for a pass after another while logs remain, and rewriting megabytes each time cost more than the pass itself.
    if (changed) { cache.scannedAt = status.scannedAt = now(); if (status.complete || Date.now() - this.savedAt >= 5000) { this.save(); this.savedAt = Date.now(); } }
    return status;
  }
  /**
   * Reads complete lines from `entry.offset`, handing each to its harness's parser, until `size` or, at the next line boundary,
   * `soft` bytes or the time budget. The budget never stops a pass inside a line, so a line longer than it still moves on.
   */
  private async read(file: string, entry: FileEntry, size: number, soft: number, started: number, maxMs: number) {
    const handle = await fs.promises.open(file, 'r');
    const parse = entry.harness === 'claude' ? claudeLine : codexLine, buffer = Buffer.allocUnsafe(CHUNK);
    let position = entry.offset, lineStart = entry.offset, pieces: Buffer[] = [], total = 0;
    try {
      while (position < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - position), position);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        let from = 0;
        for (let nl = chunk.indexOf(10, from); nl !== -1; nl = chunk.indexOf(10, from)) {
          const piece = chunk.subarray(from, nl), line = pieces.length ? Buffer.concat([...pieces, piece]) : piece;
          pieces = [];
          if (line.length > 1) parse(entry, line, lineStart);
          lineStart = position + nl + 1; from = nl + 1;
        }
        // Keep the unfinished line; copied, because the buffer is reused.
        if (from < bytesRead) pieces.push(Buffer.from(chunk.subarray(from)));
        position += bytesRead; total += bytesRead;
        entry.offset = lineStart;
        if (!pieces.length && (position >= soft || Date.now() - started > maxMs)) break;
        await tick();
      }
    } finally { await handle.close(); }
    return { bytes: total, reached: position >= size };
  }

  /** Price overrides saved on this machine, over the defaults in prices.ts. `set` replaces them (an empty object restores the defaults). */
  prices(input: unknown = {}) {
    const priceSchema = z.object({ input: z.number().min(0), cached: z.number().min(0), cacheWrite: z.number().min(0), cacheWrite1h: z.number().min(0), output: z.number().min(0) });
    const { set } = z.object({ set: z.record(z.string().trim().min(1).max(120), priceSchema).optional() }).parse(input ?? {});
    const file = path.join(this.folder, 'prices.json');
    if (set) atomicWrite(file, JSON.stringify(Object.fromEntries(Object.entries(set).map(([k, v]) => [normaliseModel(k), v])), null, 2) + '\n');
    let edited: PriceTable = {};
    try { edited = z.record(z.string(), priceSchema).parse(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { edited = {}; }
    return { table: { ...defaultPrices, ...edited } as PriceTable, edited: Object.keys(edited), checked: pricesChecked };
  }

  /** Kiln's own agent runs (`<local>/agent-jobs`), each read once per modification. */
  private agentJobs(): JobUsage[] {
    const folder = path.join(this.options.local, 'agent-jobs'), seen = new Set<string>();
    let names: string[] = []; try { names = fs.readdirSync(folder).filter(n => n.endsWith('.json')); } catch { return []; }
    for (const name of names) {
      const file = path.join(folder, name); seen.add(file);
      let mtimeMs = 0; try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      if (this.jobs.get(file)?.mtimeMs === mtimeMs) continue;
      let usage: JobUsage | null = null;
      try {
        const job = JSON.parse(fs.readFileSync(file, 'utf8'));
        const u = job?.usage;
        if (u && typeof u === 'object') {
          const input = Number(u.input) || 0, cached = Number(u.cached) || 0;
          // Codex reports input with the cached part in it; Claude Code reports them apart.
          usage = { kind: String(job.kind ?? 'run'), provider: String(job.provider ?? 'codex'), model: String(job.model || 'unknown'), itemId: String(job.itemId ?? ''), day: localDay(job.startedAt ?? ''),
            tokens: { ...noTokens(), input: job.provider === 'claude' ? input : Math.max(0, input - cached), cached, output: Number(u.output) || 0, reasoning: Number(u.reasoning) || 0 } };
        }
      } catch { usage = null; }
      this.jobs.set(file, { mtimeMs, usage });
    }
    for (const file of this.jobs.keys()) if (!seen.has(file)) this.jobs.delete(file);
    return [...this.jobs.values()].flatMap(j => j.usage ? [j.usage] : []);
  }

  /** Every recorded use once (a use copied into a forked session keeps its first file), with its session and project. */
  private uses() {
    const cache = this.load(), seen = new Set<string>(), out: (SkillUse & { harness: Harness; session: string; project: string; day: string })[] = [];
    for (const file of Object.keys(cache.files).sort()) {
      const entry = cache.files[file];
      for (const use of entry.uses) {
        if (seen.has(use.key)) continue; seen.add(use.key);
        out.push({ ...use, harness: entry.harness, session: `${entry.harness}:${entry.session || file}`, project: entry.project, day: localDay(use.at) });
      }
    }
    return out;
  }
  /** Maps a logged skill to a library item: first by the folder Kiln installed it to, then by its name (a plugin's `plugin:name` by its last part). */
  private resolver(library: LibraryView) {
    const byFolder = new Map<string, string>(), byName = new Map<string, string>();
    const latest = new Map<string, Receipt>(); for (const r of library.receipts) latest.set(folderKey(r.destination), r);
    for (const [folder, r] of latest) if (r.status === 'applied') byFolder.set(folder, r.itemId);
    // Approved skills win a shared name, then the rest in library order.
    const ranked = [...library.skills].sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved'));
    for (const skill of ranked) for (const name of skill.names) if (name && !byName.has(nameKey(name))) byName.set(nameKey(name), skill.id);
    return (use: { name: string; folder: string }) => (use.folder && byFolder.get(folderKey(use.folder))) || byName.get(nameKey(use.name)) || byName.get(nameKey(use.name.split(':').at(-1) ?? '')) || null;
  }

  /**
   * The Usage view over the last `days` days (0: all time). Reads only the cache: call `scan` first for fresh numbers. Skills are
   * every skill seen in the logs; `unused` lists library skills with a copy on this machine and no use in the window.
   */
  report(input: unknown, library: LibraryView, status?: ScanStatus): UsageReport {
    const { days } = z.object({ days: z.number().int().min(0).max(3650).default(30) }).passthrough().parse(input ?? {});
    const today = Date.now(), since = days ? localDay(today - (days - 1) * DAY) : '', before = days ? localDay(today - (2 * days - 1) * DAY) : '';
    const inWindow = (day: string) => !since || day >= since;
    const spark = Array.from({ length: SPARK }, (_, i) => localDay(today - (SPARK - 1 - i) * DAY)), sparkIndex = new Map(spark.map((d, i) => [d, i]));
    const prices = this.prices(), table = prices.table, resolve = this.resolver(library), skills = new Map(library.skills.map(s => [s.id, s]));
    const rows = new Map<string, SkillRow & { days: Set<string>; projectSet: Set<string>; signalSet: Set<Signal>; harnessSet: Set<Harness> }>();
    const sessionSkills = new Map<string, Set<string>>();
    for (const use of this.uses()) {
      const itemId = resolve(use), item = itemId ? skills.get(itemId) : undefined, key = itemId ?? `name:${nameKey(use.name)}`;
      const row = rows.get(key) ?? rows.set(key, { key, name: use.name, itemId: itemId ?? null, title: item?.title ?? use.name, status: item?.status ?? null, harnesses: [], uses: 0, previous: 0, total: 0, inferred: 0, signals: [], lastUsed: null, activeDays: 0, projects: [], daily: spark.map(() => 0), folder: null, importable: false, attributed: noTokens(), attributedCost: null, days: new Set(), projectSet: new Set(), signalSet: new Set(), harnessSet: new Set() }).get(key)!;
      row.total++; row.harnessSet.add(use.harness);
      if (use.folder && (!row.folder || use.signal !== 'inferred')) row.folder = use.folder;
      if (!row.lastUsed || use.at > row.lastUsed) row.lastUsed = use.at;
      const index = sparkIndex.get(use.day); if (index !== undefined) row.daily[index]++;
      if (inWindow(use.day)) {
        row.uses++; row.days.add(use.day); row.signalSet.add(use.signal); if (use.project) row.projectSet.add(use.project);
        if (use.signal === 'inferred') row.inferred++;
      } else if (days && use.day >= before) row.previous++;
      (sessionSkills.get(use.session) ?? sessionSkills.set(use.session, new Set()).get(use.session)!).add(key);
    }

    const row = (key: string, label: string): SpendRow => ({ key, label, tokens: noTokens(), cost: null, unpriced: 0 });
    // Each model is looked up in the price table once: there are a few models and a great many day buckets.
    const looked = new Map<string, ReturnType<typeof priceFor>>();
    const price = (model: string) => { let found = looked.get(model); if (found === undefined) looked.set(model, found = priceFor(model, table)); return found; };
    const estimateCost = (model: string, tokens: TokenCounts) => costAt(price(model)?.price, tokens);
    const add = (target: SpendRow, model: string, tokens: TokenCounts) => {
      addTokens(target.tokens, tokens);
      const cost = estimateCost(model, tokens);
      if (cost === null) target.unpriced += totalTokens(tokens); else target.cost = (target.cost ?? 0) + cost;
    };
    const group = (map: Map<string, SpendRow>, key: string, label = key) => map.get(key) ?? map.set(key, row(key, label)).get(key)!;
    const total = row('total', 'All sessions'), byModel = new Map<string, SpendRow>(), byProject = new Map<string, SpendRow>(), byHarness = new Map<string, SpendRow>(), byMonth = new Map<string, SpendRow>();
    const sessions = new Map<string, { tokens: TokenCounts; cost: number; priced: boolean }>(), projectSessions = new Map<string, Set<string>>(), modelSessions = new Map<string, Set<string>>();
    for (const [file, entry] of Object.entries(this.load().files)) {
      const session = `${entry.harness}:${entry.session || file}`;
      for (const bucket of Object.values(entry.buckets)) {
        add(group(byMonth, bucket.day.slice(0, 7)), bucket.model, bucket.tokens);
        if (!inWindow(bucket.day)) continue;
        const model = price(bucket.model)?.key ?? normaliseModel(bucket.model);
        add(total, bucket.model, bucket.tokens); add(group(byModel, model), bucket.model, bucket.tokens);
        add(group(byProject, entry.project || '(unknown folder)'), bucket.model, bucket.tokens); add(group(byHarness, entry.harness, entry.harness === 'claude' ? 'Claude Code' : 'Codex'), bucket.model, bucket.tokens);
        (projectSessions.get(entry.project || '(unknown folder)') ?? projectSessions.set(entry.project || '(unknown folder)', new Set()).get(entry.project || '(unknown folder)')!).add(session);
        (modelSessions.get(model) ?? modelSessions.set(model, new Set()).get(model)!).add(session);
        const s = sessions.get(session) ?? sessions.set(session, { tokens: noTokens(), cost: 0, priced: false }).get(session)!;
        addTokens(s.tokens, bucket.tokens); const cost = estimateCost(bucket.model, bucket.tokens); if (cost !== null) { s.cost += cost; s.priced = true; }
      }
    }
    for (const [key, r] of byProject) r.sessions = projectSessions.get(key)?.size ?? 0;
    for (const [key, r] of byModel) r.sessions = modelSessions.get(key)?.size ?? 0;
    total.sessions = sessions.size;
    // Attribution: a session's tokens split evenly among the distinct skills used in it.
    for (const [session, keys] of sessionSkills) {
      const s = sessions.get(session); if (!s || !keys.size) continue;
      for (const key of keys) { const r = rows.get(key)!; addTokens(r.attributed, s.tokens, 1 / keys.size); if (s.priced) r.attributedCost = (r.attributedCost ?? 0) + s.cost / keys.size; }
    }

    const kilnTotal = row('kiln', 'Kiln runs'), byKind = new Map<string, SpendRow>(), byItem = new Map<string, SpendRow>();
        for (const job of this.agentJobs()) {
      if (!inWindow(job.day)) continue;
      for (const target of [kilnTotal, group(byKind, job.kind), group(byItem, job.itemId, library.titles[job.itemId] ?? 'Deleted item')]) { add(target, job.model, job.tokens); target.runs = (target.runs ?? 0) + 1; }
    }

    const copies = new Map<string, number>(); for (const copy of library.copies?.() ?? []) copies.set(copy.itemId, (copies.get(copy.itemId) ?? 0) + 1);
    const lastByItem = new Map<string, string>(); for (const r of rows.values()) if (r.itemId && r.lastUsed) lastByItem.set(r.itemId, r.lastUsed);
    const unused = library.skills.filter(s => copies.has(s.id) && (!lastByItem.has(s.id) || (since && localDay(lastByItem.get(s.id)!) < since) || false))
      .map(s => ({ itemId: s.id, title: s.title, status: s.status, copies: copies.get(s.id)!, lastUsed: lastByItem.get(s.id) ?? null }))
      .sort((a, b) => (a.lastUsed ?? '').localeCompare(b.lastUsed ?? '') || a.title.localeCompare(b.title));
    const sorted = (map: Map<string, SpendRow>) => [...map.values()].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || totalTokens(b.tokens) - totalTokens(a.tokens));
    return {
      days, since: since || null, scan: status ?? this.status(), unused,
      skills: [...rows.values()].map(({ days: active, projectSet, signalSet, harnessSet, ...r }) => ({ ...r, activeDays: active.size, projects: [...projectSet].sort(), signals: [...signalSet].sort(), harnesses: [...harnessSet].sort(), importable: !r.itemId && Boolean(r.folder) && !/[\\/](?:bundled-skills|\.system|plugins)[\\/]/.test(r.folder!) && fs.existsSync(path.join(r.folder!, 'SKILL.md')) }))
        .sort((a, b) => b.uses - a.uses || b.total - a.total || a.title.localeCompare(b.title)),
      spend: { total, byModel: sorted(byModel), byProject: sorted(byProject), byHarness: sorted(byHarness), byMonth: [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key)), kiln: { total: kilnTotal, byKind: sorted(byKind), byItem: sorted(byItem) } },
      prices,
    };
  }
  /** One item's use over the last `days` days, from the cache alone (the item page). */
  item(input: unknown, library: LibraryView): ItemUsage {
    const { itemId, days } = z.object({ itemId: z.string().uuid(), days: z.number().int().min(1).max(3650).default(30) }).parse(input ?? {});
    const resolve = this.resolver(library), since = localDay(Date.now() - (days - 1) * DAY);
    const result: ItemUsage = { itemId, days, uses: 0, total: 0, lastUsed: null, activeDays: 0, projects: 0, inferred: 0 };
    const active = new Set<string>(), projects = new Set<string>();
    for (const use of this.uses()) {
      if (resolve(use) !== itemId) continue;
      result.total++; if (!result.lastUsed || use.at > result.lastUsed) result.lastUsed = use.at;
      if (use.day < since) continue;
      result.uses++; active.add(use.day); if (use.project) projects.add(use.project); if (use.signal === 'inferred') result.inferred++;
    }
    return { ...result, activeDays: active.size, projects: projects.size };
  }
}

