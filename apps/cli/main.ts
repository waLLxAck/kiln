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

collections list            # names, item counts (count: directly inside, total: with subfolders), empty ones included; unfiled count
items list [--collection "Name" [--recursive] | --unfiled] [--query text] [--status captured] [--kind source] [--from <id>] [--limit 50] [--offset 0] [--full]
                            # case-sensitive collection; --recursive adds its subfolders; --from: items made from <id>; IDs, titles and kinds; --full adds metadata
items read <id> [id...] [--full] [--revision hash]
                            # 1–100 IDs in one call; --full includes content/files; --revision: one ID only; a source lists madeFrom

Sources are material an agent analysed (a pasted chat, a page, a video). Entries made from one point back to it:
  kiln items list --kind source
  kiln items list --from <source id>

Examples:
  kiln items list --collection "Game Design Practice"
  kiln items list --collection "Game Design Practice" --query puzzles
  kiln items read <id1> <id2> --full

Collections are folders; "/" makes a subfolder ("Game Design/Puzzles"). Organising never creates a revision: approvals and installs stay.
collections create --name "Game Design/Puzzles"
collections rename --from "Name" --to "New name"   # subfolders and items move with it; --to "Parent/Name" nests it
collections delete --name "Name" --keep-items      # items and subfolders move up one level (top level: unfiled)
collections delete --name "Name" --trash-items     # items, subfolders' too, move to the trash
items move <id> [id...] --collection "Name" | --unfiled   # 1–500 IDs; --unfiled leaves them in the library, outside every collection

items create --file draft.md --title "Title" [--kind prompt] [--from <id>] [--input meta.json]
                            # --from links the new item to the current revision of <id>; meta.json may set description, tags, collection, source
items update <id> --file draft.md --expect <hash> [--summary "what changed"] [--input meta.json]
items restore <id> --revision <hash> --expect <hash>
items duplicates            # groups of likely copies: same kind, same text, or same name with mostly the same text
items consolidate --input request.json   # { keep, expect, merge: [{ id, expect }], content?, tags?, collection? }; the others go to the trash as merged
items unconsolidate --input undo.json    # the undo object items consolidate returned, while nothing changed since
items distinct --input request.json      # { ids: [id, id], distinct?: false }: not duplicates (false: flag them again)
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
skills sync                 # install every skill listed in workbench/installs.json, and everything marked for this machine, into its skill locations
skills invocation <id> --model on|off [--expect <hash>]
                            # whether the model may invoke the skill on its own: edits SKILL.md (disable-model-invocation) and agents/openai.yaml
                            # (Codex). An approved skill keeps its approval (only the flag changed) and Kiln's installed copies are updated
context start [--project <folder>]
                            # estimate what Claude Code, Codex and Copilot CLI load at session start on this machine: skill descriptions,
                            # instruction files, SessionStart hooks (listed, never run) and MCP servers
mcp scan                    # MCP servers in Claude Code, Codex, Copilot CLI, VS Code and Cursor configs (personal and project) that the library
                            # lacks: each distinct definition once, with every place it was found; literal secrets become \${NAME} references
mcp import --all | <key> [key...] [--collection "MCP servers"]   # import scanned servers as draft mcp items; configs are untouched
mcp status <id>             # each client location: absent, installed (by Kiln), drifted (edited since), external (not Kiln's), outdated
mcp install <id> --client claude|codex|copilot|vscode|cursor [--project <folder>] [--replace]
                            # writes only this server's entry into that client's config (approving the revision first if needed);
                            # --replace writes over a different entry of the same name (kept in the receipt and in Config files versions)
