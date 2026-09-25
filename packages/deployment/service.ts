import { MAX_ATTACHMENT_BYTES } from '../protocol/limits';
import { targetSkillsFolder, skillLocation, locationFolder, type SkillLocation } from '../providers/skill-locations';
import { scanAgents } from '../domain/agents-import';
import { agentFolder } from '../domain/agent-format';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Workbench } from '../domain/workbench';
import { invariant } from '../domain/errors';
import { isTextFile, skillName, validateContent } from '../domain/content';
import { hashSchema, idSchema, type Installation, type Item, type Plan, type ProviderId, type Receipt, type Revision, type Target } from '../protocol/schema';
import { contained, digest, noLinks, now, readJson, readRecords, safeRelative, withLock, writeJson } from '../storage/files';

export function readDestination(destination: string): Record<string, string> | null {
  noLinks(destination);
  if (!fs.existsSync(destination)) return null;
  if (fs.statSync(destination).isFile()) return { '.instruction': fs.readFileSync(destination).toString('base64') };
  const files: Record<string, string> = {};
  let bytes = 0;
  const visit = (dir: string, relative: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      invariant(!entry.isSymbolicLink(), 'SYMLINK_REJECTED', 'A managed destination contains a symlink.');
      const name = relative ? `${relative}/${entry.name}` : entry.name; safeRelative(name);
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, name);
      else {
        invariant(entry.isFile(), 'INVALID_TARGET', 'Destination contains a special file.');
        bytes += fs.statSync(file).size; invariant(bytes <= MAX_ATTACHMENT_BYTES, 'TARGET_TOO_LARGE', 'Destination exceeds the managed bundle size limit.');
        files[name] = fs.readFileSync(file).toString('base64');
      }
    }
  };
  visit(destination, ''); return files;
}
const stateHash = (files: Record<string, string> | null) => files === null ? null : digest(files);
const COMPARE_TEXT_LIMIT = 200_000;
/** One path present in the library revision, the installed folder, or both. `library`/`installed` hold decoded text for text files, null otherwise. */
export type ComparedFile = { path: string; status: 'same' | 'changed' | 'only_library' | 'only_installed'; text: boolean; library: string | null; installed: string | null; librarySize: number | null; installedSize: number | null };
export type Comparison = { destination: string; revision: string; exists: boolean; files: ComparedFile[] };
export type RemovalEntry = { itemId: string; title: string; destination: string; fingerprint: string; method: 'delete' | 'unlink' | 'backup' | 'blocked'; reason: string; result?: string; error?: string };
export type RemovalPlan = { id: string; itemIds: string[]; entries: RemovalEntry[]; createdAt: string; complete?: boolean };

type Journal = { id: string; destination: string; stage: string; backup: string; expected: string | null; proposed: string | null; receipt: Receipt; phase: 'prepared' | 'switched' | 'complete' };

