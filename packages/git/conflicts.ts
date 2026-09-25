import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { idSchema, itemSchema, revisionSchema, type Item } from '../protocol/schema';
import { invariant } from '../domain/errors';
import type { Workbench } from '../domain/workbench';
import { revisionHash } from '../domain/content';
import { atomicWrite, noLinks, safeRelative, withLock, writeJson } from '../storage/files';
import { writeWorkingFiles } from '../storage/bundles';

function git(root: string, args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 5_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function unresolved(root: string) { return git(root, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean); }
function stageItem(wb: Workbench, id: string, stage: number): Item | null {
  try { return itemSchema.parse(JSON.parse(git(wb.root, ['show', `:${stage}:workbench/items/${id}/item.json`]))); } catch { return null; }
}
function stageText(wb: Workbench, id: string, stage: number) {
  try { return git(wb.root, ['show', `:${stage}:workbench/items/${id}/content.md`]); } catch { return '(not available at this stage)'; }
}
export function conflicts(wb: Workbench) {
  const paths = unresolved(wb.root);
  const ids = [...new Set(paths.map(p => p.match(/^workbench\/items\/([a-f0-9-]+)\//)?.[1]).filter((id): id is string => Boolean(id)))];
  return { paths, items: ids.map(id => ({ id, base: stageItem(wb, id, 1), ours: stageItem(wb, id, 2), theirs: stageItem(wb, id, 3), baseText: stageText(wb, id, 1), oursText: stageText(wb, id, 2), theirsText: stageText(wb, id, 3), paths: paths.filter(p => p.startsWith(`workbench/items/${id}/`)) })), otherPaths: paths.filter(p => !/^workbench\/items\/[a-f0-9-]+\//.test(p)) };
}
export function mergeFetched(wb: Workbench, ref = '@{upstream}') {
  invariant(ref === '@{upstream}' || /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(ref), 'INVALID_REF', 'Choose a valid Git ref.');
  return withLock(wb.canonical, () => {
    invariant(!git(wb.root, ['status', '--porcelain']).trim(), 'GIT_DIRTY', 'Checkpoint or resolve local changes before merging.');
    let drivers = ''; try { drivers = git(wb.root, ['config', '--get-regexp', '^merge\..*\.driver$']); } catch { /* No custom merge drivers configured. */ }
    invariant(!drivers.trim(), 'CUSTOM_MERGE_DRIVER', 'This repository configures executable merge drivers. Merge it in your normal Git tool, then review the result in Kiln.');
    git(wb.root, ['rev-parse', '--verify', ref]);
    try { git(wb.root, ['merge', '--no-commit', '--no-ff', '--no-edit', ref]); }
    catch (error) { if (!unresolved(wb.root).length) throw error; }
    return conflicts(wb);
  });
}
export function resolveItemConflict(wb: Workbench, input: unknown) {
  const data = z.object({ id: idSchema, choice: z.enum(['ours', 'theirs', 'both']) }).parse(input);
  return withLock(wb.canonical, () => {
    const conflict = conflicts(wb).items.find(i => i.id === data.id); invariant(conflict, 'CONFLICT_NOT_FOUND', 'This conflict no longer exists.');
    const selected = data.choice === 'theirs' ? conflict.theirs : conflict.ours;
    invariant(selected && conflict.ours && conflict.theirs, 'MANUAL_RESOLUTION_REQUIRED', 'Deletion or invalid metadata needs resolution in your normal Git editor. All sides remain in the Git index.');
    // Recover both immutable snapshots even when their files have a textual conflict.
    for (const [stage, item] of [[2, conflict.ours], [3, conflict.theirs]] as const) {
      const relative = `workbench/items/${item.id}/revisions/${item.revision}.json`;
      let text: string;
      try { text = git(wb.root, ['show', `:${stage}:${relative}`]); }
      catch { text = fs.readFileSync(path.join(wb.root, relative), 'utf8'); }
      const revision = revisionSchema.parse(JSON.parse(text));
      invariant(revision.itemId === item.id && revisionHash(revision) === item.revision, 'BUNDLE_TAMPERED', 'A conflicting revision has an invalid hash.');
      writeJson(path.join(wb.root, relative), revision);
    }
    const revisionFile = path.join(wb.itemDir(data.id), 'revisions', `${selected.revision}.json`);
    noLinks(revisionFile); const revision = revisionSchema.parse(JSON.parse(fs.readFileSync(revisionFile, 'utf8')));
    const item = { ...selected, status: 'captured', conflictHeads: data.choice === 'both' ? [...new Set([conflict.ours.revision, conflict.theirs.revision])] : [] };
    writeJson(path.join(wb.itemDir(data.id), 'item.json'), item);
    atomicWrite(path.join(wb.itemDir(data.id), 'content.md'), revision.content);
    writeWorkingFiles(path.join(wb.itemDir(data.id), 'files'), revision.files);
    for (const file of conflict.paths) { safeRelative(file); noLinks(path.join(wb.root, file)); }
    git(wb.root, ['add', '--', `workbench/items/${data.id}`]);
    wb.record('conflict_resolved', data.choice === 'both' ? 'Kept both diverging revisions; local revision remains selected' : `Selected ${data.choice} after comparing diverging revisions`, data.id, selected.revision);
    return conflicts(wb);
  });
}
export function finishMerge(wb: Workbench) {
  return withLock(wb.canonical, () => {
    invariant(!unresolved(wb.root).length, 'GIT_CONFLICT', 'Resolve all conflict paths before finishing the merge.');
    git(wb.root, ['rev-parse', '--verify', 'MERGE_HEAD']);
    git(wb.root, ['add', '--', 'workbench/activity']);
    return git(wb.root, ['commit', '-m', 'Merge library changes; preserve revision history']).trim();
  });
}
