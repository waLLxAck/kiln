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
```

`kiln.json` declares `format: kiln-library`, `schemaVersion: 1`, a stable `repositoryId`, `library: workbench`, and `infrastructureVersion`. Kiln rejects unsupported schema versions and does not downgrade newer infrastructure.

Item kind `source` marks material an agent analysed (a pasted chat, a page, files, a video). Items made from it name it in `origin`. `analyses/<job id>.json` records each completed analysis: provider, model, effort, token usage, times, summary, takeaway, skipped notes, counts by kind, the created item IDs and the collection. It never holds run steps, commands, paths or the CLI session, which stay machine-private. Records are written once, exported with the library and removed when their source is purged.

Item status is one of `captured`, `testing`, `approved`, `rejected`, or `archived`. Libraries written before v0.2 stored `inbox` for newly captured items; Kiln reads that as `captured` and rewrites the file on its next save.

The stable item ID survives edits, renaming, Git sync, and export/import. An immutable revision stores content, supporting file bytes as base64, title, description, kind, tags, collection, source, licence and agent metadata when applicable. New revisions carry `hashVersion: 2`; legacy revisions without it keep their original identity and remain readable. Its SHA-256 is calculated over a stable serialization of those fields. Approval refers to that exact hash. The collection an item is filed in lives in `item.json`. Moving an item rewrites that file; renaming or deleting a collection rewrites the affected item files and `workbench.json`. Revisions and approvals are never touched, so approvals survive organising. A revision's own `collection` records where the item was when that revision was saved, and an empty collection means the item is unfiled. `/` separates subfolders (`Game Design/Puzzles`); parents are implied, and `workbench.json` keeps the sidebar order and empty collections. Editing working files creates a new draft after reconciliation; historical approved snapshots stay intact.

The infrastructure manifest records hashes of app-owned files. Update previews compare both current and proposed bytes; unmanaged or locally modified files block replacement. Future releases can ship new templates and infrastructure versions without accepting alternate library structures.

## Legacy migration

Migration enumerates tracked `SKILL.md` files, preserving each source path as provenance. It imports the skill directory's regular files and records the nearest upstream licence as item metadata rather than as a bundled file. Malformed skills are preserved as captured items and flagged for review rather than silently repaired or omitted. Bundles over 25 MB or unsafe paths block import with an explicit error.

`.kiln/migration.json` maps each legacy source path to its stable item and source hash. Repeating the import is idempotent. An upstream change creates a new draft if there are no intervening local adaptations; otherwise it reports a conflict. Legacy directories remain as historical sources and support existing junctions. The canonical authoring location is `workbench/`.

## Machine state

The default machine-private root is `~/.kiln`. `library.json` selects the active repository; a path-derived subdirectory stores target enrollments, receipts, journals, private trials, reference mappings, observations, and the rebuildable SQLite index. These files are not transportable approval or ownership evidence. Re-enroll destinations on each machine.

Imported export approvals remain historical evidence with `trust: imported`; they cannot authorize installation automatically. Git repositories are user-selected trusted authoring stores, not a cryptographically signed approval system. Review incoming changes before deployment. A GitHub clone does not install anything.

Approval publishing materializes the exact reviewed revision through a private Git index, with its approval and redacted evidence. It never stages the item's working directory or its unapproved history. Later local edits remain untouched. Imported absolute source paths become portable `local-import:<name>` labels; the original provenance is retained privately. Explicit CLI checkpoints remain an operation that commits all managed working files.

## Verification and recovery

Run `node .kiln/validate.mjs` from the repository root. It verifies immutable revision hashes, current content and supporting assets, and safe bundle paths. It never executes skills. The workflow uses pinned GitHub Actions revisions and read-only repository permissions.

Kiln journals destination switches with stage/backup paths and exact hashes. Recovery only completes or restores a state that matches that journal. Unknown or changed files require inspection. Uninstall and rollback refuse to overwrite external edits.

JSON export includes authored items and revision history, approvals for unchanged revision identities, redacted experiment and activity summaries, and custom collections. Reserved session attachments and absolute machine-source paths are removed; transformed revisions receive new hashes and their old approvals are excluded. Imported binary resources remain embedded. Machine-specific file references need a local mapping after transport. Secrets deliberately written into authored content remain authored content; Kiln does not claim to redact arbitrary prose.

Skill installation locations and the optional `codex-native` desired-install token are documented in [Skill locations](SKILL_LOCATIONS.md). Existing `codex` entries retain their shared `.agents/skills` destination.

Item save intents live under the ignored `workbench/.transactions/` directory until the complete revision is written. Recovery runs under the shared mutation lock before external file reconciliation. Legacy snapshots containing raw sessions or machine provenance are archived under machine-private `private-revisions/`; current content becomes an unapproved clean draft. Remote Git history is never rewritten automatically.