export class DeploymentService {
  constructor(private wb: Workbench) {}
  receipts() { return readRecords(path.join(this.wb.local, 'receipts'), v => v as Receipt).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  private target(id: string) {
    const target = this.wb.targets().find(t => t.id === id); invariant(target, 'TARGET_NOT_ENROLLED', 'Enroll this environment before deployment.'); noLinks(target.root); return target;
  }
  private render(itemId: string, revision: string, target: Target) {
    const item = this.wb.getItem(itemId), bundle = this.wb.getRevision(itemId, revision);
    invariant(!item.deletedAt, 'ITEM_DELETED', 'Restore this item before deploying.');
    invariant(['skill', 'agent', 'instruction'].includes(bundle.kind), 'NOT_DEPLOYABLE', 'Only skills, agents and instruction resources can be deployed.');
    invariant(this.wb.approvals().some(a => a.itemId === itemId && a.revision === revision && a.trust === 'local'), 'APPROVAL_REQUIRED', 'Approve this exact revision before deployment. Imported approval records are historical evidence only.');
    const errors = validateContent(bundle); invariant(!errors.length, 'VALIDATION_FAILED', errors.join('\n'));
    let relative: string, files: Record<string, string>;
    if (bundle.kind === 'skill') {
      relative = `${targetSkillsFolder(target)}/${skillName(bundle)}`;
      files = { 'SKILL.md': Buffer.from(bundle.content).toString('base64'), ...bundle.files };
    } else if (bundle.kind === 'agent') {
      invariant(bundle.agent?.provider === target.provider, 'AGENT_CLIENT_MISMATCH', 'Choose the client this agent was written for.');
      relative = `${agentFolder(target.provider, target.scope)}/${bundle.agent.filename}`;
      files = { '.instruction': Buffer.from(bundle.content).toString('base64') };
    } else {
      invariant(Object.keys(bundle.files).length === 0, 'INSTRUCTION_ASSETS_UNSUPPORTED', 'Instruction attachments require explicit scope mapping. Use a skill bundle for supporting files.');
      relative = target.provider === 'copilot' ? (target.scope === 'project' ? '.github/copilot-instructions.md' : '.copilot/copilot-instructions.md') : target.scope === 'project' ? (target.provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md') : (target.provider === 'codex' ? '.codex/AGENTS.md' : '.claude/CLAUDE.md');
      files = { '.instruction': Buffer.from(bundle.content).toString('base64') };
    }
    const destination = contained(target.root, relative); noLinks(destination);
    return { destination, files, proposedHash: digest(files) };
  }
  private latest(destination: string) { const last = this.receipts().filter(r => r.destination === destination).at(-1); return last?.status === 'applied' ? last : undefined; }
  plan(input: unknown): Plan {
    const data = z.object({ itemId: idSchema, revision: hashSchema, targetId: idSchema }).parse(input);
    return withLock(this.wb.canonical, () => {
      const rendered = this.render(data.itemId, data.revision, this.target(data.targetId));
      const current = readDestination(rendered.destination), expectedState = stateHash(current), owner = this.latest(rendered.destination);
      let blocked: string | null = null;
      if (current && (!owner || owner.itemId !== data.itemId)) blocked = 'TARGET_UNMANAGED: This destination is not owned by this item. Existing files will not be replaced.';
      else if (owner && owner.hash !== expectedState) blocked = 'TARGET_DRIFTED: Destination changed outside Kiln. Restore or inspect it before applying.';
      const plan: Plan = { id: randomUUID(), ...data, ...rendered, expectedState, operation: current ? 'replace' : 'create', createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), blocked };
      writeJson(path.join(this.wb.local, 'plans', `${plan.id}.json`), plan); return plan;
    });
  }
  apply(input: unknown): Receipt {
    const data = z.object({ planId: idSchema, expectState: hashSchema.nullable(), confirm: z.literal(true) }).parse(input);
    return withLock(this.wb.canonical, () => {
      const existing = this.receipts().find(r => r.planId === data.planId);
      if (existing) { invariant(existing.status === 'applied', 'PLAN_ALREADY_USED', 'This plan already finished. Create a fresh plan.'); return existing; }
      const plan = readJson(path.join(this.wb.local, 'plans', `${data.planId}.json`)) as Plan;
      invariant(plan.id === data.planId && Date.parse(plan.expiresAt) > Date.now(), 'PLAN_EXPIRED', 'Create a fresh deployment preview.');
      invariant(!plan.blocked, 'TARGET_BLOCKED', plan.blocked ?? 'Destination blocked.');
      const target = this.target(plan.targetId), rendered = this.render(plan.itemId, plan.revision, target);
      invariant(rendered.destination === plan.destination && digest(rendered.files) === plan.proposedHash && digest(plan.files) === plan.proposedHash, 'PLAN_TAMPERED', 'Plan no longer matches its approved bundle.');
      const previousFiles = readDestination(plan.destination), current = stateHash(previousFiles), owner = this.latest(plan.destination);
      invariant(current === data.expectState && current === plan.expectedState, 'TARGET_DRIFTED', 'Destination changed after preview. No files were written.');
      invariant(current === null || (owner && owner.itemId === plan.itemId && owner.hash === current), 'TARGET_UNMANAGED', 'Destination ownership changed.');
      const receipt: Receipt = { id: randomUUID(), planId: plan.id, itemId: plan.itemId, revision: plan.revision, targetId: plan.targetId, destination: plan.destination, hash: plan.proposedHash, previousHash: current, previousFiles, previousRevision: owner?.revision ?? null, status: 'applied', createdAt: now(), newSessionRequired: true };
      this.switchBundle(target, receipt, rendered.files, current);
      this.wb.record('deployed', `Deployed approved snapshot to ${target.name}; start a new agent session`, plan.itemId, plan.revision);
      return receipt;
    });
  }
  private switchBundle(target: Target, receipt: Receipt, files: Record<string, string> | null, expected: string | null) {
    const destination = path.resolve(receipt.destination), root = path.resolve(target.root);
    invariant(destination.startsWith(root + path.sep), 'INVALID_PATH', 'Destination escapes the enrolled root.'); noLinks(destination);
    const stage = `${destination}.kiln-stage-${receipt.id}`, backup = `${destination}.kiln-backup-${receipt.id}`;
    invariant(!fs.existsSync(stage) && !fs.existsSync(backup), 'RECOVERY_REQUIRED', 'An unfinished deployment needs recovery first.');
    const journal: Journal = { id: receipt.id, destination, stage, backup, expected, proposed: stateHash(files), receipt, phase: 'prepared' };
    const journalFile = path.join(this.wb.local, 'journals', `${receipt.id}.json`);
    writeJson(journalFile, journal);
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (files) {
        if (Object.hasOwn(files, '.instruction')) fs.writeFileSync(stage, Buffer.from(files['.instruction'], 'base64'), { flag: 'wx' });
        else {
          fs.mkdirSync(stage);
          for (const [name, content] of Object.entries(files)) { const file = contained(stage, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(content, 'base64'), { flag: 'wx' }); }
        }
        invariant(stateHash(readDestination(stage)) === journal.proposed, 'STAGING_FAILED', 'Staged snapshot failed integrity verification.');
      }
      invariant(stateHash(readDestination(destination)) === expected, 'TARGET_DRIFTED', 'Destination changed while staging.');
      if (fs.existsSync(destination)) fs.renameSync(destination, backup);
      if (files) fs.renameSync(stage, destination);
      invariant(stateHash(readDestination(destination)) === journal.proposed, 'APPLY_FAILED', 'Installed snapshot failed verification.');
      journal.phase = 'switched'; writeJson(journalFile, journal);
      writeJson(path.join(this.wb.local, 'receipts', `${receipt.id}.json`), receipt);
      journal.phase = 'complete'; writeJson(journalFile, journal);
      this.removeOwnedSibling(backup, root, expected);
    } catch (error) {
      receipt.status = 'partial'; receipt.error = error instanceof Error ? error.message : String(error);
      writeJson(path.join(this.wb.local, 'receipts', `${receipt.id}.json`), receipt);
      throw error;
    }
  }
  private removeOwnedSibling(file: string, root: string, expected: string | null) {
    if (!fs.existsSync(file)) return;
    const resolved = path.resolve(file);
    invariant(resolved.startsWith(path.resolve(root) + path.sep) && /\.kiln-(backup|stage)-[a-f0-9-]+$/.test(resolved), 'INVALID_PATH', 'Cleanup path is not a managed staging path.');
    invariant(stateHash(readDestination(resolved)) === expected, 'TARGET_DRIFTED', 'Staging files changed; preserving them for inspection.');
    fs.rmSync(resolved, { recursive: true });
  }
  rollback(input: unknown) {
    const data = z.object({ receiptId: idSchema, expectState: hashSchema, confirm: z.literal(true) }).parse(input);
    return withLock(this.wb.canonical, () => {
      const receipt = this.receipts().find(r => r.id === data.receiptId); invariant(receipt && receipt.status === 'applied', 'RECEIPT_NOT_FOUND', 'Choose an active successful receipt.');
      const latest = this.latest(receipt.destination); invariant(latest?.id === receipt.id, 'STALE_RECEIPT', 'Only the latest deployment can be rolled back.');
      invariant(stateHash(readDestination(receipt.destination)) === receipt.hash && data.expectState === receipt.hash, 'TARGET_DRIFTED', 'Installed files changed. Rollback will not overwrite those changes.');
      const target = this.target(receipt.targetId);
      if (receipt.previousFiles) {
        invariant(receipt.previousRevision, 'APPROVAL_REQUIRED', 'Previous approved revision is missing.');
        const rendered = this.render(receipt.itemId, receipt.previousRevision, target);
        invariant(rendered.destination === receipt.destination && rendered.proposedHash === receipt.previousHash && digest(receipt.previousFiles) === receipt.previousHash, 'BUNDLE_TAMPERED', 'Rollback bundle no longer matches an approved revision.');
      }
      const reversal: Receipt = { ...receipt, id: randomUUID(), planId: `rollback-${receipt.id}`, revision: receipt.previousRevision ?? receipt.revision, hash: receipt.previousHash ?? digest({}), previousFiles: null, previousHash: null, previousRevision: null, status: receipt.previousFiles ? 'applied' : 'rolled_back', createdAt: now() };
      this.switchBundle(target, reversal, receipt.previousFiles, receipt.hash);
      writeJson(path.join(this.wb.local, 'receipts', `${receipt.id}.json`), { ...receipt, status: 'rolled_back' });
      this.wb.record('rolled_back', `Reversed deployment to ${target.name}`, receipt.itemId, reversal.revision); return reversal;
    });
  }
  uninstall(input: unknown) {
    const data = z.object({ receiptId: idSchema, expectState: hashSchema, confirm: z.literal(true) }).parse(input);
    return withLock(this.wb.canonical, () => {
      const receipt = this.receipts().find(r => r.id === data.receiptId);
      invariant(receipt && this.latest(receipt.destination)?.id === receipt.id, 'STALE_RECEIPT', 'Choose the current Kiln-owned installation.');
      invariant(data.expectState === receipt.hash && stateHash(readDestination(receipt.destination)) === receipt.hash, 'TARGET_DRIFTED', 'Installed files changed outside Kiln. Uninstall will not delete those changes.');
      const removal: Receipt = { ...receipt, id: randomUUID(), planId: `uninstall-${receipt.id}`, status: 'uninstalled', previousHash: receipt.hash, previousFiles: readDestination(receipt.destination), previousRevision: receipt.revision, createdAt: now() };
      this.switchBundle(this.target(receipt.targetId), removal, null, receipt.hash);
      this.wb.record('uninstalled', 'Uninstalled matching Kiln-owned skill; library and revision history retained', receipt.itemId, receipt.revision);
      return removal;
    });
  }
  /** Folder name a skill occupies inside a provider's skills directory, or '' when the item has no usable name. */
  private folderName(item: Item, revision?: Revision) {
    if (item.kind === 'agent') return (revision ?? this.wb.getRevision(item.id)).agent?.filename ?? '';
    let name = '';
    try { name = skillName(revision ?? this.wb.getRevision(item.id)); } catch { /* Unreadable revisions are reported by the library warnings. */ }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) name = item.source.match(/\/([^/]+)\/SKILL\.md$/)?.[1] ?? '';
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : '';
  }
  private skillDestination(target: Target, name: string, revision?: Revision) {
    if (revision?.kind === 'agent') {
      invariant(revision.agent?.provider === target.provider, 'AGENT_CLIENT_MISMATCH', 'Choose the client this agent was written for.');
      const errors = validateContent(revision); invariant(!errors.length, 'VALIDATION_FAILED', errors.join('\n'));
      return contained(target.root, `${agentFolder(target.provider, target.scope)}/${name}`);
    }
    return contained(target.root, `${targetSkillsFolder(target)}/${name}`);
  }
  /** Reads a destination even when it is a junction, by following it once. */
  private currentState(destination: string) {
    try { return stateHash(readDestination(destination)); }
    catch { try { return stateHash(readDestination(fs.realpathSync(destination))); } catch { return null; } }
  }
  private renderedHash(revision: Revision) { return digest(revision.kind === 'agent' ? { '.instruction': Buffer.from(revision.content).toString('base64') } : { 'SKILL.md': Buffer.from(revision.content).toString('base64'), ...revision.files }); }
  /**
   * File-by-file comparison of the current library revision against whatever sits in the skill folder, so a
   * "differs" or "drifted" verdict can be inspected rather than trusted. Text files carry their decoded contents
   * (capped) for a line diff; binary files carry sizes only. Nothing is written.
   */
  compare(input: unknown): Comparison {
    const data = z.object({ itemId: idSchema, targetId: idSchema }).parse(input);
    const item = this.wb.getItem(data.itemId), revision = this.wb.getRevision(item.id), target = this.target(data.targetId);
    invariant(['skill', 'agent'].includes(revision.kind), 'NOT_DEPLOYABLE', 'Only installed skills and agents can be compared.');
    const name = this.folderName(item, revision); invariant(name, 'INVALID_NAME', 'This skill has no valid folder name.');
    const destination = this.skillDestination(target, name, revision);
    const library: Record<string, string> = revision.kind === 'agent' ? { '.instruction': Buffer.from(revision.content).toString('base64') } : { 'SKILL.md': Buffer.from(revision.content).toString('base64'), ...revision.files };
    let installed: Record<string, string> | null = null;
    try { installed = readDestination(destination); } catch { try { installed = readDestination(fs.realpathSync(destination)); } catch { installed = null; } }
    const decode = (base64: string) => { const text = Buffer.from(base64, 'base64').toString('utf8'); return text.length > COMPARE_TEXT_LIMIT ? text.slice(0, COMPARE_TEXT_LIMIT) + '\n… truncated for display' : text; };
    const size = (base64: string) => Buffer.from(base64, 'base64').length;
    const files: ComparedFile[] = [...new Set([...Object.keys(library), ...Object.keys(installed ?? {})])].sort().map(file => {
      const a = library[file], b = installed?.[file], text = file === '.instruction' || isTextFile(file);
      const status: ComparedFile['status'] = a === undefined ? 'only_installed' : b === undefined ? 'only_library' : a === b ? 'same' : 'changed';
      return { path: file === '.instruction' ? revision.agent?.filename ?? file : file, status, text, library: a === undefined ? null : text ? decode(a) : null, installed: b === undefined ? null : text ? decode(b) : null, librarySize: a === undefined ? null : size(a), installedSize: b === undefined ? null : size(b) };
    });
    return { destination, revision: revision.hash, exists: installed !== null, files };
  }
  installations(itemId?: string | string[]): Installation[] {
    const result: Installation[] = [];
    const items = (Array.isArray(itemId) ? itemId.map(id => this.wb.getItem(id)) : itemId ? [this.wb.getItem(itemId)] : this.wb.listItems()).filter(item => ['skill', 'agent'].includes(item.kind));
    const receipts = this.receipts(), targets = this.wb.targets();
    for (const item of items) {
      let revision: Revision | undefined; try { revision = this.wb.getRevision(item.id); } catch { continue; }
      const name = this.folderName(item, revision); if (!name) continue;
      if (revision.kind === 'agent' && validateContent(revision).length) continue;
      const rendered = this.renderedHash(revision);
      const candidates = targets.filter(target => revision.kind !== 'agent' || (revision.agent?.provider === target.provider && !target.skillFolder)).map(target => ({ target, location: skillLocation(target), destination: this.skillDestination(target, name, revision) }));
      if (revision.kind === 'skill') {
        for (const target of targets) for (const location of ['agents', 'claude', 'codex', 'copilot'] as SkillLocation[]) {
          const destination = contained(target.root, `${locationFolder(location, target.scope)}/${name}`);
          if (!candidates.some(c => c.destination === destination)) candidates.push({ target: { ...target, id: '', provider: location === 'agents' ? 'codex' : location }, location, destination });
        }
      }
      const seen = new Set<string>();
      for (const { target, location, destination } of candidates) {
        if (seen.has(destination)) continue;
        seen.add(destination);
        if (!fs.lstatSync(destination, { throwIfNoEntry: false })) continue;
        const linked = fs.lstatSync(destination).isSymbolicLink(), last = receipts.filter(r => r.destination === destination).at(-1);
        const owned = last?.status === 'applied' && last.itemId === item.id ? last : undefined;
        const current = this.currentState(destination);
        const state: Installation['state'] = owned ? (current === owned.hash ? 'installed' : 'drifted') : 'external';
        result.push({ itemId: item.id, targetId: target.id, provider: target.provider, location: revision.kind === 'skill' ? location : undefined, scope: target.scope, destination, state, linked, matches: current !== null && current === rendered, receiptId: owned?.id ?? null });
      }
    }
    return result;
  }
  private removalCopies(itemIds: string[]): Installation[] {
    const copies = this.installations(itemIds), receipts = this.receipts(), targets = this.wb.targets();
    for (const receipt of receipts.filter(r => itemIds.includes(r.itemId) && r.status === 'applied')) {
      if (receipts.filter(r => r.destination === receipt.destination).at(-1)?.id !== receipt.id || copies.some(c => c.destination === receipt.destination)) continue;
      const target = targets.find(t => t.id === receipt.targetId), item = this.wb.getItem(receipt.itemId);
      if (!target || !['skill', 'agent'].includes(item.kind)) continue;
      const root = contained(target.root, item.kind === 'agent' ? agentFolder(target.provider, target.scope) : targetSkillsFolder(target));
      if (path.dirname(path.resolve(receipt.destination)) !== root) continue;
      const stat = fs.lstatSync(receipt.destination, { throwIfNoEntry: false }); if (!stat) continue;
      const current = this.currentState(receipt.destination);
      copies.push({ itemId: item.id, targetId: target.id, provider: target.provider, location: item.kind === 'skill' ? skillLocation(target) : undefined, scope: target.scope, destination: receipt.destination, state: current === receipt.hash ? 'installed' : 'drifted', linked: stat.isSymbolicLink(), matches: current === this.renderedHash(this.wb.getRevision(item.id)), receiptId: receipt.id });
    }
    return copies;
  }
  private removalEntry(copy: Installation): RemovalEntry {
    const item = this.wb.getItem(copy.itemId);
    const base = { itemId: item.id, title: item.title, destination: copy.destination, reason: '' };
    try {
      noLinks(path.dirname(copy.destination));
      const stat = fs.lstatSync(copy.destination);
      if (stat.isSymbolicLink()) return { ...base, fingerprint: digest({ link: fs.readlinkSync(copy.destination), ino: stat.ino }), method: 'unlink' };
      const files = readDestination(copy.destination);
      invariant(files !== null, 'TARGET_CHANGED', 'Copy no longer exists.');
      return { ...base, fingerprint: digest({ files, ino: stat.ino }), method: copy.matches && copy.state === 'installed' ? 'delete' : 'backup' };
    } catch (error) {
      return { ...base, fingerprint: '', method: 'blocked', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  previewRemoval(input: unknown): RemovalPlan {
    const { itemIds } = z.object({ itemIds: z.array(idSchema).min(1).max(5000) }).parse(input);
    const ids = [...new Set(itemIds)];
    const copies = this.removalCopies(ids);
    const unique = [...new Map(copies.map(copy => [path.resolve(copy.destination).toLowerCase(), copy])).values()];
    const plan: RemovalPlan = { id: randomUUID(), itemIds: ids, entries: unique.map(copy => this.removalEntry(copy)), createdAt: now() };
    writeJson(path.join(this.wb.local, 'removal-plans', `${plan.id}.json`), plan);
    return plan;
  }
  removeAllLocal(input: unknown): RemovalPlan {
    const { planId } = z.object({ planId: idSchema, confirm: z.literal(true) }).parse(input);
    const file = path.join(this.wb.local, 'removal-plans', `${planId}.json`);
    const plan = readJson(file) as RemovalPlan;
    if (plan.complete) return plan;
    const ids = z.array(idSchema).min(1).max(5000).parse(plan.itemIds);
    // Only paths still derived from selected items and configured roots may be removed.
    const copies = new Map(this.removalCopies(ids).map(copy => [copy.destination, copy]));
    for (const entry of plan.entries) {
      if (entry.result) continue;
      delete entry.error;
      try {
        const copy = copies.get(entry.destination);
        if (!copy) {
          invariant(!fs.lstatSync(entry.destination, { throwIfNoEntry: false }), 'TARGET_CHANGED', 'This path is no longer a known installation. Refresh the preview.');
          entry.result = 'Already absent';
        } else {
          const current = this.removalEntry(copy);
          invariant(entry.method !== 'blocked' && current.method === entry.method && current.fingerprint === entry.fingerprint, 'TARGET_CHANGED', current.reason || 'Copy changed since preview. Nothing was removed; create a new preview.');
          if (entry.method === 'unlink') {
            this.removeLink(entry.destination);
            const owner = this.latest(entry.destination);
            if (owner?.itemId === copy.itemId) {
              const closed: Receipt = { ...owner, id: randomUUID(), planId: `bulk-unlink-${plan.id}`, status: 'uninstalled', previousHash: null, previousFiles: null, previousRevision: owner.revision, createdAt: now() };
              writeJson(path.join(this.wb.local, 'receipts', `${closed.id}.json`), closed);
            }
            entry.result = 'Link removed; destination untouched';
          }
          else if (entry.method === 'delete') {
            const receipt = this.latest(entry.destination);
            invariant(receipt && receipt.itemId === copy.itemId, 'STALE_RECEIPT', 'Installation ownership changed. Refresh the preview.');
            this.uninstall({ receiptId: receipt.id, expectState: receipt.hash, confirm: true });
            entry.result = 'Removed';
          } else {
            const target = this.wb.targets().find(t => t.id === copy.targetId) ?? this.wb.targets().find(t => entry.destination.startsWith(path.resolve(t.root) + path.sep));
            invariant(target, 'TARGET_NOT_ENROLLED', 'Installation root is no longer configured.');
            const backup = this.setAside(entry.destination, target);
            entry.result = `Removed; backup: ${backup}`;
          }
          this.wb.record('uninstalled', `Bulk removal: ${entry.destination}`, copy.itemId);
          if (copy.scope === 'personal') {
            const token = copy.location === 'codex' ? 'codex-native' : copy.location === 'agents' ? 'codex' : copy.provider;
            this.wb.setInstall(copy.itemId, token, false);
          }
        }
      } catch (error) { entry.error = error instanceof Error ? error.message : String(error); }
      writeJson(file, plan);
    }
    const remaining = this.removalCopies(ids);
    for (const id of ids) {
      if (!remaining.some(copy => copy.itemId === id)) for (const provider of this.wb.installs()[id] ?? []) this.wb.setInstall(id, provider, false);
    }
    plan.complete = !plan.entries.some(entry => entry.error);
    writeJson(file, plan);
    return plan;
  }
  /** Personal environment for a provider: the enrolled personal-scope target rooted at the home folder, else the first personal-scope target. */
  personalTarget(provider: ProviderId | 'codex-native') {
    const home = path.resolve(os.homedir()).toLowerCase();
    const personal = this.wb.targets().filter(t => t.provider === (provider === 'codex-native' ? 'codex' : provider) && t.scope === 'personal' && Boolean(t.skillFolder) === (provider === 'codex-native'));
    return personal.find(t => path.resolve(t.root).toLowerCase() === home) ?? personal[0];
  }
  private removeLink(destination: string) {
    invariant(fs.lstatSync(destination).isSymbolicLink(), 'INVALID_TARGET', 'Expected a link.');
    try { fs.unlinkSync(destination); } catch { fs.rmdirSync(destination); }
    invariant(!fs.lstatSync(destination, { throwIfNoEntry: false }), 'REMOVE_FAILED', 'The link could not be removed.');
  }
  /**
   * Moves a folder into the machine-private `replaced` folder so nothing is lost. When Kiln owned the folder, an
   * `uninstalled` receipt closes that ownership so the destination reads as empty for the next plan.
   */
  private setAside(destination: string, target: Target) {
    const backup = path.join(this.wb.local, 'replaced', `${path.basename(destination)}-${randomUUID()}`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    const owner = this.latest(destination);
    const previousFiles = owner ? (() => { try { return readDestination(destination); } catch { return null; } })() : null;
    try { fs.renameSync(destination, backup); } catch { fs.cpSync(destination, backup, { recursive: true }); fs.rmSync(destination, { recursive: true, force: true }); }
    if (owner) {
      const closed: Receipt = { ...owner, id: randomUUID(), planId: `set-aside-${owner.id}`, status: 'uninstalled', previousHash: stateHash(previousFiles), previousFiles, previousRevision: owner.revision, createdAt: now() };
      writeJson(path.join(this.wb.local, 'receipts', `${closed.id}.json`), closed);
      this.wb.record('uninstalled', `Set aside the edited copy in ${target.name}; kept under ${backup}`, owner.itemId, owner.revision);
    }
    return backup;
  }
  /** Records Kiln ownership of a folder whose bytes already equal the revision, so it can later be updated or removed like any install. */
  private adopt(target: Target, item: Item, revision: Revision, destination: string) {
    const current = stateHash(readDestination(destination)); invariant(current === this.renderedHash(revision), 'TARGET_UNMANAGED', 'Folder content differs from the library revision.');
    return withLock(this.wb.canonical, () => {
      const receipt: Receipt = { id: randomUUID(), planId: `adopt-${randomUUID()}`, itemId: item.id, revision: revision.hash, targetId: target.id, destination, hash: current, previousHash: null, previousFiles: null, previousRevision: null, status: 'applied', createdAt: now(), newSessionRequired: true };
      writeJson(path.join(this.wb.local, 'receipts', `${receipt.id}.json`), receipt);
      this.wb.record('adopted', `Kiln now manages the existing copy in ${target.name}`, item.id, revision.hash); return receipt;
    });
  }
  /**
   * One-click install of the current revision into an enrolled environment.
   * Approves the revision when needed, takes over an identical existing copy, replaces a junction with a real copy,
   * and refuses to overwrite a differing external folder unless `replace` is set (the folder is then set aside, not deleted).
   */
  installSkill(input: unknown) {
    const data = z.object({ itemId: idSchema, targetId: idSchema, replace: z.boolean().default(false), confirm: z.literal(true) }).parse(input);
    const target = this.target(data.targetId); let item = this.wb.getItem(data.itemId); const revision = this.wb.getRevision(item.id);
    invariant(['skill', 'agent'].includes(item.kind), 'NOT_DEPLOYABLE', 'Only skills and agents can be installed here.');
    const errors = validateContent(revision); invariant(!errors.length, 'VALIDATION_FAILED', errors.join('\n'));
    const name = this.folderName(item, revision); invariant(name, 'INVALID_SKILL_NAME', 'Give the skill a lowercase hyphenated name in its frontmatter first.');
    const destination = this.skillDestination(target, name, revision);
    if (!this.wb.approvals().some(a => a.itemId === item.id && a.revision === revision.hash && a.trust === 'local')) {
      this.wb.approve({ id: item.id, revision: revision.hash, reviewer: os.userInfo().username, scope: 'Installed from Kiln', note: 'Approved by choosing Install in Kiln.', waivedChecks: 'Installed directly; no trial evidence linked.' });
      item = this.wb.getItem(item.id);
    }
    let setAside: string | null = null, receipt: Receipt | null = null, method: 'installed' | 'updated' | 'adopted' | 'unchanged' = 'installed';
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
      if (fs.lstatSync(destination).isSymbolicLink()) this.removeLink(destination);
      else {
        const owned = this.latest(destination), current = this.currentState(destination), wanted = this.renderedHash(revision);
        if (owned?.itemId === item.id && current === wanted) { receipt = owned; method = 'unchanged'; }
        else if (owned?.itemId === item.id && current === owned.hash) method = 'updated';
        else if (owned?.itemId !== item.id && current === wanted) { receipt = this.adopt(target, item, revision, destination); method = 'adopted'; }
        else {
          invariant(data.replace, owned?.itemId === item.id ? 'TARGET_DRIFTED' : 'TARGET_UNMANAGED', owned?.itemId === item.id ? 'The installed copy was edited outside Kiln. Choose Replace to set those edits aside and reinstall.' : `A different “${name}” folder already exists there. Import it into the library first, or choose Replace to set it aside and install the library version.`);
          setAside = this.setAside(destination, target);
        }
      }
    }
    if (!receipt) {
      const plan = this.plan({ itemId: item.id, revision: revision.hash, targetId: target.id });
      invariant(!plan.blocked, 'TARGET_BLOCKED', plan.blocked ?? 'Destination blocked.');
      receipt = this.apply({ planId: plan.id, expectState: plan.expectedState, confirm: true });
    }
    if (target.scope === 'personal') this.wb.setInstall(item.id, item.kind === 'skill' && target.skillFolder ? 'codex-native' : target.provider, true);
    return { destination, method, setAside, receipt, provider: target.provider };
  }
  /**
   * One-click removal from an enrolled environment. Kiln-owned copies go through uninstall; junctions are unlinked;
   * an identical external copy is adopted then uninstalled; a differing external copy needs `force`, which sets it aside.
   */
  removeSkill(input: unknown) {
    const data = z.object({ itemId: idSchema, targetId: idSchema, force: z.boolean().default(false), confirm: z.literal(true) }).parse(input);
    const target = this.target(data.targetId), item = this.wb.getItem(data.itemId), revision = this.wb.getRevision(item.id);
    const name = this.folderName(item, revision); invariant(name, 'INVALID_SKILL_NAME', 'This skill has no usable folder name.');
    const destination = this.skillDestination(target, name, revision);
    let method: 'uninstalled' | 'unlinked' | 'set aside' | 'absent' = 'absent';
    if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
      if (fs.lstatSync(destination).isSymbolicLink()) { this.removeLink(destination); method = 'unlinked'; this.wb.record('uninstalled', `Removed the link in ${target.name}; the linked folder is untouched`, item.id, revision.hash); }
      else {
        let owned = this.latest(destination); const current = this.currentState(destination);
        if ((!owned || owned.itemId !== item.id) && current === this.renderedHash(revision)) owned = this.adopt(target, item, revision, destination);
        if (owned && owned.itemId === item.id && owned.hash === current) { this.uninstall({ receiptId: owned.id, expectState: owned.hash, confirm: true }); method = 'uninstalled'; }
        else { invariant(data.force, owned ? 'TARGET_DRIFTED' : 'TARGET_UNMANAGED', `The “${name}” folder there differs from your library. Import it first to keep those changes, or choose Remove anyway to set the folder aside.`); this.setAside(destination, target); method = 'set aside'; this.wb.record('uninstalled', `Set aside an external “${name}” folder from ${target.name}`, item.id, revision.hash); }
      }
    }
    if (target.scope === 'personal') this.wb.setInstall(item.id, item.kind === 'skill' && target.skillFolder ? 'codex-native' : target.provider, false);
    return { destination, method, provider: target.provider };
  }
  /** Skill folders in an environment that no library item claims. */
  scan(targetId: string) {
    const target = this.target(targetId);
    const root = contained(target.root, targetSkillsFolder(target));
    const agentsRoot = contained(target.root, agentFolder(target.provider, target.scope));
    const agents = (target.skillFolder ? [] : scanAgents(this.wb, { root: agentsRoot, provider: target.provider })).filter(entry => !entry.imported).map(entry => ({ kind: 'agent' as const, cleanup: null, name: entry.name, destination: entry.path, linked: false, hasSkillFile: !entry.error, realPath: entry.path, error: entry.error }));
    const claimed = new Set(this.wb.listItems().filter(i => i.kind === 'skill').map(i => this.folderName(i)).filter(Boolean));
    const entries = (fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => {
      const destination = path.join(root, entry.name); let realPath = destination;
      try { realPath = fs.realpathSync(destination); } catch { if (entry.isSymbolicLink()) realPath = path.resolve(path.dirname(destination), fs.readlinkSync(destination)); }
      const brokenLink = entry.isSymbolicLink() && !fs.existsSync(destination);
      const emptyFolder = !entry.isSymbolicLink() && fs.readdirSync(destination).length === 0;
      return { cleanup: brokenLink ? 'link' as const : emptyFolder ? 'folder' as const : null, name: entry.name, destination, linked: entry.isSymbolicLink(), hasSkillFile: fs.existsSync(path.join(realPath, 'SKILL.md')), realPath };
    }).filter(entry => !claimed.has(entry.name) || entry.cleanup);
    return { root, agentsRoot, entries: [...entries.map(entry => ({ ...entry, kind: 'skill' as const, error: entry.cleanup === 'link' ? 'Broken link: its destination no longer exists.' : entry.cleanup === 'folder' ? 'Empty folder: no skill files remain.' : '' })), ...agents] };
  }
  cleanScanEntry(input: unknown) {
    const data = z.object({ targetId: idSchema, name: z.string(), confirm: z.literal(true) }).parse(input);
    safeRelative(data.name);
    invariant(!data.name.includes('/'), 'INVALID_PATH', 'Expected a folder name.');
    const target = this.target(data.targetId);
    const destination = contained(target.root, `${targetSkillsFolder(target)}/${data.name}`);
    noLinks(path.dirname(destination));
    const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (!stat) return { destination };
    if (stat.isSymbolicLink()) {
      invariant(!fs.existsSync(destination), 'TARGET_CHANGED', 'This link now points to an existing folder. Refresh before removing it.');
      this.removeLink(destination);
    } else {
      invariant(stat.isDirectory() && fs.readdirSync(destination).length === 0, 'TARGET_CHANGED', 'This folder contains files. Nothing was removed.');
      fs.rmdirSync(destination);
    }
    this.wb.record('uninstalled', `Removed an empty folder or broken link: ${destination}`);
    return { destination };
  }
  /** Copies an unclaimed skill folder into the library as a captured item. The folder itself is left in place. */
  importExternal(input: unknown) {
    const data = z.object({ targetId: idSchema, name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).parse(input);
    const target = this.target(data.targetId);
    const destination = this.skillDestination(target, data.name);
    const real = fs.realpathSync(destination);
    invariant(fs.existsSync(path.join(real, 'SKILL.md')), 'INVALID_FILE', 'This folder has no SKILL.md.');
    const item = this.wb.importResource(path.dirname(real), `${path.basename(real)}/SKILL.md`);
    this.wb.record('imported', `Imported “${data.name}” from ${target.name}`, item.id, item.revision);
    return item;
  }
  /** Brings this machine in line with the desired installs recorded in the library. Missing personal environments are reported, not created. */
  syncInstalls() {
    const installs = this.wb.installs(); const report: { itemId: string; provider: ProviderId | 'codex-native'; result: string }[] = [];
    for (const [itemId, providers] of Object.entries(installs)) for (const provider of providers) {
      const target = this.personalTarget(provider);
      if (!target) { report.push({ itemId, provider, result: 'skipped: skill location not set up on this machine' }); continue; }
      try {
        const item = this.wb.getItem(itemId); if (item.deletedAt) { report.push({ itemId, provider, result: 'skipped: item is in the trash' }); continue; }
        const approval = this.wb.approvals().filter(a => a.itemId === itemId && a.trust === 'local').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        invariant(approval, 'APPROVAL_REQUIRED', 'No approved revision is available. Review and approve this item before syncing.');
        const revision = this.wb.getRevision(itemId, approval.revision);
        const rendered = this.render(itemId, revision.hash, target);
        const current = readDestination(rendered.destination);
        if (current && stateHash(current) === rendered.proposedHash) {
          if (!this.latest(rendered.destination)) this.adopt(target, item, revision, rendered.destination);
          report.push({ itemId, provider, result: 'already installed' }); continue;
        }
        const plan = this.plan({ itemId, revision: revision.hash, targetId: target.id });
        this.apply({ planId: plan.id, expectState: plan.expectedState, confirm: true });
        report.push({ itemId, provider, result: 'installed approved revision' });
      } catch (error) { report.push({ itemId, provider, result: `failed: ${error instanceof Error ? error.message : String(error)}` }); }
    }
    return report;
  }
  drift() {
    const destinations = [...new Set(this.receipts().map(r => r.destination))];
    return destinations.flatMap(destination => {
      const receipt = this.latest(destination); if (!receipt) return [];
      try { return [{ ...receipt, actualHash: stateHash(readDestination(destination)), drifted: stateHash(readDestination(destination)) !== receipt.hash, checkedAt: now() }]; }
      catch (error) { return [{ ...receipt, actualHash: null, drifted: true, checkedAt: now(), error: error instanceof Error ? error.message : String(error) }]; }
    });
  }
  recover() {
    return withLock(this.wb.canonical, () => readRecords(path.join(this.wb.local, 'journals'), v => v as Journal).filter(j => j.phase !== 'complete').map(journal => {
      const target = this.target(journal.receipt.targetId);
      invariant(path.resolve(journal.destination).startsWith(path.resolve(target.root) + path.sep), 'INVALID_PATH', 'Recovery path escapes target.');
      const current = stateHash(readDestination(journal.destination));
      if (current === journal.proposed) {
        journal.receipt.status = journal.proposed === null ? (journal.receipt.planId.startsWith('uninstall-') ? 'uninstalled' : 'rolled_back') : 'applied';
        writeJson(path.join(this.wb.local, 'receipts', `${journal.receipt.id}.json`), journal.receipt);
        journal.phase = 'complete'; writeJson(path.join(this.wb.local, 'journals', `${journal.id}.json`), journal);
        this.removeOwnedSibling(journal.backup, target.root, journal.expected);
        return { id: journal.id, status: 'completed' };
      }
      if (current === null && fs.existsSync(journal.backup) && stateHash(readDestination(journal.backup)) === journal.expected) fs.renameSync(journal.backup, journal.destination);
      if (stateHash(readDestination(journal.destination)) === journal.expected) {
        this.removeOwnedSibling(journal.stage, target.root, journal.proposed);
        journal.phase = 'complete'; journal.receipt.status = 'rolled_back';
        writeJson(path.join(this.wb.local, 'receipts', `${journal.receipt.id}.json`), journal.receipt);
        writeJson(path.join(this.wb.local, 'journals', `${journal.id}.json`), journal);
        return { id: journal.id, status: 'restored previous state' };
      }
      return { id: journal.id, status: 'partial: files changed; manual inspection required' };
    }));
  }
}
