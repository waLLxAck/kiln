import { contentChecks } from './content-checks';
import { parse } from 'yaml';
import type { Authoring, Revision } from '../protocol/schema';
import { bundleFiles, digest } from '../storage/files';
import { invariant } from './errors';
import { revisionIdentity } from '../protocol/revision';

export function revisionHash(value: Authoring & { hashVersion?: number; hash?: string }, version = value.hashVersion ?? (value.hash ? 1 : 2)) {
  return digest(revisionIdentity(value, version));
}
/** Bundles `bundleFiles` already accepted. Each is frozen, so it cannot have changed since; verified revisions share theirs. */
const checkedBundles = new WeakSet<Record<string, string>>();
/** Freezes an accepted bundle so `validateContent` need not decode every attachment of it again. */
export function checkedBundle(files: Record<string, string>) { checkedBundles.add(Object.freeze(files)); return files; }
export function validateContent(value: Authoring): string[] {
  if (!checkedBundles.has(value.files)) bundleFiles(value.files);
  invariant(!Object.keys(value.files).some(p => ['skill.md', 'content.md'].includes(p.toLowerCase())), 'INVALID_PATH', 'The main content file cannot be replaced by an attachment.');
  return [...new Set(contentChecks(value).map(p => p.message))];
}
export { isTextFile, variablesIn } from './text';
export function skillName(value: Revision) {
  const match = value.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return String(parse(match?.[1] ?? '')?.name ?? '');
}
// Lives in text.ts so quick search can fill its preview with exactly what `desktop.copy` will put on the clipboard.
export { resolveVariables } from './text';
