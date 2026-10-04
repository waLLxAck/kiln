import path from 'node:path';
import { createHash } from 'node:crypto';
import { revisionSchema, type Approval, type Authoring, type Revision, type Trial } from '../protocol/schema';
import { revisionHash } from './content';

export const privateAttachment = (name: string) => /(^|\/)session\.jsonl$/i.test(name);
/**
 * A machine-local location, whatever system wrote it and whatever system reads it: `local:` and `home:` labels, POSIX absolute
 * paths, `~`, Windows drive paths (either slash), UNC paths and `file:` URLs. Deliberately not `path.isAbsolute`, which only
 * knows the current platform: a Linux machine must recognise `C:\Users\…` and Windows must recognise `/home/…`.
 */
export const machinePath = (source: string) => /^(?:local|home):/i.test(source) || /^(?:[A-Za-z]:[\\/]|[\\/]|~(?:[\\/]|$)|file:)/i.test(source);
/** The shared form of a source: a machine-local path keeps only its last segment as `local-import:<name>`. Pure string work, so every OS computes the same label. */
export function portableSource(source: string) {
  return machinePath(source) ? `local-import:${path.posix.basename(source.replaceAll('\\', '/'))}` : source;
}
export function shareableAuthoring<T extends Authoring>(value: T): T {
  const source = portableSource(value.source);
  const originalPath = value.source.replace(/^(?:home|local):/i, '');
  const description = source !== value.source && value.description === `Copy of ${originalPath}` ? `Copy of ${source.slice('local-import:'.length)}` : value.description;
  return { ...value, description, source, files: Object.fromEntries(Object.entries(value.files).filter(([name]) => !privateAttachment(name))) };
}
/** Whether a revision can be written to the shared library as it is: no private session attachment and no machine path. */
export const shareable = (value: Authoring) => !Object.keys(value.files).some(privateAttachment) && portableSource(value.source) === value.source;
/**
 * Whether `to` is `from` with only its machine provenance made portable: the source (and the "Copy of <path>" description that
 * names it) changed, nothing else did. Content, attachments, title, kind, tags, licence and agent metadata must be identical;
 * the collection is organisation and is left out, as everywhere else. A dropped session attachment is a content change.
 */
export function provenanceOnlyChange(from: Authoring, to: Authoring) {
  if (portableSource(from.source) === from.source || !shareable(to)) return false;
  if (Object.keys(from.files).some(privateAttachment)) return false;
  const cleaned = { ...shareableAuthoring(from), collection: to.collection };
  return revisionHash(cleaned, 2) === revisionHash(to, 2);
}
/** How `.kiln/migration.json` names a folder outside the library that skills were imported from: a hash of its path, not the path. */
export const importFolderKey = (folder: string) => `folder-${createHash('sha256').update(folder).digest('hex').slice(0, 16)}`;
/** A migration key as Kiln 0.25 and earlier wrote it (`<absolute folder>::<relative>`) in its portable form; other keys are unchanged. */
export function portableImportKey(key: string) {
  const at = key.lastIndexOf('::');
  return at > 0 && machinePath(key.slice(0, at)) ? `${importFolderKey(key.slice(0, at))}::${key.slice(at + 2)}` : key;
}
/**
 * An activity message written by an older Kiln that ends in a machine path (`Imported “x” from /home/…`, `Bulk removal: C:\…`)
 * with only the last segment of that path; any other message is unchanged.
 */
export function portableMessage(message: string) {
  const match = message.match(/^(.*?(?: from |: ))((?:local:|home:)?(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]).*)$/s);
  return match && machinePath(match[2]) ? `${match[1]}${path.posix.basename(match[2].replace(/^(?:local|home):/i, '').replaceAll('\\', '/'))}` : message;
}
/** Deterministic UUID (version 5 layout) for records two machines must write identically, so Git sees one file, not two. */
export function stableId(...parts: string[]) {
  const bytes = createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/**
 * The revision record for the portable form of `original`. Every field is derived from the original, never from the clock or the
 * user running it, so two machines cleaning the same revision write byte-identical files and their Git histories merge cleanly.
 * `parent` is left empty: the original stays machine-private, and the approval that carries over names it in `carriedFrom`.
 */
export function portableRevision(original: Revision, collection: string): Revision {
  const { hash: _hash, hashVersion: _version, parent: _parent, summary: _summary, schemaVersion: _schema, itemId, author, createdAt, ...authoring } = original;
  const data = { ...shareableAuthoring(authoring), collection };
  // Parsed, so the keys are in the order the publisher writes them and the committed file is the working file.
  return revisionSchema.parse({ schemaVersion: 1, hashVersion: 2, itemId, hash: revisionHash(data, 2), parent: null, author, createdAt, summary: PROVENANCE_SUMMARY, ...data });
}
export const PROVENANCE_SUMMARY = 'Moved machine provenance out of shared content';
/**
 * The approval Kiln records when a revision's machine path was made portable and nothing else changed: the `carriedFrom`
 * precedent of model-invocation changes (SKILL_INVOCATION.md). Its ID and time derive from the approval it carries (one
 * millisecond later, so it is the newest), so every machine that does the same cleanup writes the same file.
 */
export function carriedProvenanceApproval(previous: Approval, to: string): Approval {
  return { schemaVersion: 1, id: stableId('kiln-provenance-carry', previous.id, to), itemId: previous.itemId, revision: to, reviewer: 'Kiln', scope: previous.scope,
    note: `Only the machine-local source path changed from approved ${previous.revision.slice(0, 12)}; content otherwise identical.`,
    evidence: previous.evidence, waivedChecks: previous.waivedChecks, createdAt: Number.isNaN(Date.parse(previous.createdAt)) ? previous.createdAt : new Date(Date.parse(previous.createdAt) + 1).toISOString(), trust: 'local', carriedFrom: previous.revision };
}
export function shareableTrial(trial: Trial): Trial {
  return { ...trial, variables: {}, task: 'Private input excluded', rubric: [], workspace: 'Machine-private', machine: 'local', note: '', outputReference: '' };
}
