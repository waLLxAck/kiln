// Small pieces of markup shared by the page, the panels and the app window.
export const windows = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1 4.3 10.5 3v8H1zm11-1.5L23 1.3V11H12zM1 12.5h9.5v8L1 19.2zm11 0h11v9.7l-11-1.5z"/></svg>';
export const logo = (size = 18) => `<svg class="logo" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1f1c18"/><path d="M8 25V16a8 8 0 0 1 16 0v9z" fill="#f6efe3"/><path d="M13 25v-5.5a3 3 0 0 1 6 0V25z" fill="#e8892b"/></svg>`;
export const icon = (d: string, size = 16) => `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const icons = {
  capture: 'M10 3.5v9M6 8.5l4 4 4-4M3.5 14v2.5h13V14',
  library: 'M4 3.5v13M8 3.5v13M11.5 4.2l3.8 12',
  tests: 'M8 3h4M8.8 3v5L4.5 15.2a1.3 1.3 0 0 0 1.1 1.8h8.8a1.3 1.3 0 0 0 1.1-1.8L11.2 8V3M6.5 12h7',
  skills: 'M3 6.5h8M3 13.5h5M14 4.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM11 11.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM16 6.5h1M14 13.5h3',
  config: 'M5 2.8h6.5L15 6.3v10.9H5zM11.5 2.8v3.5H15M7.5 10h5M7.5 13h3.5',
  read: 'M5 2.8h6.5L15 6.3v10.9H5zM11.5 2.8v3.5H15M7.5 10h5M7.5 13h3.5',
  cmd: 'M3.5 5.5l4 4-4 4M9.5 14.5h7',
  think: 'M10 3a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9zM8 17h4',
  star: 'M10 2.8l2.2 4.6 5 .6-3.7 3.4 1 5-4.5-2.5-4.5 2.5 1-5L2.8 8l5-.6z',
  check: 'M4.5 10.5l3.5 3.5 7.5-8',
  play: 'M6 4.5v11l9-5.5z',
};
export const titlebar = () => `<div class="titlebar">
  <span class="app-name">${logo(15)}Kiln</span>
  <span class="search-all">Search everything<kbd>Ctrl+Shift+Space</kbd></span>
  <span class="git-status">my-kiln · main · <b>synced</b></span>
  <i class="window-controls" aria-hidden="true"><b></b><b></b><b></b></i>
</div>`;
/** A red-pen margin note. It stays hidden until the pen reaches its state (see ink.ts). */
export const penNote = (id: string, text: string, rot = 0) => `<p class="pen-note" data-note="${id}" style="--r:${rot}deg" hidden>${text}</p>`;
export const paperBall = '<svg class="paper-ball" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M4 8.5 7 4l4.5 1L16 4.5l.5 5-2 2.5 1.5 3.5-4.5 1-3.5-1.5L4 16l.5-4z" fill="#fbf5ea" stroke="#8a7f70" stroke-width="1.1" stroke-linejoin="round"/><path d="m7 4 1.5 5 3-4M8.5 9 4.5 12M8.5 9l3.5 3.5 2.5-.5M12 12.5 11 16.5" fill="none" stroke="#8a7f70" stroke-width=".9"/></svg>';

/** A small diff editor: file bar, line numbers, one removed and one added line. Used for drift and for the one-line prompt fix. */
export const editor = (file: string, versions: string, lineNo: number, del: string, add: string) => `<div class="diff">
  <p class="diff-bar"><span>${icon(icons.read, 13)}${file}</span><em>${versions}</em></p>
  <p class="diff-del"><i>${lineNo}</i><span>- ${del}</span></p>
  <p class="diff-add"><i>${lineNo}</i><span>+ ${add}</span></p>
</div>`;
