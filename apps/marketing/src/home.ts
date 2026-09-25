// The Kiln homepage: a founder's marked-up printout. A hero, two printed sheets reviewed in red pen (the skill folders tidied
// into Kiln, then a new skill captured, tested and approved), and the download.
import './fonts/fonts.css';
import './styles.css';
import { downloadButton, refineMacDownload, siteFooter, siteHeader } from './chrome';
import { downloads, issues, kofi, primaryDownload, releases, support, version, type Download, type Os } from './content';
import { bindTidy, drawDoodle, folderMarks, folderNotes, foldersMarkup } from './folders';
import { createInk } from './ink';
import { bindNewSkills, newSkillMarks, newSkillNotes, newSkillsMarkup } from './new-skills';
import { bindPanels } from './panel';
import { heart } from './ui';

/** What to do after downloading, per platform. The macOS and Linux builds are new and have not been tested on real machines. */
const installNotes: Record<Os, (file: (key: Download['key']) => string) => string> = {
  windows: () => '<b>Windows:</b> the installer is unsigned, so Windows SmartScreen may warn you before it runs. Choose <b>More info</b>, then <b>Run anyway</b>.',
  mac: () => '<b>macOS</b> (new, untested): Kiln isn’t notarized by Apple, so macOS blocks the first launch. Drag Kiln to Applications, then right-click it and choose <b>Open</b>. On macOS 15 and later, choose <b>Open Anyway</b> in System Settings → Privacy &amp; Security instead. Or clear the quarantine flag in Terminal: <code>xattr -dr com.apple.quarantine /Applications/Kiln.app</code>.',
  linux: file => `<b>Linux</b> (new, untested): make the AppImage executable with <code>chmod +x ${file('appimage')}</code> and run it; AppImages need FUSE 2 (<code>libfuse2</code>, or <code>libfuse2t64</code> on Ubuntu 24.04). Or install the package with <code>sudo apt install ./${file('deb')}</code>. Ubuntu 23.10 and later block the user namespaces Chromium’s sandbox uses, so there the AppImage starts itself with <code>--no-sandbox</code>; if it still stops with a sandbox error, pass <code>--no-sandbox</code> yourself. The .deb installs an AppArmor profile meant to keep the sandbox on.`,
};

/** The download: a button for the visitor's platform, the other files as links, and the install notes, this platform's first. */
function downloadBlock() {
  const primary = primaryDownload();
  const others = downloads.filter(d => d.key !== primary.key);
  const order = [primary.os, ...(['windows', 'mac', 'linux'] as Os[]).filter(os => os !== primary.os)];
  const fileOf = (key: Download['key']) => downloads.find(d => d.key === key)!.file;
  return `${downloadButton(primary, os => `Download Kiln ${version} for ${os}`)}
      <p class="download-file" data-download-file>${primary.file} · ${primary.label}</p>
      <p class="download-others" aria-label="Other platforms">Also for ${others.map(d => `<a href="${d.url}" data-download-other="${d.key}">${d.label}${d.os === 'linux' ? ` (${d.detail})` : ''}</a>`).join('')}</p>
      <p class="download-links"><a href="${releases}">All releases and release notes</a><a href="${support}">Support Kiln</a></p>
      <div class="install-notes">${order.map(os => `<p class="fine" data-install-note="${os}">${installNotes[os](fileOf)}</p>`).join('')}</div>`;
}

function closing() {
  const faq = [
    ['Do I need an API key?', 'No. Kiln drives the Codex or Claude Code you’re already signed into, on your ChatGPT or Claude plan. Its usage limits still apply. Editing, approving and installing never call a model.'],
    ['Will a test change my code?', 'No. Experiments are read-only, and the output is saved with the exact revision you ran.'],
    ['Where does an approved skill live?', 'Approval pins that revision and publishes it to your own Kiln GitHub repository. On another machine, run <code>kiln skills sync</code>.'],
    ['Is Kiln free?', `Yes, and MIT licensed. I build it on my own; if it saves you time, you can <a href="${kofi}">support it on Ko-fi</a>. <a href="${support}">Other ways to help</a>.`],
  ];
  return `<section class="closing" id="download" aria-labelledby="download-title">
    <div class="get-kiln">
      <h2 id="download-title">Point it at your own skill folders.</h2>
      <p>Import what you have, switch off what you don’t use, and test the next prompt you save on your own repo.</p>
      ${downloadBlock()}
      <p class="fine">Kiln is a desktop app for Windows, macOS and Linux with a CLI your agents can use, MIT licensed. It was built on Windows. The macOS and Linux builds are new in ${version} and haven’t been tested on real machines yet, so please <a href="${issues}">report what breaks</a>.</p>
    </div>
    <dl class="faq">${faq.map(([q, a]) => `<div><dt>${q}</dt><dd>${a}</dd></div>`).join('')}</dl>
  </section>`;
}

export function renderHome(root: HTMLElement) {
  root.innerHTML = `<div class="page" data-page>
    ${siteHeader('home')}
    <main id="main">
      <section class="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">My agents were loading skills I forgot I had. So I built this.</h1>
        <div class="hero-side">
          <p>Kiln is a desktop app for Windows, macOS and Linux that works with Codex, Claude Code and Copilot. It shows every skill your agents load, one switch per folder, and lets you test a new prompt on your own repo before it becomes one.</p>
          <div class="hero-actions">${downloadButton(primaryDownload(), os => `Download for ${os}`)}<a class="text-link" href="#download">Other platforms</a><a class="text-link" href="#folders">See my folders</a></div>
          <p class="hero-sponsor"><a href="${kofi}">${heart(15)}<span>Kiln is free. If it saves you time, <u>sponsor it on Ko-fi</u>.</span></a></p>
        </div>
      </section>
      ${foldersMarkup()}
      ${newSkillsMarkup()}
      ${closing()}
    </main>
    ${siteFooter()}
  </div>`;
  const page = root.querySelector<HTMLElement>('[data-page]')!;
  refineMacDownload(root);
  // Wide screens put the red-pen notes in the margins, next to what they point at; narrower ones stack them between the blocks.
  const isWide = () => innerWidth >= 1100;
  const setLayout = () => { page.classList.toggle('layout-wide', isWide()); page.classList.toggle('layout-stacked', !isWide()); };
  setLayout();
  const folderInk = createInk(root.querySelector('.folders')!, folderNotes, folderMarks, isWide);
  const newSkillInk = createInk(root.querySelector('.new-skills')!, newSkillNotes, newSkillMarks, isWide);
  const refresh = () => { drawDoodle(root); folderInk.refresh(); newSkillInk.refresh(); };
  const panels = bindPanels(root, [folderInk, newSkillInk]);
  const tidy = bindTidy(root, panels, folderInk);
  bindNewSkills(root, page, panels, tidy, newSkillInk);
  addEventListener('resize', () => { setLayout(); refresh(); });
  document.fonts?.ready.then(refresh);
  drawDoodle(root);
  newSkillInk.reach('shown');
  tidy.start();
}
