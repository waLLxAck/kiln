import { scanAgents, importAgents } from './agents-import';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { idSchema, hashSchema } from '../protocol/schema';
import { invariant } from './errors';
import { Workbench } from './workbench';
import { DeploymentService } from '../deployment/service';
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

import { BackgroundFetch, pullFetched, requireAutoSync } from '../git/sync';
import { experimentOn } from '../protocol/experiments';

const sourceSchema = z.object({ source: z.string().min(1).optional() });
/** Methods that can change how published items are organised or which installs are wanted; see `Router.organiseSoon`. */
const organisingMethods = new Set(['items.move', 'items.reorder', 'items.meta', 'items.update', 'collections.save', 'collections.create', 'collections.rename', 'collections.move', 'collections.delete', 'skills.install', 'skills.remove', 'skills.removeAllLocal', 'skills.sync', 'skills.import', 'deploy.apply', 'deploy.uninstall', 'deploy.rollback']);
export type RouterOptions = { log?: (event: string, fields?: Record<string, unknown>) => void; /** Overrides the commit-message writer (tests inject a stub); `null` skips the agent and uses the plain message. */ composer?: Composer | null; /** Writes revision notes the user left empty; defaults to the commit-message model, `null` (or `composer: null`) keeps the placeholder. */ describer?: Describer | null; home?: HomeFiles };
export class Router {
  readonly deployments: DeploymentService;
  readonly publisher: Publisher;
  /** Background fetch for the autoSync experiment; idle unless the desktop app asks for it. */
  readonly fetcher: BackgroundFetch;
  private organiseTimer?: ReturnType<typeof setTimeout>;
  /** Items whose desired installs changed since the last organisation job was queued. */
  private installsChanged = new Set<string>();
  readonly home: HomeFiles;
  private readonly describer: Describer | null;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  constructor(readonly wb: Workbench, options: RouterOptions = {}) {
    this.deployments = new DeploymentService(wb);
    this.publisher = new Publisher(wb, options.log, options.composer);
    this.fetcher = new BackgroundFetch(wb, () => this.publisher.busy);
    this.publisher.beforePush = () => this.fetcher.idle();
    this.describer = options.describer !== undefined ? options.describer : options.composer === null ? null : codexDescriber;
    this.log = options.log ?? (() => {});
    this.home = options.home ?? new HomeFiles({ privateRoot: path.dirname(wb.local), projects: () => wb.targets().filter(t => t.scope === "project").map(t => t.root) });
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
    if (before) {
      const after = this.wb.installs();
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) this.installsChanged.add(id);
      this.organiseSoon();
    }
    return result;
  }
  private autoSyncReady() { return experimentOn(this.wb.settings(), 'autoSync') && this.wb.repositoryState().ready; }
  /** autoSync: organisation of published items follows them to GitHub a moment later, so a burst of moves makes one commit. */
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
      case 'items.read': return this.wb.detail(z.object({ id: idSchema }).parse(args).id);
      case 'items.origins': return this.wb.origins(args);
      case 'items.revision': { const a = z.object({ id: idSchema, revision: hashSchema }).parse(args); return this.wb.getRevision(a.id, a.revision); }
      case 'items.create': return this.wb.create(args);
      case 'items.update': return this.updateItem(args);
      case 'items.meta': return this.wb.setMeta(args);
      case 'items.move': return this.wb.moveItems(args);
      case 'items.restore': return this.wb.restore(args);
      case 'items.purge': return this.wb.purge(args);
      case 'agents.scan': return scanAgents(this.wb, args);
      case 'agents.import': return importAgents(this.wb, args);
      case 'skills.install': return this.installSkill(args);
      case 'skills.previewRemoval': return this.deployments.previewRemoval(args);
      case 'skills.removeAllLocal': return this.deployments.removeAllLocal(args);
      case 'skills.remove': return this.deployments.removeSkill(args);
      case 'skills.scan': return this.deployments.scan(z.object({ targetId: idSchema }).parse(args).targetId);
      case 'skills.cleanEntry': return this.deployments.cleanScanEntry(args);
      case 'skills.import': return this.deployments.importExternal(args);
      case 'skills.sync': return this.deployments.syncInstalls();
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
      case 'git.merge': return mergeFetched(this.wb);
      case 'git.resolve': return resolveItemConflict(this.wb, args);
      case 'git.finishMerge': return finishMerge(this.wb);
      case 'git.checkpoint': return checkpoint(this.wb.root, this.wb.canonical, z.object({ message: z.string().trim().min(1).max(300) }).parse(args).message);
      case 'sync.status': requireAutoSync(this.wb); return this.fetcher.status();
      case 'sync.fetch': return this.fetcher.fetch(z.object({ maxAgeMs: z.number().int().min(0).default(0) }).parse(args).maxAgeMs);
      case 'sync.pull': return this.pull();
      case 'git.sync': return sync(this.wb.root, this.wb.canonical, z.object({ action: z.enum(['fetch', 'pull', 'push']) }).parse(args).action);
      default: throw new WorkbenchError('CAPABILITY_UNSUPPORTED', `Unsupported operation: ${method}`);
    }
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
