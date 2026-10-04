import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Workbench } from '../domain/workbench';
import type { DeploymentService } from '../deployment/service';
import { invariant, WorkbenchError } from '../domain/errors';
import { atomicWrite, now, readJson, writeJson } from '../storage/files';
import { commitSnapshot, push } from '../git/service';
import { GitQueue } from '../git/queue';
import { BackgroundFetch } from '../git/sync';
import { catFile, git, gitSync, mergeInProgress, networkTimeout, type RunOptions } from '../git/run';
import { idSchema, locationKeySchema, machineIdentitySchema, machineReportSchema, type FleetPublish, type FleetView, type MachineIdentity, type MachineReport, type ProviderId, type WantedEdit } from '../protocol/schema';
import { applyWanted, buildReport, latestApproval, locationClient, sameReport, targetLocations, type FleetInputs } from './model';

const MAX_MACHINES = 200, MAX_REPORT_BYTES = 2_000_000;
export type FleetOptions = { log?: (event: string, fields?: Record<string, unknown>) => void; /** Version of the running app; empty keeps the one already published (the CLI doesn't know it). */ appVersion?: string; /** Quiet time after a change before the report is published. */ debounceMs?: number; /** A report older than this is published again even when nothing changed, so "last reported" stays meaningful. */ heartbeatMs?: number; /** Minimum time between fetches when the Machines view opens; a report rides a background fetch younger than this. */ fetchEveryMs?: number };
/** The Git queue and background fetch shared with approvals and background sync, so reports never race them. */
export type FleetGit = { queue: GitQueue; fetcher: BackgroundFetch };
export type SyncEntry = { itemId: string; provider?: ProviderId | 'codex-native'; location?: string; label?: string; result: string };

/**
 * The fleet: this machine's identity, its report in the library, and the other machines' reports.
 *
 * Reports travel only through the Kiln repository on GitHub; no other machine is ever contacted. Each machine owns
 * `workbench/machines/<its id>.json`. Race rules:
 * - Only the owner writes a report's locations and copies. Other machines change only its `wanted` list.
 * - Every write is a read-modify-write of the file as GitHub has it (as last fetched), made in one commit-and-push in its turn
 *   in the Git queue shared with approvals, organisation commits and background fetches and pulls, so none of them interleave.
 *   A background fetch younger than `fetchEveryMs` counts as fresh: if it missed something, GitHub rejects the push.
 * - A write is published only as a fast-forward of GitHub's branch. If GitHub moves between the fetch and the push, the push
 *   is rejected, any local commit is undone, and the write is rebuilt on the newer file once more. If this checkout and GitHub
 *   have both moved (unmerged approvals), the change stays pending in private data until the next pull or merge. So two
 *   machines editing one file never silently overwrite each other.
 * - Wanted changes are kept as per-entry edits (set or clear one item at one location), so replaying them after a pull
 *   changes only those entries; for the same entry, the edit pushed last wins.
 * - When the owner rewrites its report it keeps `wanted` from the committed file, so requests made elsewhere survive.
 */
