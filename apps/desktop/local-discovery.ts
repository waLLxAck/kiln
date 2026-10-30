import fs from 'node:fs';
import path from 'node:path';
import type { Workbench } from '../../packages/domain/workbench';
import type { ProviderId } from '../../packages/protocol/schema';
import { agentFolder } from '../../packages/domain/agent-folder';
import { agentBundle, agentKey } from '../../packages/domain/agents-import';
import { contentKey, IGNORED_SKILL_ENTRIES, skillBundle } from '../../packages/domain/skills-import';
import { factsCache } from '../../packages/domain/revision-facts';
import { targetSkillsFolder } from '../../packages/providers/skill-locations';
import { digest, writeJson } from '../../packages/storage/files';

type Candidate = { kind: 'skill' | 'agent'; provider: ProviderId; file: string; identity: string };
type Options = { debounceMs?: number; intervalMs?: number; watch?: boolean; log?: (event: string, fields: Record<string, unknown>) => void };
const normal = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

/** Desktop-only discovery of enrolled locations. Reads bundles only for new paths, never on an idle scan.
 * A machine-private ledger remembers handled paths even after an item is edited, trashed or purged. External
 * edits remain available through Compare / Keep changes; discovery never overwrites a library revision.
 */
export class LocalDiscovery {
  private handled = new Set<string>();
  private pending = new Map<string, { stamp: string; at: number }>();
  private origins = new Map<string, { revision: string; source: string }>();
  private watchers = new Map<string, fs.FSWatcher>();
  private filters = new Map<string, Set<string> | null>();
  private timer?: ReturnType<typeof setTimeout>;
  private interval: ReturnType<typeof setInterval>;
  private closed = false;
  private ledger: string;
  private debounceMs: number;
  constructor(private wb: Workbench, private changed: (ids: string[]) => void, private options: Options = {}) {
    this.debounceMs = options.debounceMs ?? 750;
    this.ledger = path.join(wb.local, 'discovery', `${digest(normal(wb.root))}.json`);
    try {
      const stored = JSON.parse(fs.readFileSync(this.ledger, 'utf8'));
      if (stored.schemaVersion === 1 && Array.isArray(stored.handled)) this.handled = new Set(stored.handled.filter((key: unknown) => typeof key === 'string'));
    } catch { /* First run or a damaged ledger: library content still deduplicates the scan. */ }
    this.interval = setInterval(() => this.scan(), options.intervalMs ?? 60_000);
    this.interval.unref();
    this.schedule(0);
  }
  private report(file: string, error: unknown) { this.options.log?.('discovery.failed', { path: file, message: error instanceof Error ? error.message : String(error) }); }
  private schedule(delay = this.debounceMs) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.scan(); }, delay);
    this.timer.unref();
  }
  private identity(kind: Candidate['kind'], provider: ProviderId, file: string) {
    return `${kind}:${kind === 'agent' ? provider : ''}:${normal(file)}`;
  }
  /** `immediate` is used by library refresh and after enrolling/removing a location. */
  scan(immediate = false): { imported: string[] } {
    const imported: string[] = [];
    if (this.closed) return { imported };
    const desired = new Map<string, Set<string> | null>();
    const watch = (folder: string, child?: string) => {
      const key = normal(folder), filter = desired.get(key);
      if (!child) desired.set(key, null);
      else if (filter !== null) desired.set(key, new Set([...(filter ?? []), child]));
    };
    // Watch the nearest existing ancestor too, so enabling an absent .agents/skills folder works immediately.
    const watchAncestor = (folder: string) => {
      let child = folder, parent = path.dirname(child);
      while (parent !== child) {
        if (fs.existsSync(parent)) { watch(parent, path.basename(child)); return; }
        child = parent; parent = path.dirname(parent);
      }
    };
    const candidates = new Map<string, Candidate>(), visited = new Set<string>();
    const visit = (folder: string, kind: Candidate['kind'], provider: ProviderId, depth = 0) => {
      if (depth > 12) return;
      try {
        watchAncestor(folder);
        if (!fs.existsSync(folder)) return;
        const real = fs.realpathSync(folder), identity = this.identity(kind, provider, real);
        if (visited.has(identity)) return;
        visited.add(identity);
        if (!fs.statSync(real).isDirectory()) return;
        if (kind === 'skill' && fs.statSync(path.join(real, 'SKILL.md'), { throwIfNoEntry: false })?.isFile()) {
          if (!this.handled.has(identity)) candidates.set(identity, { kind, provider, file: folder, identity });
          return;
        }
        watch(real);
        for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
          if (IGNORED_SKILL_ENTRIES.includes(entry.name)) continue;
          const file = path.join(folder, entry.name);
          try {
            const stat = entry.isSymbolicLink() ? fs.statSync(file) : entry;
            if (stat.isDirectory()) visit(file, kind, provider, depth + 1);
            else if (kind === 'agent' && stat.isFile() && (provider === 'codex' ? /\.toml$/i : /\.md$/i).test(entry.name)) {
              const identity = this.identity(kind, provider, fs.realpathSync(file));
              if (!this.handled.has(identity)) candidates.set(identity, { kind, provider, file, identity });
            }
          } catch (error) { this.report(file, error); }
        }
      } catch (error) { this.report(folder, error); }
    };
    for (const target of this.wb.targets()) {
      visit(path.join(target.root, targetSkillsFolder(target)), 'skill', target.provider);
      if (!target.skillFolder) visit(path.join(target.root, agentFolder(target.provider, target.scope)), 'agent', target.provider);
    }
    // Stat new bundles until writes settle. Already handled skills never traverse their supporting files again.
    const fingerprint = (file: string, seen = new Set<string>(), depth = 0): string => {
      if (depth > 12) return '';
      const real = fs.realpathSync(file), stat = fs.statSync(real);
      if (seen.has(real)) return ''; seen.add(real);
      if (stat.isFile()) return `${real}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (!stat.isDirectory()) return '';
      watch(real);
      return fs.readdirSync(real).sort().filter(name => !IGNORED_SKILL_ENTRIES.includes(name)).map(name => {
        try { return fingerprint(path.join(real, name), seen, depth + 1); } catch { return ''; }
      }).join('|');
    };
    const ready: Candidate[] = [];
    for (const candidate of candidates.values()) {
      try {
        const stamp = fingerprint(candidate.file), previous = this.pending.get(candidate.identity);
        if (!immediate && (!previous || previous.stamp !== stamp || Date.now() - previous.at < this.debounceMs)) {
          if (!previous || previous.stamp !== stamp) this.pending.set(candidate.identity, { stamp, at: Date.now() });
          this.schedule(); continue;
        }
        ready.push(candidate);
      } catch (error) { this.report(candidate.file, error); }
    }
    for (const key of this.pending.keys()) if (!candidates.has(key)) this.pending.delete(key);
    let dirty = false;
    if (ready.length) {
      const known = new Set<string>(), sources = new Set<string>(), facts = factsCache(this.wb);
      const items = this.wb.listItems(true).filter(item => item.kind === 'skill' || item.kind === 'agent');
      const missing = items.filter(item => this.origins.get(item.id)?.revision !== item.revision);
      for (let offset = 0; offset < missing.length; offset += 5000) {
        const batch = missing.slice(offset, offset + 5000), origins = this.wb.origins({ ids: batch.map(item => item.id) });
        for (const item of batch) this.origins.set(item.id, { revision: item.revision, source: origins[item.id] ?? item.source });
      }
      for (const item of items) {
        if (item.kind !== 'skill' && item.kind !== 'agent') continue;
        try { known.add(`${item.kind}:${facts.get(item).key}`); } catch { /* Other items can still be discovered. */ }
        const origin = this.origins.get(item.id)!.source;
        if (origin.startsWith('local:')) {
          const source = origin.slice(6);
          sources.add(this.identity(item.kind, item.agent?.provider ?? 'codex', source));
          try { sources.add(this.identity(item.kind, item.agent?.provider ?? 'codex', fs.realpathSync(source))); } catch { /* Removed source. */ }
        }
      }
      facts.save();
      for (const candidate of ready) {
        try {
          if (!sources.has(candidate.identity)) {
            const value = candidate.kind === 'skill' ? skillBundle(candidate.file, `local:${candidate.file}`) : agentBundle(candidate.file, candidate.provider);
            const key = `${candidate.kind}:${candidate.kind === 'skill' ? contentKey(value) : agentKey(value)}`;
            if (!known.has(key)) {
              const item = this.wb.create(value, undefined, false);
              this.wb.record('imported', `Discovered “${item.title}” in ${candidate.file}`, item.id, item.revision);
              imported.push(item.id); known.add(key);
            }
          }
          this.handled.add(candidate.identity); this.pending.delete(candidate.identity); dirty = true;
        } catch (error) { this.report(candidate.file, error); }
      }
    }
    if (dirty) try { writeJson(this.ledger, { schemaVersion: 1, handled: [...this.handled] }); } catch (error) { this.report(this.ledger, error); }
    this.syncWatchers(desired);
    if (imported.length) this.changed(imported);
    return { imported };
  }
  private syncWatchers(desired: Map<string, Set<string> | null>) {
    this.filters = desired;
    for (const [folder, watcher] of this.watchers) if (!desired.has(folder)) { watcher.close(); this.watchers.delete(folder); }
    if (this.options.watch === false) return;
    for (const folder of desired.keys()) {
      if (this.watchers.has(folder)) continue;
      try {
        const watcher = fs.watch(folder, { persistent: false }, (event, filename) => {
          const name = filename?.toString(), filter = this.filters.get(folder);
          // A watched directory may have been replaced by an installer. Reattach to its new inode on the next scan.
          if (event === 'rename' && (!name || name === path.basename(folder))) { watcher.close(); this.watchers.delete(folder); this.schedule(); return; }
          if (!name || (!IGNORED_SKILL_ENTRIES.includes(name) && (!filter || filter.has(name)))) this.schedule();
        });
        watcher.on('error', error => { watcher.close(); this.watchers.delete(folder); this.report(folder, error); });
        this.watchers.set(folder, watcher);
      } catch (error) { this.report(folder, error); } // The periodic scan also covers unavailable native watchers.
    }
  }
  close() {
    this.closed = true; clearTimeout(this.timer); clearInterval(this.interval);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
