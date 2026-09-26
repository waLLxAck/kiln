import { validateAgent } from './agent-format';
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
  const problems: string[] = [];
  if (value.kind === 'agent') problems.push(...validateAgent(value));
  if (value.kind === 'skill') {
    const match = value.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) problems.push('SKILL.md needs YAML frontmatter with name and description.');
    else {
      try {
        const meta = parse(match[1]);
        if (!meta || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64) problems.push('Skill name must be lowercase words separated by hyphens (up to 64 characters).');
        if (typeof meta?.description !== 'string' || !meta.description.trim() || meta.description.length > 1024) problems.push('Add a description explaining when to use the skill (up to 1,024 characters).');
      } catch { problems.push('Skill frontmatter is invalid YAML.'); }
    }
    for (const match of value.content.matchAll(/\]\(([^)]+)\)/g)) {
      const reference = match[1].split('#')[0].replace(/^\.\//, '');
      const present = Object.hasOwn(value.files, reference) || (reference.endsWith('/') && Object.keys(value.files).some(name => name.startsWith(reference)));
      if (reference && !/^(https?:|mailto:)/i.test(reference) && !present) problems.push(`Missing or unsupported local reference: ${reference}`);
    }
  }
  if (value.kind === 'link') {
    try { const url = new URL(value.content.trim().split('\n')[0]); if (!['http:', 'https:'].includes(url.protocol)) problems.push('Links must use HTTP or HTTPS.'); } catch { problems.push('The first line must be a valid web URL.'); }
  }
  if (value.kind === 'reference' && !value.content.trim()) problems.push('Add an absolute file path. This is a reference, not a backup.');
  return [...new Set(problems)];
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
