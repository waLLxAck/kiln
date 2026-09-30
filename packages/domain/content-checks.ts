import { validateAgent } from './agent-format';
import { mcpChecks } from './mcp-format';
import { parse } from 'yaml';
import type { Authoring } from '../protocol/schema';

/** One problem found in an item's text, with the 1-based line it is about when there is one. */
export type ContentCheck = { message: string; line?: number };
type Checked = Pick<Authoring, 'kind' | 'content' | 'files' | 'agent'>;

/** 1-based line number of a character offset. */
const lineAt = (text: string, offset: number) => { let line = 1; for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++; return line; };
/** Line of a top-level `key:` inside the frontmatter, which starts on line 2. */
function keyLine(frontmatter: string, key: string) {
  const index = frontmatter.split(/\r?\n/).findIndex(l => new RegExp(`^${key}\\s*:`).test(l));
  return index < 0 ? 1 : index + 2;
}

/**
 * The problems `validateContent` reports, without its storage checks (paths and base64 of bundled files), so the
 * renderer can run them while you type. Pure apart from the YAML and TOML parsers: safe for the renderer bundle.
 * Messages come in the same order `validateContent` reports them; it removes duplicates.
 */
export function contentChecks(value: Checked): ContentCheck[] {
  const problems: ContentCheck[] = [];
  if (value.kind === 'agent') problems.push(...validateAgent(value).map(message => ({ message })));
  if (value.kind === 'skill') {
    const match = value.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) problems.push({ message: 'SKILL.md needs YAML frontmatter with name and description.', line: 1 });
    else {
      try {
        const meta = parse(match[1]);
        if (!meta || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64) problems.push({ message: 'Skill name must be lowercase words separated by hyphens (up to 64 characters).', line: keyLine(match[1], 'name') });
        if (typeof meta?.description !== 'string' || !meta.description.trim() || meta.description.length > 1024) problems.push({ message: 'Add a description explaining when to use the skill (up to 1,024 characters).', line: keyLine(match[1], 'description') });
      } catch (error) {
        const position = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
        problems.push({ message: 'Skill frontmatter is invalid YAML.', line: position ? position + 1 : 1 });
      }
    }
    for (const match of value.content.matchAll(/\]\(([^)]+)\)/g)) {
      const reference = match[1].split('#')[0].replace(/^\.\//, '');
      const present = Object.hasOwn(value.files, reference) || (reference.endsWith('/') && Object.keys(value.files).some(name => name.startsWith(reference)));
      if (reference && !/^(https?:|mailto:)/i.test(reference) && !present) problems.push({ message: `Missing or unsupported local reference: ${reference}`, line: lineAt(value.content, match.index ?? 0) });
    }
  }
  if (value.kind === 'link') {
    try { const url = new URL(value.content.trim().split('\n')[0]); if (!['http:', 'https:'].includes(url.protocol)) problems.push({ message: 'Links must use HTTP or HTTPS.', line: 1 }); } catch { problems.push({ message: 'The first line must be a valid web URL.', line: 1 }); }
  }
  if (value.kind === 'mcp') problems.push(...mcpChecks(value.content));
  if (value.kind === 'reference' && !value.content.trim()) problems.push({ message: 'Add an absolute file path. This is a reference, not a backup.', line: 1 });
  return problems;
}
