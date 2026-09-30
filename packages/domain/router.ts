import { scanAgents, importAgents } from './agents-import';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { idSchema, hashSchema, type SkillInvocation } from '../protocol/schema';
import { invariant } from './errors';
import { Workbench } from './workbench';
import { DeploymentService, type UpdateResult } from '../deployment/service';
import { readInvocation, setModelInvocation } from './invocation';
import { checkpoint, gitDiff, inventory, sync } from '../git/service';
import { Publisher, type Composer } from '../git/publish';
import { codexDescriber, type Describer } from '../agent/summarise';
import { detectProviders } from '../providers/service';
import { WorkbenchError } from './errors';
import { conflicts, finishMerge, mergeFetched, resolveItemConflict } from '../git/conflicts';
import { findDefaultRepository, githubLoginStatus, githubState, listGitHubRepositories, listKilnRepositories, cloneGitHub, publishGitHub, startGitHubLogin } from '../git/github';
import { applyInfrastructure, defaultParent, infrastructurePlan, initialiseRepository, inspectRepositoryFolder, standardStatus } from '../git/standard';
import { importLocalSkills, scanLocalSkills } from './skills-import';
import { applyMigration, migrationPlan } from '../git/migration';
import { HomeFiles } from '../home/service';
import { SessionStartMeter } from '../home/session-start';
import { FleetService, type FleetOptions } from '../fleet/service';
import { ProjectInstalls } from '../deployment/projects';
import { McpServers } from '../deployment/mcp';

import { BackgroundFetch, pullFetched } from '../git/sync';
import { GitQueue } from '../git/queue';

const sourceSchema = z.object({ source: z.string().min(1).optional() });
/** Methods that can change how published items are organised or which installs are wanted; see `Router.organiseSoon`. */
const organisingMethods = new Set(['items.move', 'items.reorder', 'items.meta', 'items.update', 'items.consolidate', 'items.unconsolidate', 'items.distinct', 'collections.save', 'collections.create', 'collections.rename', 'collections.move', 'collections.delete', 'skills.install', 'skills.remove', 'skills.removeAllLocal', 'skills.sync', 'skills.import', 'deploy.apply', 'deploy.uninstall', 'deploy.rollback', 'deploy.approveKept']);
export type RouterOptions = { log?: (event: string, fields?: Record<string, unknown>) => void; /** Overrides the commit-message writer (tests inject a stub); `null` skips the agent and uses the plain message. */ composer?: Composer | null; /** Writes revision notes the user left empty; defaults to the commit-message model, `null` (or `composer: null`) keeps the placeholder. */ describer?: Describer | null; home?: HomeFiles; /** Machine reports: app version, publish timing. Reporting after changes starts only with `fleet.start`. */ fleet?: Omit<FleetOptions, 'log'> };
/** Calls that change what this machine's report says; each schedules a publish once reporting has started. */
const reportTriggers = new Set(['skills.invocation', 'skills.install', 'skills.remove', 'skills.removeAllLocal', 'skills.update', 'skills.updateOutdated', 'deploy.apply', 'deploy.rollback', 'deploy.uninstall', 'deploy.recover', 'deploy.keepCopy', 'deploy.approveKept', 'projects.install', 'projects.forget', 'targets.enroll', 'targets.remove', 'approvals.approve', 'approvals.unapprove', 'items.purge', 'items.restore', 'items.consolidate', 'items.unconsolidate']);
/**
 * What `skills.invocation` did: `changed` is false when the skill already said so. `approval`: `carried` when the new revision is
 * approved (the approval carried over from a flag-only change), `draft` when it waits for the user. `update` is what happened to
 * installed copies, null for a draft.
 */
