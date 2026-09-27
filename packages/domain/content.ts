import { contentChecks } from './content-checks';
import { parse } from 'yaml';
import type { Authoring, Revision } from '../protocol/schema';
import { bundleFiles, digest } from '../storage/files';
import { invariant } from './errors';
import { revisionIdentity } from '../protocol/revision';

export function revisionHash(value: Authoring & { hashVersion?: number; hash?: string }, version = value.hashVersion ?? (value.hash ? 1 : 2)) {
  return digest(revisionIdentity(value, version));
}
export function validateContent(value: Authoring): string[] {
  bundleFiles(value.files);
  invariant(!Object.keys(value.files).some(p => ['skill.md', 'content.md'].includes(p.toLowerCase())), 'INVALID_PATH', 'The main content file cannot be replaced by an attachment.');
  return [...new Set(contentChecks(value).map(p => p.message))];
}
export { isTextFile, variablesIn } from './text';
export function skillName(value: Revision) {
  const match = value.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return String(parse(match?.[1] ?? '')?.name ?? '');
}
/** Every variable is optional: a missing or blank value leaves its `{{name}}` placeholder exactly as written, so the reader sees what was not filled. */
export function resolveVariables(content: string, variables: Record<string, string>) {
  return content.replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (placeholder, key: string) => Object.hasOwn(variables, key) && variables[key].trim() ? variables[key] : placeholder);
}
