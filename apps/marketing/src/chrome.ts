// The header and footer every page shares. Internal links are built from the site's base path, so they work both at `/`
// and under `/kiln/` on GitHub Pages.
import { home, installer, issues, kofi, releases, repository, support } from './content';
import { heart, logo } from './ui';

export type Page = 'home' | 'support';

export function siteHeader(page: Page) {
  // On the homepage the section links stay on the page; elsewhere they lead back to it.
  const at = (hash: string) => (page === 'home' ? hash : `${home}${hash}`);
  return `<header class="site-header"><a class="brand" href="${page === 'home' ? '#main' : home}">${logo(20)}Kiln</a>
    <nav aria-label="Main navigation"><a href="${at('#folders')}">My folders</a><a href="${at('#new-skills')}">New skills</a><a href="${kofi}" class="header-sponsor" aria-label="Sponsor Kiln on Ko-fi">${heart(15)}<span>Sponsor</span></a><a href="${at('#download')}" class="header-download">Download</a></nav></header>`;
}

export function siteFooter() {
  return `<footer class="site-footer">
    <div class="footer-brand"><a class="brand" href="${home}">${logo(18)}Kiln</a><p>Free and MIT licensed. Built by one developer.</p></div>
    <nav aria-label="Footer"><a href="${installer}">Download for Windows</a><a href="${releases}">All releases</a><a href="${repository}">Source on GitHub</a><a href="${issues}">Report an issue</a><a href="${support}">${heart(13)} Support Kiln</a></nav>
  </footer>`;
}