export type InvocationResult = { itemId: string; title: string; revision: string; changed: boolean; approval: 'carried' | 'draft'; invocation: SkillInvocation; update: UpdateResult | null };
export class Router {
  readonly deployments: DeploymentService;
  readonly publisher: Publisher;
  /**
   * Every Git job that touches refs or the network, one at a time: approval and organisation commits and pushes, background
   * fetches, pulls and merges, machine reports, and the Settings buttons. See packages/git/queue.ts.
   */
  readonly gitQueue = new GitQueue();
  /** Background fetch with GitHub; idle unless the desktop app asks for it. Machine reports ride it instead of fetching again. */
  readonly fetcher: BackgroundFetch;
  private organiseTimer?: ReturnType<typeof setTimeout>;
  /** Items whose desired installs changed since the last organisation job was queued. */
  private installsChanged = new Set<string>();
  readonly home: HomeFiles;
  /** What each harness loads when a session starts on this machine (home/session-start.ts); caches file reads between calls. */
  readonly sessionStart: SessionStartMeter;
  readonly fleet: FleetService;
  /** Install into any project folder, enrolling it on first use. */
  readonly projects: ProjectInstalls;
  /** MCP servers: import from client configs, install one entry per client config (deployment/mcp.ts). */
  readonly mcp: McpServers;
  private readonly describer: Describer | null;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  constructor(readonly wb: Workbench, options: RouterOptions = {}) {
    this.deployments = new DeploymentService(wb);
    this.publisher = new Publisher(wb, options.log, options.composer, this.gitQueue);
    this.fetcher = new BackgroundFetch(wb, this.gitQueue);
    this.describer = options.describer !== undefined ? options.describer : options.composer === null ? null : codexDescriber;
    this.log = options.log ?? (() => {});
    this.fleet = new FleetService(wb, this.deployments, { ...options.fleet, log: this.log }, { queue: this.gitQueue, fetcher: this.fetcher });
    this.home = options.home ?? new HomeFiles({ privateRoot: path.dirname(wb.local), projects: () => wb.targets().filter(t => t.scope === "project").map(t => t.root) });
    this.projects = new ProjectInstalls(wb, this.deployments, () => this.home.savedProjects(), args => this.installSkill(args));
    this.mcp = new McpServers(wb, this.home);
    this.sessionStart = new SessionStartMeter({ home: this.home.home, env: this.home.env, projects: () => [...wb.targets().filter(t => t.scope === 'project').map(t => t.root), ...this.home.savedProjects()] });
  }
  /** Saves the revision at once, then fills in a generated note in the background when the user left "What changed?" empty. */
  private updateItem(args: unknown) {
    const data = z.object({ id: idSchema, expect: hashSchema, summary: z.string().default('') }).passthrough().parse(args);
    const before = data.summary.trim() || !this.describer ? null : this.wb.getRevision(data.id, data.expect);
    const updated = this.wb.update(args);
    if (before && updated.revision !== data.expect) {
      const after = this.wb.getRevision(updated.id), settings = this.wb.settings();
      const folder = path.join(this.wb.local, 'runs', `describe-${updated.revision.slice(0, 12)}`); fs.mkdirSync(folder, { recursive: true });
      const describe = (revision: typeof before) => `title: ${revision.title}\ncollection: ${revision.collection}\ntags: ${revision.tags.join(', ')}\nsource: ${revision.source}\nfiles: ${Object.keys(revision.files).join(', ') || 'none'}\n\n${revision.content}`;
      void this.describer!({ title: after.title, kind: after.kind, before: describe(before), after: describe(after), model: settings.commitModel, effort: settings.commitEffort, folder, signal: new AbortController().signal })
        .then(summary => this.wb.describeRevision(updated.id, updated.revision, summary))
        .catch(error => this.log('revision.describe.failed', { itemId: updated.id, message: error instanceof Error ? error.message : String(error) }))
        .finally(() => fs.rmSync(folder, { recursive: true, force: true }));
    }
    return updated;
  }
  call(method: string, args: unknown = {}) {
    const watch = organisingMethods.has(method) && this.autoSyncReady();
    const before = watch ? this.wb.installs() : null;
    const result = this.route(method, args);
    const settled = () => {
      if (before) {
        const after = this.wb.installs();
        for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) this.installsChanged.add(id);
        this.organiseSoon();
      }
      if (reportTriggers.has(method)) this.fleet.changed();
      if (method === 'git.sync' || method === 'git.merge' || method === 'git.finishMerge' || method === 'sync.pull') this.fleet.afterPull();
    };
    // Calls that wait for the Git queue (pulls, merges, installing what is marked) are followed up once they have run.
    if (result instanceof Promise) return result.then(value => { settled(); return value; });
    settled();
    return result;
  }
  private autoSyncReady() { return this.wb.repositoryState().ready; }
  /** Organisation of published items follows them to GitHub a moment later, so a burst of moves makes one commit. */
  private organiseSoon() {
    clearTimeout(this.organiseTimer);
    this.organiseTimer = setTimeout(() => this.flushOrganisation(), Number(process.env.KILN_ORGANISE_DELAY_MS) || 1500);
    this.organiseTimer.unref?.();
  }
  /** Queues the organisation job now instead of after the pause. Returns it, or null when nothing needs publishing. */
  flushOrganisation() {
    clearTimeout(this.organiseTimer); this.organiseTimer = undefined;
    const installIds = [...this.installsChanged]; this.installsChanged.clear();
    try { return this.autoSyncReady() ? this.publisher.organise(installIds) : null; }
    catch (error) { this.log('publish.organise.failed', { message: error instanceof Error ? error.message : String(error) }); return null; }
  }
  private pull() {
    const result = pullFetched(this.wb);
    if (result.status === 'pulled') this.log('sync.pulled', { count: result.count });
    return result;
  }
  private route(method: string, args: unknown) {
    switch (method) {
      case 'snapshot': return { ...this.wb.snapshot(), publish: this.publisher.list() };
      case 'publish.jobs': return this.publisher.list();
      case 'publish.retry': return this.publisher.retry(z.object({ id: idSchema }).parse(args).id);
      case 'home.list': return this.home.list();
      case 'home.read': return this.home.read(z.object({ key: z.string() }).parse(args).key);
      case 'home.save': return this.home.save(args);
      case 'home.backups': return this.home.backups(z.object({ key: z.string() }).parse(args).key);
      case 'home.backup': return this.home.backup(args);
      case 'home.restore': return this.home.restore(args);
      case 'home.addProject': return this.home.addProject(args);
      case 'home.add': return this.home.add(args);
      case 'home.remove': return this.home.remove(args);
      case 'github.status': return githubState(this.wb.root);
      case 'github.repositories': return listGitHubRepositories();
      case 'github.defaultRepository': return findDefaultRepository();
      case 'github.kilnRepositories': return listKilnRepositories();
      case 'repository.defaultParent': return defaultParent();
      case 'repository.inspect': return inspectRepositoryFolder(args);
      case 'skills.scanLocal': return scanLocalSkills(this.wb);
      case 'skills.importLocal': return importLocalSkills(this.wb, args);
      case 'github.login': return startGitHubLogin();
      case 'github.loginStatus': return githubLoginStatus();
      case 'github.clone': return cloneGitHub(args);
      case 'github.publish': return publishGitHub(args);
      case 'repository.status': return standardStatus(this.wb.root);
      case 'repository.create': return initialiseRepository(args);
      case 'repository.infrastructurePlan': return infrastructurePlan(this.wb.root);
      case 'repository.upgrade': return applyInfrastructure(this.wb.root, z.object({ expect: z.string(), confirm: z.literal(true) }).parse(args).expect);
      case 'repository.migrationPlan': return migrationPlan(this.wb.root, sourceSchema.parse(args).source);
      case 'repository.migrate': { const a = z.object({ expect: z.string(), confirm: z.literal(true), source: z.string().min(1).optional() }).parse(args); return applyMigration(this.wb, a.expect, a.source); }
      case 'items.list': { const a = z.object({ query: z.string().default(''), archived: z.boolean().default(false) }).parse(args); return this.wb.search(a.query, a.archived); }
      case 'items.search': { const a = z.object({ query: z.string().default(''), archived: z.boolean().default(false), limit: z.number().int().positive().max(1000).optional() }).parse(args); return this.wb.rankedSearch(a.query, a); }
      case 'items.read': return this.wb.detail(z.object({ id: idSchema }).parse(args).id);
      case 'items.origins': return this.wb.origins(args);
      case 'items.revision': { const a = z.object({ id: idSchema, revision: hashSchema }).parse(args); return this.wb.getRevision(a.id, a.revision); }
      case 'items.create': return this.wb.create(args);
      case 'items.update': return this.updateItem(args);
      case 'items.meta': return this.wb.setMeta(args);
      case 'items.move': return this.wb.moveItems(args);
      case 'items.restore': return this.wb.restore(args);
      case 'items.purge': return this.wb.purge(args);
      case 'items.duplicates': return this.duplicates();
      case 'items.consolidate': return this.consolidate(args);
      case 'items.unconsolidate': return this.unconsolidate(args);
      case 'items.distinct': return this.wb.markDistinct(args);
      case 'agents.scan': return scanAgents(this.wb, args);
      case 'agents.import': return importAgents(this.wb, args);
      case 'skills.install': return this.installSkill(args);
      case 'skills.previewRemoval': return this.deployments.previewRemoval(args);
      case 'skills.removeAllLocal': return this.deployments.removeAllLocal(args);
      case 'skills.remove': return this.deployments.removeSkill(args);
      case 'skills.scan': return this.deployments.scan(z.object({ targetId: idSchema }).parse(args).targetId);
      case 'skills.cleanEntry': return this.deployments.cleanScanEntry(args);
      case 'skills.import': return this.deployments.importExternal(args);
      case 'skills.sync': return this.fleet.sync();
      // This machine's id and name only: no Git, nothing published (Machines while it manages this machine alone).
      case 'fleet.identity': return this.fleet.identity();
      case 'fleet.view': return this.fleet.view(args);
      case 'fleet.live': return this.fleet.live();
      case 'fleet.report': return this.fleet.report();
      case 'fleet.start': return this.fleet.start();
      case 'fleet.rename': return this.fleet.rename(args);
      case 'fleet.mark': return this.fleet.mark(args);
      case 'skills.update': return this.published(this.deployments.updateInstalls(args));
      case 'skills.invocation': return this.setInvocation(args);
      case 'context.sessionStart': return this.sessionStart.measure(args);
      case 'skills.updateOutdated': return this.deployments.updateOutdated(args);
      case 'deploy.keepCopy': return this.deployments.keepCopy(args);
      case 'deploy.approveKept': return this.published(this.deployments.approveKept(args));
      case 'projects.known': return this.projects.known(args);
      case 'projects.preview': return this.projects.preview(args);
      case 'projects.install': return this.projects.apply(args);
      case 'projects.forget': return this.projects.forget(args);
      case 'mcp.scan': return this.mcp.scan();
      case 'mcp.import': return this.mcp.importServers(args);
      case 'mcp.status': return this.mcp.status(args);
      case 'mcp.preview': return this.mcp.preview(args);
      case 'mcp.install': return this.published(this.mcp.install(args));
      case 'mcp.remove': return this.mcp.remove(args);
      case 'mcp.rollback': return this.mcp.rollback(args);
      case 'mcp.receipts': return this.mcp.receipts(z.object({ itemId: idSchema.optional() }).parse(args).itemId);
      case 'targets.list': return this.wb.targets();
      case 'targets.remove': return this.wb.removeTarget(args);
      case 'items.reorder': return this.wb.reorderItems(args);
      case 'collections.save': return this.wb.saveCollections(args);
      case 'collections.create': return this.wb.createCollection(args);
      case 'collections.rename': return this.wb.renameCollection(args);
      case 'collections.move': return this.wb.moveCollection(args);
      case 'collections.delete': return this.wb.deleteCollection(args);
      case 'skills.draft': return this.wb.derive(args);
      case 'approvals.approve': return this.approve(args);
      case 'approvals.unapprove': return this.unapprove(args);
      case 'trials.create': return this.wb.prepareTrial(args);
      case 'trials.finish': return this.wb.finishTrial(args);
      case 'trials.delete': return this.wb.deleteTrial(args);
      case 'trials.judge': return this.wb.judgeTrial(args);
      case 'targets.enroll': return this.wb.enroll(args);
      case 'deploy.plan': return this.deployments.plan(args);
      case 'deploy.apply': return this.deployments.apply(args);
      case 'deploy.rollback': return this.deployments.rollback(args);
      case 'deploy.uninstall': return this.deployments.uninstall(args);
      case 'deploy.installations': return this.deployments.installations(z.object({ itemId: idSchema.optional() }).parse(args).itemId);
      case 'deploy.drift': return this.deployments.drift();
      case 'deploy.compare': return this.deployments.compare(args);
      case 'deploy.recover': return this.deployments.recover();
      case 'providers.detect': return detectProviders();
      case 'observations.list': return this.wb.observations();
      case 'git.inventory': return inventory(z.object({ root: z.string().min(1) }).parse(args).root);
      case 'git.diff': return gitDiff(this.wb.root);
      case 'git.conflicts': return conflicts(this.wb);
      case 'git.merge': return this.gitQueue.run(() => mergeFetched(this.wb));
      case 'git.resolve': return resolveItemConflict(this.wb, args);
      case 'git.finishMerge': return this.gitQueue.run(() => finishMerge(this.wb));
      case 'git.checkpoint': return checkpoint(this.wb.root, this.wb.canonical, z.object({ message: z.string().trim().min(1).max(300) }).parse(args).message);
      case 'sync.status': return this.fetcher.status();
      case 'sync.fetch': return this.fetcher.fetch(z.object({ maxAgeMs: z.number().int().min(0).default(0) }).parse(args).maxAgeMs);
      case 'sync.pull': return this.gitQueue.run(() => this.pull());
      case 'git.sync': { const { action } = z.object({ action: z.enum(['fetch', 'pull', 'push']) }).parse(args); return this.gitQueue.run(() => sync(this.wb.root, this.wb.canonical, action)); }
      default: throw new WorkbenchError('CAPABILITY_UNSUPPORTED', `Unsupported operation: ${method}`);
    }
  }
  /** Groups of likely copies, each copy with enough to tell them apart (the CLI prints this as it is). */
  duplicates() {
    const byId = new Map(this.wb.snapshot().items.map(i => [i.id, i]));
    return { groups: this.wb.duplicateGroups().map(group => ({ ...group, items: group.ids.flatMap(id => { const i = byId.get(id); return i ? [{ id, title: i.title, kind: i.kind, collection: i.collection, status: i.status, revision: i.revision, source: i.source, updatedAt: i.updatedAt }] : []; }) })) };
  }
  /** Consolidation (Workbench.consolidate), plus marks for other machines moved from the merged copies to the kept one. */
  consolidate(args: unknown) {
    const result = this.wb.consolidate(args);
    const marks = this.fleet.repoint(result.merged, result.kept.id);
    return { ...result, undo: { ...result.undo, marks } };
  }
  unconsolidate(args: unknown) {
    const { marks } = z.object({ keep: idSchema, marks: z.array(z.object({ machineId: idSchema, itemId: idSchema, location: z.string(), had: z.boolean() })).max(2000).default([]) }).passthrough().parse(args);
    const result = this.wb.unconsolidate(args);
    this.fleet.unpoint(marks.filter(m => result.restored.includes(m.itemId)), result.kept.id);
    return result;
  }
  /** Approval is recorded at once; the commit and push to GitHub follow in the background and show up under `publish`. */
  approve(args: unknown) {
    const approval = this.wb.approve(args);
    if (this.wb.repositoryState().ready) this.publisher.enqueue('approve', approval.itemId, approval.revision);
    return approval;
  }
  unapprove(args: unknown) {
    const item = this.wb.unapprove(args);
    if (this.wb.repositoryState().ready) this.publisher.enqueue('unapprove', item.id, item.revision);
    return item;
  }
  /** Update and keep actions may approve on the way; that approval is pushed to GitHub like an explicit Approve. */
  private published<T extends { itemId: string; approved: boolean; revision: string }>(result: T) {
    if (result.approved && this.wb.repositoryState().ready) this.publisher.enqueue('approve', result.itemId, result.revision);
    return result;
  }
  /**
   * Model invocation on or off (invocation.ts). The switch lives in the skill's own files, so this saves a revision. When the
   * current revision is approved here, the change is flag-only by construction: the approval is carried over (and pushed like any
   * approval), then Kiln's unchanged copies are brought up to it through the one update path, which skips and names edited,
   * unmanaged and linked copies. A draft is only edited; approving it stays with the user.
   */
  setInvocation(args: unknown): InvocationResult {
    const data = z.object({ itemId: idSchema, model: z.boolean(), expect: hashSchema.optional() }).parse(args);
    const item = this.wb.getItem(data.itemId);
    invariant(item.kind === 'skill', 'NOT_A_SKILL', 'Only skills have a model-invocation switch.');
    invariant(!item.deletedAt, 'ITEM_DELETED', 'Restore this skill first.');
    invariant(!data.expect || data.expect === item.revision, 'REVISION_CONFLICT', 'This skill changed since you opened it. Reload it and try again.');
    const before = this.wb.authoring(item.id), next = setModelInvocation(before, data.model);
    const approved = this.wb.approvals().some(a => a.itemId === item.id && a.revision === item.revision && a.trust === 'local');
    if (next.content === before.content && JSON.stringify(next.files) === JSON.stringify(before.files)) return { itemId: item.id, title: item.title, revision: item.revision, changed: false, approval: approved ? 'carried' : 'draft', invocation: readInvocation(next), update: null };
    const updated = this.updateItem({ id: item.id, expect: item.revision, summary: data.model ? 'Model invocation turned on' : 'Model invocation turned off', value: next });
    if (!approved) return { itemId: item.id, title: item.title, revision: updated.revision, changed: true, approval: 'draft', invocation: readInvocation(next), update: null };
    this.wb.approveFlagChange({ id: item.id, revision: updated.revision, from: item.revision });
    if (this.wb.repositoryState().ready) this.publisher.enqueue('approve', item.id, updated.revision);
    return { itemId: item.id, title: item.title, revision: updated.revision, changed: true, approval: 'carried', invocation: readInvocation(next), update: this.deployments.updateInstalls({ itemId: item.id }) };
  }
  /** Installing an unapproved revision approves it first, so the same push to GitHub happens as with an explicit Approve. */
  installSkill(args: unknown) {
    const { itemId } = z.object({ itemId: idSchema }).passthrough().parse(args);
    const before = this.wb.getItem(itemId).revision;
    const wasApproved = this.wb.approvals().some(a => a.itemId === itemId && a.revision === before && a.trust === 'local');
    const result = this.deployments.installSkill(args);
    if (!wasApproved && this.wb.repositoryState().ready) this.publisher.enqueue('approve', itemId, before);
    return result;
  }
}
