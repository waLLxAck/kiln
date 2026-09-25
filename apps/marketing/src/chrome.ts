// The header and footer every page shares, and the download button both pages use. Internal links are built from the site's base
// path, so they work both at `/` and under `/kiln/` on GitHub Pages.
import { download, home, issues, kofi, osName, primaryDownload, releases, repository, support, type Download } from './content';
import { apple, heart, linux, logo, windows } from './ui';

export type Page = 'home' | 'support';

const osIcon = { windows, mac: apple, linux };
/** The main download button: the file for the visitor's OS. `text` receives the OS name. */
export const downloadButton = (d: Download, text: (os: string) => string) =>
  `<a class="download-button" href="${d.url}" data-download="${d.key}">${osIcon[d.os]}<span>${text(osName[d.os])}</span></a>`;

/**
 * Browsers built on Chromium can say which chip a Mac has; Safari and Firefox can't, so Apple silicon stays the default there.
 * Switches every main download button to the Intel build when the browser reports an x86 Mac.
 */
export function refineMacDownload(root: HTMLElement) {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> } }).userAgentData;
  if (primaryDownload().key !== 'mac-arm64' || data?.platform !== 'macOS' || !data.getHighEntropyValues) return;
  void data.getHighEntropyValues(['architecture']).then(({ architecture }) => {
    if (architecture !== 'x86') return;
    const intel = download('mac-x64'), silicon = download('mac-arm64');
    root.querySelectorAll<HTMLAnchorElement>('a[data-download="mac-arm64"]').forEach(link => { link.href = intel.url; link.dataset.download = intel.key; });
    // The Apple silicon build takes the Intel build's place among the other platforms.
    root.querySelectorAll<HTMLAnchorElement>('a[data-download-other="mac-x64"]').forEach(link => { link.href = silicon.url; link.dataset.downloadOther = silicon.key; link.textContent = silicon.label; });
  }).catch(() => undefined);
}

export function siteHeader(page: Page) {
  // On the homepage the section links stay on the page; elsewhere they lead back to it.
  const at = (hash: string) => (page === 'home' ? hash : `${home}${hash}`);
  return `<header class="site-header"><a class="brand" href="${page === 'home' ? '#main' : home}">${logo(20)}Kiln</a>
    <nav aria-label="Main navigation"><a href="${at('#folders')}">My folders</a><a href="${at('#new-skills')}">New skills</a><a href="${kofi}" class="header-sponsor" aria-label="Sponsor Kiln on Ko-fi">${heart(15)}<span>Sponsor</span></a><a href="${at('#download')}" class="header-download">Download</a></nav></header>`;
}

export function siteFooter() {
  const primary = primaryDownload();
  return `<footer class="site-footer">
    <div class="footer-brand"><a class="brand" href="${home}">${logo(18)}Kiln</a><p>Free and MIT licensed. Built by one developer.</p></div>
    <nav aria-label="Footer"><a href="${primary.url}" data-download="${primary.key}">Download for ${osName[primary.os]}</a><a href="${releases}">All releases</a><a href="${repository}">Source on GitHub</a><a href="${issues}">Report an issue</a><a href="${support}">${heart(13)} Support Kiln</a></nav>
  </footer>`;
}
