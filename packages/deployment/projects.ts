import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Workbench } from '../domain/workbench';
import type { CopyPreview, DeploymentService } from './service';
import { invariant } from '../domain/errors';
import { idSchema, hashSchema, type ProviderId, type Target } from '../protocol/schema';
import { noLinks } from '../storage/files';
import { skillLocation, type SkillLocation } from '../providers/skill-locations';

// Install into project folders.

/** Where a project gets a skill: the shared Agents folder, Claude's, or Copilot's `.github/skills`. */
export type ProjectLocation = 'agents' | 'claude' | 'copilot';
/** Project targets are one per client; the location decides which. Codex targets have always written `.agents/skills`. */
export const locationProvider: Record<ProjectLocation, ProviderId> = { agents: 'codex', claude: 'claude', copilot: 'copilot' };
export type ProjectSource = 'installs' | 'experiments' | 'config';
export type ProjectEntry = { root: string; source: ProjectSource; name?: string; at?: string | null };
export type MergedProject = { key: string; root: string; name: string; sources: ProjectSource[]; lastUsed: string | null };
export type KnownProject = MergedProject & { exists: boolean; /** Enrolled project targets for this folder; Forget removes them. */ targets: { id: string; provider: ProviderId; location: SkillLocation }[]; /** Copies Kiln installed here that are still on disk. Forget refuses while any remain. */ managed: number };

/**
 * Identity of a project folder: `path.resolve` (so a trailing separator or `..` does not matter), and case-insensitive only on
 * Windows, where `C:\Work` and `c:\work\` are the same folder.
 */
