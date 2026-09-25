import fs from 'node:fs';
import path from 'node:path';
import { Workbench } from '../../packages/domain/workbench';
import { Router } from '../../packages/domain/router';
import { WorkbenchError } from '../../packages/domain/errors';
import { defaultLibrary, privateRoot } from '../../packages/storage/config';
import { parseArguments } from './arguments';

const args = process.argv.slice(2);
const help = `Kiln workbench · schema version 1

kiln <resource> <action> [ids...] [options]  (also: workbench)

collections list            # names and item counts, including empty collections
items list [--collection "Name"] [--query text] [--status captured] [--limit 50] [--offset 0] [--full]
                            # case-sensitive collection; IDs, titles and kinds; --full adds metadata
items read <id> [id...] [--full] [--revision hash]
                            # 1–100 IDs in one call; --full includes content/files; --revision: one ID only

Examples:
  kiln items list --collection "Game Design Practice"
  kiln items list --collection "Game Design Practice" --query puzzles
  kiln items read <id1> <id2> --full

items create --file draft.md --title "Title" [--kind prompt] [--from <id>] [--input meta.json]
                            # --from links the new item to the current revision of <id>; meta.json may set description, tags, collection, source
items update <id> --file draft.md --expect <hash> [--summary "what changed"] [--input meta.json]
items restore <id> --revision <hash> --expect <hash>
trials create --input request.json
trials finish --input judgement.json
skills draft --input draft.json
approvals request <id> --revision <hash>
approvals approve --input approval.json --human-reviewed
targets enroll --input target.json
deploy plan --input selection.json
deploy apply --input confirmed-plan.json
deploy rollback --input rollback.json
deploy drift | recover
skills install --input request.json
skills remove --input request.json
skills sync                 # install every skill listed in workbench/installs.json into this machine's skill locations
skills scan --input request.json
targets remove --input request.json
items purge --input request.json
home list                   # ~/.claude/CLAUDE.md, ~/AGENTS.md, ~/.codex/AGENTS.md, PowerShell profiles, files you added
home read <key>             # text with LF line endings, plus the hash to pass as --expect
home save <key> --file text.md --expect <hash|null>   # writes in place; the previous bytes are kept
home backups <key> | home backup <key> --name <file>
home restore <key> --name <file> --expect <hash>
home add --path <file> | home remove <key>
git inventory --input folder.json
git checkpoint --input message.json
git sync --input action.json
machines status
providers detect
observations list
library export --file backup.json
library import --file backup.json

JSON results go to stdout. Diagnostics go to stderr.
Lists include archived items, exclude trash. Use nextOffset for the next page (limit: 1–500).
Single read returns one object; batch read returns { items: [...] } in requested order.
Use --library <folder> and --local <folder> to override storage. Unknown/unsupported flags fail.
Manual trials need no API key.
Deployment requires an enrolled root, exact approval and confirm:true.
`;
if (args.includes('--help') || args.length === 0) { process.stdout.write(help); process.exit(0); }
async function main() {
let wb: Workbench | undefined;
try {
  const { resource, action, ids, option } = parseArguments(args);
  const [id] = ids;
  const root = path.resolve(option('library', defaultLibrary()));
  wb = new Workbench(root, option('local', privateRoot()));
  // Commit messages come from a plain template here; the desktop app asks Codex.
  const router = new Router(wb, { composer: null });
  const input = option('input') ? JSON.parse(fs.readFileSync(option('input'), 'utf8')) : {};
  let result: unknown;
  if (resource === 'items' && action === 'list') {
    const items = wb.search(option('query'), true).filter(item => (!option('collection') || item.collection === option('collection')) && (!option('status') || item.status === option('status')));
    const limit = Number(option('limit', '50')), offset = Number(option('offset', '0'));
    const page = items.slice(offset, offset + limit);
    result = { items: option('full') ? page : page.map(({ id, title, kind }) => ({ id, title, kind })), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
  } else if (resource === 'collections' && action === 'list') {
    const items = wb.listItems();
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.collection, (counts.get(item.collection) ?? 0) + 1);
    result = { collections: wb.collections(items).map(name => ({ name, count: counts.get(name) ?? 0 })) };
  } else if (resource === 'items' && action === 'read') {
    const items = ids.map(itemId => {
      const revision = wb!.getRevision(itemId, option('revision') || undefined);
      return option('full') ? revision : { item: wb!.getItem(itemId), revision: revision.hash, contentBytes: Buffer.byteLength(revision.content), files: Object.keys(revision.files) };
    });
    result = ids.length === 1 ? items[0] : { items };
  } else if (resource === 'items' && action === 'create') {
    const value = { ...input, title: option('title', input.title), kind: option('kind', input.kind ?? 'prompt'), content: fs.readFileSync(option('file'), 'utf8') };
    // --from records where the new item came from (an agent chat adding an entry for a video, for example) instead of creating an unlinked item.
    result = option('from') ? wb.createFrom({ id: option('from'), revision: wb.getItem(option('from')).revision, item: value, author: option('author', 'CLI') }) : wb.create(value, option('key') || undefined);
  } else if (resource === 'items' && action === 'update') {
    const current = wb.getRevision(id);
    result = wb.update({ id, expect: option('expect'), summary: option('summary', 'CLI edit'), value: { ...current, ...input, content: fs.readFileSync(option('file'), 'utf8') } }, option('key') || undefined);
  } else if (resource === 'items' && action === 'restore') result = wb.restore({ id, expect: option('expect'), revision: option('revision') });
  else if (resource === 'approvals' && action === 'request') result = { item: wb.getItem(id), revision: wb.getRevision(id, option('revision')).hash, validation: wb.detail(id).validation, action: 'Human review required. Supply reviewer, scope, evidence or note, and explicit waived checks if needed.' };
  else if (resource === 'approvals' && action === 'approve') {
    if (!args.includes('--human-reviewed')) throw new WorkbenchError('HUMAN_REVIEW_REQUIRED', 'Only run approval after a human has reviewed the exact revision. Pass --human-reviewed to attest.');
    // Same path as the desktop: record the approval, then commit and push it. The CLI waits so the process exits with the push done.
    result = router.approve(input);
    await router.publisher.idle();
    const job = router.publisher.list()[0];
    if (job?.status === 'failed') process.stderr.write(JSON.stringify({ schemaVersion: 1, warning: `Approval recorded locally but not pushed: ${job.error}` }) + '\n');
    else if (job) result = { approval: result, commit: job.commit, message: job.message };
  } else if (resource === 'machines' && action === 'status') result = { machine: 'local', targets: wb.targets(), deployments: router.deployments.drift(), remote: 'Not enabled in this local release', coverage: 'External sessions unknown' };
  else if (resource === 'library' && action === 'export') result = wb.exportLibrary(path.resolve(option('file')));
  else if (resource === 'library' && action === 'import') result = wb.importLibrary(path.resolve(option('file')));
  else if (resource === 'home' && ['read', 'backups'].includes(action)) result = await router.call(`home.${action}`, { key: id });
  else if (resource === 'home' && action === 'save') result = await router.home.save({ key: id, expect: option('expect', 'null') === 'null' ? null : option('expect'), content: fs.readFileSync(option('file'), 'utf8') });
  else if (resource === 'home' && ['backup', 'restore'].includes(action)) result = await router.call(`home.${action}`, { key: id, name: option('name'), ...(action === 'restore' ? { expect: option('expect', 'null') === 'null' ? null : option('expect') } : {}) });
  else if (resource === 'home' && action === 'add') result = router.home.add({ path: path.resolve(option('path')) });
  else if (resource === 'home' && action === 'remove') result = await router.home.remove({ key: id });
  else result = await router.call(`${resource}.${action}`, input);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, data: result }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: error instanceof WorkbenchError ? error.code : 'INVALID_INPUT', message: error instanceof Error ? error.message : String(error) } }) + '\n');
  process.exitCode = 1;
} finally { wb?.close(); }
}
void main();