export class FleetService {
  private chain = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private queued = false;
  private auto = false;
  private readonly background: FleetGit;
  private readonly folder: string;
  private readonly identityFile: string;
  private readonly log: NonNullable<FleetOptions['log']>;
  constructor(private wb: Workbench, private deployments: DeploymentService, private options: FleetOptions = {}, shared?: FleetGit) {
    this.background = shared ?? (queue => ({ queue, fetcher: new BackgroundFetch(wb, queue) }))(new GitQueue());
    this.folder = path.join(wb.local, 'fleet');
    // One identity per machine, shared by every library opened on it.
    this.identityFile = path.join(path.dirname(wb.local), 'machine.json');
    this.log = options.log ?? (() => {});
  }
  identity(): MachineIdentity {
    try { return machineIdentitySchema.parse(readJson(this.identityFile)); }
    catch {
      const identity = machineIdentitySchema.parse({ id: randomUUID(), name: (os.hostname() || 'This machine').slice(0, 80), platform: process.platform });
      writeJson(this.identityFile, identity); return identity;
    }
  }
  rename(input: unknown) {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(input);
    const identity = { ...this.identity(), name, platform: process.platform }; writeJson(this.identityFile, identity);
    this.schedule(0); return identity;
  }
  private get appVersion() { return this.options.appVersion ?? process.env.KILN_APP_VERSION ?? ''; }
  private get relative() { return path.relative(this.wb.root, this.wb.canonical).split(path.sep).join('/') + '/machines'; }
  private file(id: string) { return `${this.relative}/${idSchema.parse(id)}.json`; }
  /**
   * Git for the rare synchronous paths (marking, consolidating, the CLI's status). Publishing, Machines and Sync use `gitAsync`,
   * so a report never holds the backend thread.
   */
  private git(args: string[]) { return gitSync(this.wb.root, args).trim(); }
  private async gitAsync(args: string[], options: RunOptions = {}) { return (await git(this.wb.root, args, options)).trim(); }
  private resolve(ref: 'HEAD' | '@{u}' | 'MERGE_HEAD') { try { return this.git(['rev-parse', '--verify', '--quiet', ref]) || null; } catch { return null; } }
  private async resolveAsync(ref: 'HEAD' | '@{u}' | 'MERGE_HEAD') { try { return await this.gitAsync(['rev-parse', '--verify', '--quiet', ref]) || null; } catch { return null; } }
  private parseReport(text: string | undefined, id: string): MachineReport | null {
    if (text === undefined || text.length > MAX_REPORT_BYTES) return null;
    try { const report = machineReportSchema.parse(JSON.parse(text)); return report.id === id ? report : null; } catch { return null; }
  }
  /** The report of one machine at a commit, validated; null when absent or unreadable. */
  private committed(commit: string | null, id: string): MachineReport | null {
    if (!commit) return null;
    let text: string; try { text = this.git(['show', `${commit}:${this.file(id)}`]); } catch { return null; }
    return this.parseReport(text, id);
  }
  private async committedAsync(commit: string | null, id: string): Promise<MachineReport | null> {
    if (!commit) return null;
    const name = `${commit}:${this.file(id)}`;
    try { return this.parseReport((await catFile(this.wb.root, [name])).get(name)?.toString('utf8').trim(), id); } catch { return null; }
  }
  private reportIds(listing: string) {
    const pattern = new RegExp(`^${this.relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.json$`);
    return listing.split('\0').filter(Boolean).map(name => name.match(pattern)?.[1]).filter((id): id is string => Boolean(id)).slice(0, MAX_MACHINES);
  }
  private reports(commit: string) {
    let listing: string;
    try { listing = this.git(['ls-tree', '-z', '--name-only', commit, '--', `${this.relative}/`]); } catch { return []; }
    return this.reportIds(listing).map(id => this.committed(commit, id)).filter((report): report is MachineReport => Boolean(report));
  }
  /** Every machine's report at a commit, read with two Git processes. */
  private async reportsAsync(commit: string) {
    let listing: string;
    try { listing = await this.gitAsync(['ls-tree', '-z', '--name-only', commit, '--', `${this.relative}/`]); } catch { return []; }
    const ids = this.reportIds(listing), names = ids.map(id => `${commit}:${this.file(id)}`);
    let texts: Map<string, Buffer | null>; try { texts = await catFile(this.wb.root, names); } catch { return []; }
    return ids.map((id, i) => this.parseReport(texts.get(names[i])?.toString('utf8').trim(), id)).filter((report): report is MachineReport => Boolean(report));
  }
  /** The fetched GitHub branch when there is one (it has what other machines pushed), else this checkout. */
  private readable() { const upstream = this.resolve('@{u}'); return upstream ? { commit: upstream, source: 'upstream' as const } : { commit: this.resolve('HEAD'), source: 'head' as const }; }
  private async readableAsync() { const upstream = await this.resolveAsync('@{u}'); return upstream ? { commit: upstream, source: 'upstream' as const } : { commit: await this.resolveAsync('HEAD'), source: 'head' as const }; }
  private inputs(): FleetInputs {
    const snapshot = this.wb.snapshot();
    return { items: snapshot.items, approvals: snapshot.approvals, targets: snapshot.targets, receipts: this.deployments.receipts(), installations: this.deployments.installations(), home: os.homedir() };
  }
  pending(): WantedEdit[] { try { return readJson(path.join(this.folder, 'pending.json')) as WantedEdit[]; } catch { return []; } }
  private savePending(edits: WantedEdit[]) { writeJson(path.join(this.folder, 'pending.json'), edits); }
  publishState(): FleetPublish { try { return readJson(path.join(this.folder, 'state.json')) as FleetPublish; } catch { return { state: 'idle', sharedAt: null, commit: '' }; } }
  private saveState(state: FleetPublish) { writeJson(path.join(this.folder, 'state.json'), state); }
  private withEdits(wanted: MachineReport['wanted'], machineId: string) {
    return this.pending().filter(e => e.machineId === machineId).reduce((next, e) => applyWanted(next, e.itemId, e.location, e.wanted), wanted);
  }
  /** What this machine was asked to install: the published list (from GitHub when fetched) with unsent local edits. */
  wanted() { const self = this.identity(); return this.withEdits(this.committed(this.readable().commit, self.id)?.wanted ?? {}, self.id); }
  private async wantedAsync() { const self = this.identity(); return this.withEdits((await this.committedAsync((await this.readableAsync()).commit, self.id))?.wanted ?? {}, self.id); }
  /** This machine's report as it would be published now. */
  live() { const self = this.identity(); return buildReport(self, this.appVersion, this.inputs(), this.wanted(), now()); }

