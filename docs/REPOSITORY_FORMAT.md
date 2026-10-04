# Standard Kiln repository, version 1

The repository is portable authored content. Machine paths, installation ownership, authentication, search caches, private trial inputs, and raw output transcripts live outside it.

```text
kiln.json
KILN.md
.kiln/
  infrastructure.json
  validate.mjs
  migration.json          # present after migration
.github/workflows/kiln.yml
workbench/
  workbench.json
  .gitignore
  items/<uuid>/
    item.json
    content.md
    files/<relative-path>
    revisions/<sha256>.json
  approvals/<uuid>.json
  experiments/<uuid>.json
  activity/<uuid>.json
  analyses/<uuid>.json    # what each analysis of a source produced
  scores/<uuid>.json      # each writing-for-agents score of an exact revision
```

`kiln.json` declares `format: kiln-library`, `schemaVersion: 1`, a stable `repositoryId`, `library: workbench`, and `infrastructureVersion`. Kiln rejects unsupported schema versions and does not downgrade newer infrastructure.

Item kind `mcp` holds one MCP server definition as JSON (`name`, `transport`, `command`/`args`/`env` or `url`/`headers`, `description`); values refer to environment variables as `${NAME}` and never hold secrets. Item kind `source` marks material an agent analysed (a pasted chat, a page, files, a video). Items made from it name it in `origin`. `analyses/<job id>.json` records each completed analysis: provider, model, effort, token usage, times, summary, takeaway, skipped notes, counts by kind, the created item IDs and the collection. It never holds run steps, commands, paths or the CLI session, which stay machine-private. Records are written once, exported with the library and removed when their source is purged.