mcp remove <id> --client <client> [--project <folder>] [--name <old name>] [--force]   # removes only that entry
mcp rollback --receipt <id> # puts back what the latest install replaced, if the entry is unchanged since
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
machines status             # this machine: id, name, locations and copies as it would report them
machines list               # fetch, then every machine that reported to this library
machines report             # share this machine's installs now (commit and push its workbench/machines/<id>.json)
machines mark <machine id> --item <id> --location agents|claude|codex|copilot|project:<folder> [--unmark]
                            # ask a machine to install an approved item there on its next skills sync
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
    const collection = option('collection'), inCollection = (name: string) => option('unfiled') ? !name : !collection || name === collection || (Boolean(option('recursive')) && name.startsWith(collection + '/'));
    const items = wb.search(option('query'), true).filter(item => inCollection(item.collection) && (!option('status') || item.status === option('status')) && (!option('kind') || item.kind === option('kind')) && (!option('from') || item.origin?.itemId === option('from')));
    const limit = Number(option('limit', '50')), offset = Number(option('offset', '0'));
    const page = items.slice(offset, offset + limit);
    result = { items: option('full') ? page : page.map(({ id, title, kind }) => ({ id, title, kind })), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
  } else if (resource === 'collections' && action === 'list') {
    const items = wb.listItems();
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.collection, (counts.get(item.collection) ?? 0) + 1);
    const names = wb.collections(items), total = (name: string) => names.filter(n => n === name || n.startsWith(name + '/')).reduce((sum, n) => sum + (counts.get(n) ?? 0), 0);
    result = { collections: names.map(name => ({ name, count: counts.get(name) ?? 0, total: total(name) })), unfiled: counts.get('') ?? 0 };
  } else if (resource === 'collections' && action === 'create') result = wb.createCollection({ name: option('name') });
  else if (resource === 'collections' && action === 'rename') result = wb.renameCollection({ from: option('from'), to: option('to') });
  else if (resource === 'collections' && action === 'delete') result = wb.deleteCollection({ name: option('name'), confirm: true, items: option('keep-items') ? 'keep' : 'trash' });
  else if (resource === 'items' && action === 'move') result = wb.moveItems({ ids, collection: option('unfiled') ? '' : option('collection') });
  else if (resource === 'items' && action === 'read') {
    const items = ids.map(itemId => {
      const revision = wb!.getRevision(itemId, option('revision') || undefined);
      const item = wb!.getItem(itemId), madeFrom = item.kind === 'source' ? { madeFrom: wb!.madeFrom(itemId).map(({ id, title, kind }) => ({ id, title, kind })) } : {};
      // The item says where it is filed now; the revision's collection is where it was when that revision was saved.
      return option('full') ? { ...revision, item, ...madeFrom } : { item, revision: revision.hash, contentBytes: Buffer.byteLength(revision.content), files: Object.keys(revision.files), ...madeFrom };
    });
    result = ids.length === 1 ? items[0] : { items };
  } else if (resource === 'items' && action === 'create') {
    const value = { ...input, title: option('title', input.title), kind: option('kind', input.kind ?? 'prompt'), content: fs.readFileSync(option('file'), 'utf8') };
    // --from records where the new item came from (an agent chat adding an entry for a video, for example) instead of creating an unlinked item.
    result = option('from') ? wb.createFrom({ id: option('from'), revision: wb.getItem(option('from')).revision, item: value, author: option('author', 'CLI') }) : wb.create(value, option('key') || undefined);
  } else if (resource === 'items' && action === 'update') {
    const current = wb.authoring(id);
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
  } else if (resource === 'machines' && action === 'status') result = { machine: router.fleet.identity(), report: router.fleet.live(), targets: wb.targets(), deployments: router.deployments.drift(), coverage: 'External sessions unknown' };
  else if (resource === 'machines' && action === 'list') result = await router.fleet.view({ fetch: true });
  else if (resource === 'machines' && ['report', 'mark'].includes(action)) {
    if (action === 'mark') router.fleet.mark({ machineId: id, itemId: option('item'), location: option('location'), wanted: !option('unmark') });
    else router.fleet.report();
    // Wait for the commit and push so the process exits with the report on GitHub (or a reason it isn't).
    await router.fleet.idle(); result = router.fleet.publishState();
  }
  else if (resource === 'skills' && action === 'invocation') {
    result = router.call('skills.invocation', { itemId: id, model: option('model') === 'on', ...(option('expect') ? { expect: option('expect') } : {}) });
    // A carried approval is committed and pushed like any approval; wait so the process exits with it done.
    await router.publisher.idle();
  }
  else if (resource === 'mcp' && action === 'import') result = router.call('mcp.import', { keys: ids, all: Boolean(option('all')), ...(option('collection') ? { collection: option('collection') } : {}) });
  else if (resource === 'mcp' && action === 'status') result = router.call('mcp.status', { itemId: id });
  else if (resource === 'mcp' && ['install', 'remove'].includes(action)) {
    result = router.call(`mcp.${action}`, { itemId: id, client: option('client'), ...(option('project') ? { project: path.resolve(option('project')) } : {}), ...(option('name') ? { name: option('name') } : {}), ...(action === 'install' ? { replace: Boolean(option('replace')) } : { force: Boolean(option('force')) }), confirm: true });
    // Installing a draft approves it; wait so the process exits with that approval pushed.
    await router.publisher.idle();
  }
  else if (resource === 'mcp' && action === 'rollback') result = router.call('mcp.rollback', { receiptId: option('receipt'), confirm: true });
  else if (resource === 'context' && action === 'start') result = router.call('context.sessionStart', option('project') ? { project: path.resolve(option('project')) } : {});
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