  async view(input: unknown = {}): Promise<FleetView> {
    const { fetch } = z.object({ fetch: z.boolean().default(false) }).parse(input);
    const ready = this.wb.repositoryState().ready;
    // The background sync's fetch: one fetched a moment ago (by it or by a report) is not repeated.
    const fetched = fetch && ready ? await this.background.fetcher.fetch(this.fetchEveryMs) : this.background.fetcher.status();
    const self = this.identity(), { commit, source } = await this.readableAsync();
    const machines = commit ? (await this.reportsAsync(commit)).filter(r => r.id !== self.id).sort((a, b) => a.name.localeCompare(b.name)) : [];
    const publish = this.publishState();
    // Merged outside Kiln since the report had to wait: try again now.
    if (publish.state === 'behind' && !await this.diverged()) this.schedule(0);
    return { self, wanted: await this.wantedAsync(), publish, machines, source: commit ? source : 'none', fetchedAt: fetched.fetchedAt, ...(fetched.error ? { fetchError: fetched.error.slice(0, 300) } : {}), pending: this.pending(), appVersion: this.appVersion, ready };
  }
  /** Both this checkout and the fetched branch have commits the other lacks. */
  private async diverged() { const head = await this.resolveAsync('HEAD'), upstream = await this.resolveAsync('@{u}'); return Boolean(head && upstream && !await this.ancestor(head, upstream) && !await this.ancestor(upstream, head)); }