export function projectKey(root: string, platform: NodeJS.Platform = process.platform) {
  const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(root);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
/**
 * One list of project folders from every place Kiln has met one: enrolled install targets, experiment folders and Config files
 * projects. The same folder appears once with all its sources; most recently used first, then by name. The first entry for a
 * folder gives its displayed path, so pass enrolled targets first to keep their spelling.
 */
export function mergeProjects(entries: ProjectEntry[], platform: NodeJS.Platform = process.platform): MergedProject[] {
  const p = platform === 'win32' ? path.win32 : path.posix, merged = new Map<string, MergedProject>();
  for (const entry of entries) {
    if (!entry.root || !p.isAbsolute(entry.root)) continue;
    const key = projectKey(entry.root, platform), at = entry.at || null;
    const found = merged.get(key) ?? { key, root: p.resolve(entry.root), name: '', sources: [], lastUsed: null };
    if (!found.name) found.name = entry.name?.trim() || p.basename(found.root) || found.root;
    if (!found.sources.includes(entry.source)) found.sources.push(entry.source);
    if (at && (!found.lastUsed || at > found.lastUsed)) found.lastUsed = at;
    merged.set(key, found);
  }
  return [...merged.values()].sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') || a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}

const recentSchema = z.object({ recent: z.array(z.object({ path: z.string().min(1).max(4096), at: z.string().max(40).optional() })).max(1000).default([]) });
const placeSchema = z.object({ itemId: idSchema, root: z.string().min(1).max(4096), location: z.enum(['agents', 'claude', 'copilot']).optional() });
export type ProjectPreview = CopyPreview & { root: string; name: string; location: ProjectLocation | null; provider: ProviderId; /** False until the first install enrols the folder as a project target. */ enrolled: boolean };

/**
 * Installing into any project folder without enrolling it first. Enrolment happens on the first install, reusing an existing target
 * for the same folder and client; the install itself is the ordinary one (approve if needed, plan, apply, receipt). Project installs
 * are never written to installs.json: project paths belong to this machine.
 */
export class ProjectInstalls {
  constructor(private wb: Workbench, private deployments: DeploymentService, private savedProjects: () => string[], private install: (args: unknown) => { destination: string; method: string }) {}
  private targetsAt(root: string) { const key = projectKey(root); return this.wb.targets().filter(t => t.scope === 'project' && projectKey(t.root) === key); }
  /** Latest applied receipts for copies in this folder's targets that are still on disk. */
  private managedCopies(root: string) {
    const ids = new Set(this.targetsAt(root).map(t => t.id)), receipts = this.deployments.receipts();
    return [...new Set(receipts.filter(r => ids.has(r.targetId)).map(r => r.destination))]
      .map(destination => receipts.filter(r => r.destination === destination).at(-1)!)
      .filter(r => r.status === 'applied' && ids.has(r.targetId) && fs.lstatSync(r.destination, { throwIfNoEntry: false }));
  }
  known(input: unknown = {}): KnownProject[] {
    const { recent } = recentSchema.parse(input ?? {}), receipts = this.deployments.receipts();
    const targets = this.wb.targets().filter(t => t.scope === 'project');
    const merged = mergeProjects([
      ...targets.map(t => ({ root: t.root, source: 'installs' as const, name: t.name, at: receipts.filter(r => r.targetId === t.id).at(-1)?.createdAt ?? null })),
      ...recent.map(r => ({ root: r.path, source: 'experiments' as const, at: r.at ?? null })),
      ...this.savedProjects().map(root => ({ root, source: 'config' as const })),
    ]);
    return merged.map(project => {
      let exists = false; try { exists = fs.statSync(project.root).isDirectory(); } catch { /* A moved or deleted folder stays listed so it can be forgotten. */ }
      return { ...project, exists, targets: this.targetsAt(project.root).map(t => ({ id: t.id, provider: t.provider, location: skillLocation(t) })), managed: this.managedCopies(project.root).length };
    });
  }
  private place(input: unknown) {
    const data = placeSchema.parse(input);
    invariant(path.isAbsolute(data.root), 'INVALID_PATH', 'Choose a project by its full path.');
    const root = path.resolve(data.root);
    let folder = false; try { folder = fs.statSync(root).isDirectory(); } catch { /* reported below */ }
    invariant(folder, 'INVALID_PATH', 'This project folder does not exist any more. Choose it again.'); noLinks(root);
    // Compared as real paths, so a library reached through a link (or a folder named by its link-free path) is still recognised.
    const real = (folder: string) => { try { return fs.realpathSync(folder); } catch { return path.resolve(folder); } };
    const chosen = projectKey(real(root)), library = projectKey(real(this.wb.root));
    invariant(chosen !== library && !chosen.startsWith(library + path.sep), 'INVALID_TARGET', 'The library folder itself cannot be a project to install into.');
    const item = this.wb.getItem(data.itemId), revision = this.wb.getRevision(item.id);
    invariant(!item.deletedAt, 'ITEM_DELETED', 'Restore this item before installing it.');
    invariant(['skill', 'agent'].includes(item.kind), 'NOT_DEPLOYABLE', 'Only skills and agent definitions can be installed into a project.');
    // An agent definition keeps its client's format, so its client decides the folder; a skill goes where the user chose.
    const location = item.kind === 'skill' ? data.location ?? 'agents' : null;
    const provider = location ? locationProvider[location] : revision.agent?.provider;
    invariant(provider, 'INVALID_AGENT', 'This agent definition does not say which client it is for.');
    const others = this.targetsAt(root), existing = others.find(t => t.provider === provider && !t.skillFolder);
    const name = (others[0]?.name ?? (path.basename(root) || root)).slice(0, 100);
    const target: Target = existing ?? { id: '', name, root, provider, scope: 'project', profile: 'Personal', machine: 'local' };
    return { data, root, name, location, provider, existing, target };
  }
  preview(input: unknown): ProjectPreview {
    const { data, root, name, location, provider, existing, target } = this.place(input);
    return { ...this.deployments.inspectCopy(data.itemId, target), root, name, location, provider, enrolled: Boolean(existing) };
  }
  /**
   * Installs what `preview` showed. `expect` is that preview's state and hash: if the folder changed since, nothing is written.
   * A differing or edited folder needs `replace`, which sets it aside under Kiln's private data first (never deleted).
   */
  apply(input: unknown) {
    const extra = z.object({ replace: z.boolean().default(false), confirm: z.literal(true), expect: z.object({ state: z.string(), current: hashSchema.nullable() }) }).passthrough().parse(input);
    const { data, root, name, provider, existing, target } = this.place(input);
    const now = this.deployments.inspectCopy(data.itemId, target);
    invariant(now.state === extra.expect.state && now.current === extra.expect.current, 'TARGET_CHANGED', 'The folder changed since the preview. Nothing was written; check the preview again.');
    invariant(!now.problem, 'VALIDATION_FAILED', now.problem);
    invariant(extra.replace || !['differs', 'drifted'].includes(now.state), now.state === 'drifted' ? 'TARGET_DRIFTED' : 'TARGET_UNMANAGED', 'A different copy is already there. Confirm replacing it to set it aside and install this one.');
    const enrolled = existing ?? this.wb.enroll({ name, root, provider, scope: 'project' }) as Target;
    const result = this.install({ itemId: data.itemId, targetId: enrolled.id, replace: extra.replace, confirm: true });
    return { ...result, targetId: enrolled.id, enrolled: !existing, name: enrolled.name };
  }
  /** Stops installing into a folder: removes its enrolled targets, only once no copy Kiln installed there is left. The folder is untouched. */
  forget(input: unknown) {
    const { root } = z.object({ root: z.string().min(1).max(4096), confirm: z.literal(true) }).parse(input);
    const targets = this.targetsAt(root);
    invariant(targets.length, 'TARGET_NOT_ENROLLED', 'Kiln does not install into this folder, so there is nothing to forget.');
    const managed = this.managedCopies(root);
    const titles = [...new Set(managed.map(r => { try { return this.wb.getItem(r.itemId).title; } catch { return 'an item no longer in the library'; } }))];
    invariant(!managed.length, 'COPIES_REMAIN', `Kiln still manages ${managed.length === 1 ? 'a copy' : `${managed.length} copies`} in this folder (${titles.join(', ')}). Remove ${managed.length === 1 ? 'it' : 'them'} from the Installs tab first.`);
    for (const target of targets) this.wb.removeTarget({ id: target.id, confirm: true });
    return { root: path.resolve(root), removed: targets.length };
  }
}
