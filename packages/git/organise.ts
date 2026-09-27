import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Workbench } from '../domain/workbench';
import { itemSchema } from '../protocol/schema';
import { localPaths } from './sync';

/**
 * What an organisation commit (autoSync experiment) may carry: moves, order and favourites of items whose approved revision is
 * already on GitHub, the collection list, and desired installs of published items. Everything else stays local: an item.json
 * is only taken when nothing but these fields differs from the committed one, so draft content can never ride along.
 */
const organisational = new Set(['collection', 'order', 'favourite']);
function git(root: string, args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 20_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function committed(root: string, file: string): Record<string, unknown> | null {
  try { const value = JSON.parse(git(root, ['show', `HEAD:${file}`])); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Keys outside `allowed` are identical on both sides (`ignored` may differ too), and at least one key inside `allowed` differs. */
function onlyChanged(working: Record<string, unknown>, head: Record<string, unknown>, allowed: (key: string) => boolean, ignored: (key: string) => boolean = () => false) {
  const keys = new Set([...Object.keys(working), ...Object.keys(head)]);
  return [...keys].every(key => allowed(key) || ignored(key) || same(working[key], head[key])) && [...keys].some(key => allowed(key) && !same(working[key], head[key]));
}
/** An absent conflict list and an empty one mean the same; the published copy always writes it. */
const withHeads = (value: Record<string, unknown>) => ({ ...value, conflictHeads: value.conflictHeads ?? [] });
const serialise = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
export type OrganisationPlan = { files: Record<string, string>; items: { id: string; title: string }[]; collections: boolean; installs: boolean; message: string };

/** `installIds`: items whose desired installs changed on this machine since they were last published. */
export function organisationPlan(wb: Workbench, installIds: Iterable<string> = []): OrganisationPlan {
  const relative = path.relative(wb.root, wb.canonical).split(path.sep).join('/');
  const files: Record<string, string> = {}, items: OrganisationPlan['items'] = [];
  const changed = new Set(localPaths(wb.root));
  const trusted = new Set(wb.approvals().filter(a => a.trust === 'local').map(a => `${a.itemId}:${a.revision}`));
  for (const file of changed) {
    const id = file.match(new RegExp(`^${relative}/items/([a-f0-9-]{36})/item\\.json$`))?.[1];
    if (!id) continue;
    const head = committed(wb.root, file); if (!head) continue;
    let text: string; try { text = fs.readFileSync(path.join(wb.root, file), 'utf8'); } catch { continue; }
    const parsed = itemSchema.safeParse(JSON.parse(text)), before = itemSchema.safeParse(head);
    if (!parsed.success || !before.success) continue;
    const item = parsed.data;
    // The approved revision GitHub already has, still approved here and not in the trash: only then is the change organisation.
    if (item.revision !== before.data.revision || item.status !== 'approved' || before.data.status !== 'approved' || item.deletedAt || before.data.deletedAt || !trusted.has(`${id}:${item.revision}`)) continue;
    // updatedAt may differ but is not a reason to commit on its own; approving rewrites it.
    if (!onlyChanged(withHeads(JSON.parse(text)), withHeads(head), key => organisational.has(key), key => key === 'updatedAt')) continue;
    files[file] = Buffer.from(text).toString('base64'); items.push({ id, title: item.title });
  }
  const config = `${relative}/workbench.json`;
  let collections = false;
  if (changed.has(config)) {
    const head = committed(wb.root, config);
    try {
      const text = fs.readFileSync(path.join(wb.root, config), 'utf8'), working = JSON.parse(text);
      if (head && onlyChanged(working, head, key => key === 'collections')) { files[config] = Buffer.from(text).toString('base64'); collections = true; }
    } catch { /* Unreadable: leave it for the user. */ }
  }
  const manifest = `${relative}/installs.json`;
  let installs = false;
  const wanted = [...new Set(installIds)];
  if (wanted.length) {
    // Only items whose install intent changed here: approval commits never write installs.json into this folder, so an entry
    // missing from it may simply never have been known here, not removed. Items still waiting for their approval commit get
    // their intent with that commit.
    const published = new Set(git(wb.root, ['ls-tree', '--name-only', 'HEAD', `${relative}/items/`]).split('\n').map(l => l.split('/')[2]).filter(Boolean));
    const head = committed(wb.root, manifest) ?? {}, working = wb.installs() as Record<string, unknown>, next: Record<string, unknown> = { ...head };
    for (const id of wanted) {
      if (!published.has(id)) continue;
      if (working[id]) next[id] = working[id]; else delete next[id];
    }
    if (!same(next, head)) {
      let text = serialise(next); try { const raw = fs.readFileSync(path.join(wb.root, manifest), 'utf8'); if (same(JSON.parse(raw), next)) text = raw; } catch { /* Written fresh below. */ }
      files[manifest] = Buffer.from(text).toString('base64'); installs = true;
    }
  }
  const parts = [items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '', collections ? 'collections' : '', installs ? 'desired installs' : ''].filter(Boolean);
  const subject = items.length === 1 && !collections && !installs ? `Organise "${items[0].title.replace(/\s+/g, ' ').trim().slice(0, 50)}"` : `Organise library: ${parts.join(', ')}`;
  const body = items.length > 1 ? items.slice(0, 10).map(i => `- ${i.title.replace(/\s+/g, ' ').trim().slice(0, 80)}`).join('\n') + (items.length > 10 ? `\n- and ${items.length - 10} more` : '') : '';
  return { files, items, collections, installs, message: body ? `${subject}\n\n${body}` : subject };
}