  /** Asks `machineId` to install (or stop wanting) an item at one of its locations. Published at once; applied there on its next sync. */
  mark(input: unknown) {
    const data = z.object({ machineId: idSchema, itemId: idSchema, location: locationKeySchema, wanted: z.boolean() }).parse(input);
    const item = this.wb.getItem(data.itemId), self = this.identity();
    invariant(item.kind === 'skill' || item.kind === 'agent', 'NOT_DEPLOYABLE', 'Only skills and agents can be marked for a machine.');
    if (data.wanted) {
      invariant(latestApproval(this.wb.approvals(), item.id), 'APPROVAL_REQUIRED', 'Approve this item before marking it for a machine. Sync installs approved revisions only.');
      invariant(item.kind !== 'agent' || locationClient(data.location) === item.agent?.provider, 'AGENT_CLIENT_MISMATCH', 'That location isn’t read by the client this agent was written for.');
      const locations = data.machineId === self.id ? targetLocations(this.wb.targets(), os.homedir()) : this.committed(this.readable().commit, data.machineId)?.locations;
      invariant(locations, 'MACHINE_NOT_FOUND', 'That machine has not reported to this library.');
      invariant(locations.some(l => l.key === data.location), 'LOCATION_NOT_FOUND', 'That machine has no such location.');
    }
    const edits = this.pending().filter(e => !(e.machineId === data.machineId && e.itemId === data.itemId && e.location === data.location));
    edits.push({ ...data, at: now() }); this.savePending(edits);
    this.schedule(0);
    return { pending: edits.length };
  }
  /**
   * Consolidation: every machine's marks for the merged copies move to the kept item, as ordinary mark edits. Returns the marks
   * moved (and whether the kept item was already marked there) so an undo can move them back. With no marks anywhere, as while
   * Machines is off, it reads the reports and changes nothing.
   */
  repoint(from: string[], to: string) {
    const self = this.identity(), commit = this.readable().commit;
    const machines = [{ id: self.id, wanted: this.wanted() }, ...(commit ? this.reports(commit).filter(r => r.id !== self.id).map(r => ({ id: r.id, wanted: this.withEdits(r.wanted, r.id) })) : [])];
    const moved: { machineId: string; itemId: string; location: string; had: boolean }[] = [], edits: WantedEdit[] = [], at = now();
    for (const machine of machines) {
      const marked = new Set(machine.wanted[to] ?? []);
      for (const id of from) for (const location of machine.wanted[id] ?? []) {
        moved.push({ machineId: machine.id, itemId: id, location, had: marked.has(location) });
        edits.push({ machineId: machine.id, itemId: id, location, wanted: false, at });
        if (!marked.has(location)) { edits.push({ machineId: machine.id, itemId: to, location, wanted: true, at }); marked.add(location); }
      }
    }
    this.applyEdits(edits);
    return moved;
  }
  /** Moves marks that `repoint` moved back to the copies they came from. */
  unpoint(moved: { machineId: string; itemId: string; location: string; had: boolean }[], to: string) {
    const at = now();
    this.applyEdits(moved.flatMap(m => [{ machineId: m.machineId, itemId: m.itemId, location: m.location, wanted: true, at }, ...(m.had ? [] : [{ machineId: m.machineId, itemId: to, location: m.location, wanted: false, at }])]));
  }
  private applyEdits(edits: WantedEdit[]) {
    if (!edits.length) return;
    const same = (a: WantedEdit, b: WantedEdit) => a.machineId === b.machineId && a.itemId === b.itemId && a.location === b.location;
    this.savePending([...this.pending().filter(e => !edits.some(n => same(e, n))), ...edits]);
    this.schedule(0);
  }
  /** Publishes this machine's report now if it changed, together with any unsent marks. */
  report() { this.schedule(0); return this.publishState(); }
  /**
   * Installs everything the library asks of this machine: installs.json, then entries marked for it. Never approves.
   * Fetches first: marks are made on other machines and pushed to GitHub, and nobody should have to pull just to see them.
   * Offline, it installs what the last fetch saw.
   */
  async sync(): Promise<SyncEntry[]> {
    if (await this.tracking() && this.wb.repositoryState().ready) await this.background.fetcher.fetch();
    const wanted = await this.wantedAsync();
    // One read of the approvals for every entry below, instead of several per install (DeploymentService.batch).
    return this.deployments.batch(() => this.syncWanted(this.deployments.syncInstalls(), wanted));
  }
  private syncWanted(entries: SyncEntry[], wanted: Awaited<ReturnType<FleetService['wantedAsync']>>) {
    const locations = targetLocations(this.wb.targets(), os.homedir()), targets = this.wb.targets();
    const token = (key: string): ProviderId | 'codex-native' | undefined => key === 'agents' ? 'codex' : key === 'codex' ? 'codex-native' : key === 'claude' || key === 'copilot' ? key : undefined;
    for (const [itemId, keys] of Object.entries(wanted)) for (const key of keys) {
      const location = locations.find(l => l.key === key), target = targets.find(t => t.id === location?.targetId);
      const entry = { itemId, location: key, label: location?.label ?? key, provider: target?.provider === 'codex' && target.skillFolder ? 'codex-native' as const : target?.provider ?? token(key) };
      let item; try { item = this.wb.getItem(itemId); } catch { entries.push({ ...entry, result: 'skipped: not in this library yet; pull from GitHub first' }); continue; }
      if (!target) { entries.push({ ...entry, result: 'skipped: location not set up on this machine' }); continue; }
      if (item.kind === 'agent' && locationClient(key) !== item.agent?.provider) { entries.push({ ...entry, result: 'skipped: this location doesn’t suit the agent’s client' }); continue; }
      entries.push({ ...entry, result: this.deployments.installApproved(itemId, target) });
    }
    this.changed();
    return entries;
  }
  /** Turns on reporting after changes and publishes once. The desktop app calls it at start only while multi-machine is on (apps/desktop/src/features.ts). */
  start() { this.auto = true; this.schedule(0); return this.publishState(); }
  stop() { this.auto = false; clearTimeout(this.timer); this.timer = undefined; }
  /** Something that shows in this machine's report changed. */
  changed() { if (this.auto) this.schedule(this.options.debounceMs ?? 1500); }
  /** After a pull or merge: anything GitHub rejected earlier can go now. */
  afterPull() { if (this.auto || this.pending().length || this.publishState().state === 'behind') this.schedule(0); }
  /** Resolves once queued publishing has finished; a publish still waiting for its quiet time runs now. */
  async idle() { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.enqueue(); } await this.chain; }
  private get fetchEveryMs() { return this.options.fetchEveryMs ?? 60_000; }
  private schedule(delay: number) {
    if (this.queued) return;
    clearTimeout(this.timer);
    if (this.publishState().state !== 'queued') this.saveState({ ...this.publishState(), state: 'queued' });
    this.timer = setTimeout(() => { this.timer = undefined; this.enqueue(); }, delay);
    this.timer.unref?.();
  }
  private enqueue() {
    if (this.queued) return;
    this.queued = true;
    this.chain = this.chain.then(() => this.background.queue.run(() => { this.queued = false; return this.publish(); })).catch(error => this.log('fleet.failed', { message: error instanceof Error ? error.message : String(error) }));
  }
  /** Remote, branch and remote-tracking ref this checkout pushes to; null before the first push. */
  private async tracking() {
    try {
      const branch = await this.gitAsync(['symbolic-ref', '--short', 'HEAD']);
      const [remote, merge] = await Promise.all([this.gitAsync(['config', `branch.${branch}.remote`]), this.gitAsync(['config', `branch.${branch}.merge`])]);
      if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(merge) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote)) return null;
      return { remote, merge, ref: `refs/remotes/${remote}/${merge.slice('refs/heads/'.length)}` };
    } catch { return null; }
  }
  private async ancestor(a: string, b: string) { try { await this.gitAsync(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } }
  /** A commit of `files` on top of `base` that leaves HEAD, the index and the checkout alone; null when nothing changes. */
  private async commitOn(base: string, files: Record<string, string>, message: string) {
    fs.mkdirSync(this.folder, { recursive: true });
    const index = path.join(this.folder, `index-${process.pid}-${randomUUID()}`);
    const run = (args: string[], input?: Buffer | string) => this.gitAsync(args, { input, env: { GIT_INDEX_FILE: index } });
    try {
      await run(['read-tree', base]);
      const shas: string[] = [];
      // Machine reports are a handful of small files; one hash-object each, without blocking the thread.
      for (const content of Object.values(files)) shas.push(await run(['hash-object', '-w', '--stdin'], Buffer.from(content, 'base64')));
      await run(['update-index', '-z', '--index-info'], Object.keys(files).map((file, i) => `100644 ${shas[i]}\t${file}\0`).join(''));
      const tree = await run(['write-tree']);
      return tree === await run(['rev-parse', `${base}^{tree}`]) ? null : await run(['commit-tree', tree, '-p', base, '-m', message]);
    } finally { fs.rmSync(index, { force: true }); }
  }
  /**
   * Publishes whatever changed in one commit and push, in its turn in the Git queue (see the race rules above). Built on HEAD when HEAD has
   * everything GitHub has, pushing HEAD as an approval does. When HEAD is only behind, it is built on the fetched branch and
   * pushed there, leaving HEAD and the checkout alone: the next pull fast-forwards over it, and nobody has to pull just to
   * report or mark. When both have new commits, it waits for a pull or merge.
   */
  private async publish() {
    const previous = this.publishState();
    const finish = (state: FleetPublish) => { this.saveState({ ...state, finishedAt: now() }); this.log('fleet.published', { state: state.state, commit: state.commit, error: state.error }); };
    if (!this.wb.repositoryState().ready) return finish({ state: 'unavailable', sharedAt: previous.sharedAt, commit: previous.commit });
    // The first try rides a recent background fetch; when GitHub has moved since, the push is rejected and later tries fetch first.
    const tries = this.fetchEveryMs ? 3 : 2;
    for (let attempt = 0; ; attempt++) {
      const result = await this.attempt(previous, attempt ? 0 : this.fetchEveryMs);
      if (result.state !== 'retry') return finish(result);
      // GitHub moved between the fetch and the push: fetch and build again, then wait.
      if (attempt + 1 >= tries) return finish({ state: 'behind', sharedAt: result.sharedAt, commit: previous.commit });
    }
  }
  private async attempt(previous: FleetPublish, fetchAgeMs: number): Promise<FleetPublish | { state: 'retry'; sharedAt: string | null }> {
    const self = this.identity(), tracking = await this.tracking();
    if (tracking) await this.background.fetcher.fetchHeld(fetchAgeMs);
    const head = await this.resolveAsync('HEAD'), upstream = tracking ? await this.resolveAsync('@{u}') : null;
    const onUpstream = Boolean(head && upstream && head !== upstream && await this.ancestor(head, upstream));
    const base = onUpstream ? upstream : head;
    const committedOwn = await this.committedAsync(base, self.id), sharedAt = committedOwn?.reportedAt ?? null;
    if (!base || mergeInProgress(this.wb.root) || (upstream && !onUpstream && !await this.ancestor(upstream, base))) return { state: 'behind', sharedAt, commit: previous.commit };
    const edits = this.pending(), files: Record<string, string> = {}, bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64');
    const wanted = edits.filter(e => e.machineId === self.id).reduce((next, e) => applyWanted(next, e.itemId, e.location, e.wanted), committedOwn?.wanted ?? {});
    const report = buildReport(self, this.appVersion || committedOwn?.appVersion || '', this.inputs(), wanted, now());
    const stale = !committedOwn || !(Date.now() - Date.parse(committedOwn.reportedAt) < (this.options.heartbeatMs ?? 86_400_000));
    if (!sameReport(committedOwn, report) || stale) files[this.file(self.id)] = bytes(report);
    const others = [...new Set(edits.map(e => e.machineId).filter(id => id !== self.id))], names: string[] = [];
    for (const id of others) {
      const current = await this.committedAsync(base, id);
      if (!current) { this.log('fleet.mark.dropped', { machineId: id }); continue; } // That machine's report is gone; nothing to ask.
      const next = edits.filter(e => e.machineId === id).reduce((acc, e) => applyWanted(acc, e.itemId, e.location, e.wanted), current.wanted);
      const updated = { ...current, wanted: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))) };
      if (JSON.stringify(updated.wanted) !== JSON.stringify(current.wanted)) { files[this.file(id)] = bytes(machineReportSchema.parse(updated)); names.push(current.name); }
    }
    const settle = () => { const sent = new Set(edits.map(e => e.at + e.machineId + e.itemId + e.location)); this.savePending(this.pending().filter(e => !sent.has(e.at + e.machineId + e.itemId + e.location))); };
    const done = (commit: string): FleetPublish => { settle(); return { state: 'shared', sharedAt: files[this.file(self.id)] ? report.reportedAt : sharedAt, commit }; };
    if (!Object.keys(files).length) return done(previous.commit);
    const message = (files[this.file(self.id)] ? `Report installs on ${self.name}${names.length ? `; update marks for ${names.join(', ')}` : ''}` : `Update what is marked for ${names.join(', ')}`).slice(0, 200);
    const reason = (error: unknown) => String((error as { stderr?: string }).stderr || (error instanceof Error ? error.message : error)).trim().slice(0, 600);
    const rejected = (error: unknown) => /rejected|fetch first|non-fast-forward|stale info/i.test(reason(error));
    if (onUpstream && tracking && upstream) {
      let commit: string | null;
      try { commit = await this.commitOn(upstream, files, message); } catch (error) { return { state: 'failed', sharedAt, commit: previous.commit, error: reason(error) }; }
      if (!commit) return done(previous.commit);
      try { await this.gitAsync(['push', '--quiet', tracking.remote, `${commit}:${tracking.merge}`], { network: true, timeoutMs: networkTimeout(120_000) }); }
      catch (error) { return rejected(error) ? { state: 'retry', sharedAt } : { state: 'failed', sharedAt, commit: previous.commit, error: reason(error) }; }
      try { await this.gitAsync(['update-ref', tracking.ref, commit, upstream]); } catch { /* The next fetch brings it. */ }
      await this.wb.refreshGit(); return done(commit);
    }
    let commit = '';
    try { commit = (await commitSnapshot(this.wb.root, this.wb.canonical, files, [], message)).commit; }
    catch (error) {
      await this.wb.refreshGit();
      if (error instanceof WorkbenchError && error.code === 'NOTHING_TO_COMMIT') return done(previous.commit);
      return { state: 'failed', sharedAt, commit: previous.commit, error: reason(error) };
    }
    try { await push(this.wb.root); }
    catch (error) {
      // Undo the unpublished commit so nothing is left for a merge; the next try rebuilds the change from current data.
      if (head && await this.resolveAsync('HEAD') === commit) { await this.gitAsync(['update-ref', 'HEAD', head, commit]); await this.gitAsync(['reset', '-q', 'HEAD', '--', ...Object.keys(files)]); }
      await this.wb.refreshGit();
      return rejected(error) ? { state: 'retry', sharedAt } : { state: 'failed', sharedAt, commit: previous.commit, error: reason(error) };
    }
    // Keep the checkout in step with the commit, so these files don't show as changed and pulls stay fast-forwards.
    for (const [file, content] of Object.entries(files)) atomicWrite(path.join(this.wb.root, ...file.split('/')), Buffer.from(content, 'base64'));
    await this.wb.refreshGit(); return done(commit);
  }
}