`scores/<job id>.json` records one Score run: the item and the exact revision it scored, provider, model, effort, token usage, times, the score (an integer from 0 to 100), the summary and the improvements (title, why, severity `high`, `medium` or `low`, an optional 1-based line in that revision's content, and a suggestion). A score of any other revision than the item's current one is stale. Like analyses, scores hold no run steps or paths, are written once, exported with the library and removed when their item is purged.

Item status is one of `captured`, `testing`, `approved`, `rejected`, or `archived`. Libraries written before v0.2 stored `inbox` for newly captured items; Kiln reads that as `captured` and rewrites the file on its next save.

The stable item ID survives edits, renaming, Git sync, and export/import. An immutable revision stores content, supporting file bytes as base64, title, description, kind, tags, collection, source, licence and agent metadata when applicable. New revisions carry `hashVersion: 2`; legacy revisions without it keep their original identity and remain readable. Its SHA-256 is calculated over a stable serialization of those fields. Approval refers to that exact hash. The collection an item is filed in lives in `item.json`. Moving an item rewrites that file; renaming or deleting a collection rewrites the affected item files and `workbench.json`. Revisions and approvals are never touched, so approvals survive organising. A revision's own `collection` records where the item was when that revision was saved, and an empty collection means the item is unfiled. `/` separates subfolders (`Game Design/Puzzles`); parents are implied, and `workbench.json` keeps the sidebar order and empty collections. Editing working files creates a new draft after reconciliation; historical approved snapshots stay intact.

The infrastructure manifest records hashes of app-owned files. Update previews compare both current and proposed bytes; unmanaged or locally modified files block replacement. Future releases can ship new templates and infrastructure versions without accepting alternate library structures.

## Legacy migration

Migration enumerates tracked `SKILL.md` files, preserving each source path as provenance. It imports the skill directory's regular files and records the nearest upstream licence as item metadata rather than as a bundled file. Malformed skills are preserved as captured items and flagged for review rather than silently repaired or omitted. Bundles over 25 MB or unsafe paths block import with an explicit error.

`.kiln/migration.json` maps each legacy source path to its stable item and source hash. A path inside the library is stored as it is; a folder outside it is named `folder-<hash>::<relative path>`, where the hash is of the folder's absolute path, so the shared file never holds the path itself. Keys written by Kiln 0.25 and earlier (`<absolute folder>::<relative path>`) are rewritten that way when the library opens and are still recognised. Repeating the import is idempotent. An upstream change creates a new draft if there are no intervening local adaptations; otherwise it reports a conflict. Legacy directories remain as historical sources and support existing junctions. The canonical authoring location is `workbench/`.

## Machine state

The default machine-private root is `~/.kiln`. `library.json` selects the active repository; a path-derived subdirectory stores target enrollments, receipts, journals, private trials, reference mappings, observations, and the rebuildable SQLite index. These files are not transportable approval or ownership evidence. Re-enroll destinations on each machine.

An approval with `reviewer: "Kiln"` and `carriedFrom: <hash>` was recorded by Kiln for a revision that differs from the approved `carriedFrom` revision only in its model-invocation flags (`disable-model-invocation` in SKILL.md, `policy.allow_implicit_invocation` in `agents/openai.yaml`; see [Skill invocation](SKILL_INVOCATION.md)). It copies that approval's scope, evidence and waived checks. Older Kiln versions ignore the extra field.

Kiln records the same kind of approval when it makes a revision's provenance portable (see [Portable provenance](#portable-provenance)): the new revision differs from the approved `carriedFrom` revision only in `source` (and in a description of the form `Copy of <path>`), with identical content, files, title, kind, tags, licence and agent metadata. Its note says so. Its `id` and `createdAt` derive from the approval it carries (`createdAt` is one millisecond later), so every machine that does the same cleanup writes the same file.

Imported export approvals remain historical evidence with `trust: imported`; they cannot authorize installation automatically. Git repositories are user-selected trusted authoring stores, not a cryptographically signed approval system. Review incoming changes before deployment. A GitHub clone does not install anything.

Approval publishing materializes the exact reviewed revision through a private Git index, with its approval and redacted evidence. It never stages the item's working directory or its unapproved history. Later local edits remain untouched. Explicit CLI checkpoints remain an operation that commits all managed working files.

## Portable provenance

Shared files never hold machine-local paths. A `source` that is one (`local:` or `home:` labels, POSIX paths such as `/home/…`, `~`, Windows drive paths with either slash, UNC paths and `file:` URLs) is stored as `local-import:<last path segment>`, for example `local-import:research`. Detection and the label are plain string operations, so Linux, macOS and Windows compute the same label from the same text whichever system wrote it. Every revision save applies this, so imports from folders, repository folders, legacy migration, desktop capture and `items create --input` store the portable form from the start. The original source is kept in machine-private `private-sources/` on the machine that imported it. Activity messages name only a folder's last segment.

Opening a library, pulling from GitHub and importing an export clean what an older Kiln wrote:

- A current revision whose only machine-private part is its source is replaced by its portable form. Every field of the new revision derives from the original (`createdAt`, `author`; `parent` is empty, `summary` is "Moved machine provenance out of shared content"), so two machines doing this independently write byte-identical files and Git merges them cleanly. The item keeps its `updatedAt`.
- If a person approved the original on this machine (a live approval with `trust: local`), the approval is carried over to the portable revision as described above, so the item stays approved and installed copies stay current. The same happens for an item an earlier Kiln already cleaned into an unapproved draft, as long as the original revision is still readable here and the draft is exactly its portable form. Nothing is carried over when the content or files differ in any way, when the portable revision already has an approval record of its own (a withdrawn one included), for imported approvals, or for items in the trash.
- In the desktop app, a carried approval that GitHub does not have yet is committed and pushed like any approval, once, when the library opens or after a pull. The commit holds the portable revision, the carried approval and `item.json`, and removes the path-bearing revision from the item folder. Another machine that pulls it has nothing left to do; one that did the same cleanup first wrote the same files, so the merge is clean.
- Path-bearing revisions leave the shared `revisions/` folder for machine-private `private-revisions/` and remain readable in this machine's history. The approvals that name them stay as history.

## Verification and recovery

Run `node .kiln/validate.mjs` from the repository root. It verifies immutable revision hashes, current content and supporting assets, and safe bundle paths. It never executes skills. The workflow uses pinned GitHub Actions revisions and read-only repository permissions.

Kiln journals destination switches with stage/backup paths and exact hashes. Recovery only completes or restores a state that matches that journal. Unknown or changed files require inspection. Uninstall and rollback refuse to overwrite external edits.

JSON export includes authored items and revision history, approvals for unchanged revision identities, redacted experiment and activity summaries, and custom collections. Reserved session attachments and absolute machine-source paths are removed; transformed revisions receive new hashes and their old approvals are excluded. Imported binary resources remain embedded. Machine-specific file references need a local mapping after transport. Secrets deliberately written into authored content remain authored content; Kiln does not claim to redact arbitrary prose.

Skill installation locations and the optional `codex-native` desired-install token are documented in [Skill locations](SKILL_LOCATIONS.md). Existing `codex` entries retain their shared `.agents/skills` destination.

Item save intents live under the ignored `workbench/.transactions/` directory until the complete revision is written. Recovery runs under the shared mutation lock before external file reconciliation. Legacy snapshots containing raw sessions or machine provenance are archived under machine-private `private-revisions/`. A current revision with a raw session becomes an unapproved clean draft; one with only a machine path keeps its approval ([Portable provenance](#portable-provenance)). Remote Git history is never rewritten automatically.
