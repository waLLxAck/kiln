// Kept free of Node imports: the capture dialog and the import dialog recognise repository links with the same rules the scanner uses.

/**
 * A GitHub repository named by a link. `rest` is what followed `/tree/` or `/blob/` (a ref, then maybe a path); refs may contain
 * slashes, so the scanner splits it against the repository's real branches and tags. `blob` links name a file; the scanner
 * reads the folder that holds it.
 */
export type GitHubRepoLink = { owner: string; repo: string; /** `https://github.com/<owner>/<repo>` */ url: string; rest: string; blob: boolean };

const owner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, name = /^[A-Za-z0-9_.-]{1,100}$/;
/** GitHub paths that are not repositories (github.com/settings/…, github.com/orgs/…). */
const reserved = new Set(['orgs', 'settings', 'marketplace', 'features', 'topics', 'collections', 'explore', 'sponsors', 'login', 'join', 'about', 'pricing', 'enterprise', 'apps', 'notifications', 'new', 'search', 'trending', 'issues', 'pulls', 'codespaces', 'users']);

/**
 * Reads `github.com/<owner>/<repo>`, with or without `https://` or `www.`, optionally followed by `.git`, `/tree/<ref>/<path>` or
 * `/blob/<ref>/<file>`. The whole text must be the link (surrounding whitespace aside); anything else, including other GitHub pages
 * such as issues or pull requests, is not a repository source.
 */
export function parseGitHubRepo(text: string): GitHubRepoLink | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)((?:\/[^?#]*)?)(?:[?#].*)?$/i.exec(value);
  if (!match) return null;
  const [, user, rawRepo, tail] = match;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!owner.test(user) || !name.test(repo) || repo === '.' || repo === '..' || reserved.has(user.toLowerCase())) return null;
  const parts = tail.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } });
  if (parts.length && !(['tree', 'blob'].includes(parts[0]) && parts.length >= 2)) return null;
  if (parts.some(part => part === '..' || part === '.' || /[\\\0]/.test(part))) return null;
  return { owner: user, repo, url: `https://github.com/${user}/${repo}`, rest: parts.slice(1).join('/'), blob: parts[0] === 'blob' };
}
/** `owner/repo`, the default collection for what comes from it. */
export const repoName = (link: Pick<GitHubRepoLink, 'owner' | 'repo'>) => `${link.owner}/${link.repo}`;
/** The browsable link to one commit of a repository, and a path inside it: what imported items record as their source. */
export const commitUrl = (link: Pick<GitHubRepoLink, 'url'>, commit: string, relative = '') => `${link.url}/tree/${commit}${relative ? `/${relative.split('/').map(encodeURIComponent).join('/')}` : ''}`;
/**
 * The repository behind a source item Kiln made from a scan: its `source` is the commit link `commitUrl` writes
 * (`https://github.com/<owner>/<repo>/tree/<commit>[/<folder>]`). Null for any other item.
 */
export function repoSourceOf(item: { kind: string; source: string }): { link: GitHubRepoLink; commit: string; scope: string } | null {
  if (item.kind !== 'source') return null;
  const link = parseGitHubRepo(item.source); if (!link || link.blob) return null;
  const [commit, ...scope] = link.rest.split('/');
  return /^[0-9a-f]{40}$/i.test(commit ?? '') ? { link: { ...link, rest: '' }, commit: commit.toLowerCase(), scope: scope.join('/') } : null;
}
