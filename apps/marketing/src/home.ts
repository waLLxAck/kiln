// The Kiln homepage: a founder's marked-up printout. A hero, two printed sheets reviewed in red pen (the skill folders tidied
// into Kiln, then a new skill captured, tested and approved), and the download.
import './fonts/fonts.css';
import './styles.css';
import { downloadButton, refineMacDownload, siteFooter, siteHeader } from './chrome';
import { downloads, installGuide, kofi, primaryDownload, releases, support, version } from './content';
import { bindTidy, drawDoodle, folderMarks, folderNotes, foldersMarkup } from './folders';
import { createInk } from './ink';
import { bindNewSkills, newSkillMarks, newSkillNotes, newSkillsMarkup } from './new-skills';
import { bindPanels } from './panel';
import { heart } from './ui';

/** The download, kept short: a button for the visitor's platform, the other files as links, one honest line about the builds, and
 * links to the install steps in the README and to every release. The detailed install notes live in the README and release notes. */
function downloadBlock() {
  const primary = primaryDownload();
  const others = downloads.filter(d => d.key !== primary.key);
  return `${downloadButton(primary, os => `Download Kiln ${version ? `${version} ` : ''}for ${os}`)}
      <p class="download-others" aria-label="Other platforms">Also for ${others.map(d => `<a href="${d.url}" data-download-other="${d.key}">${d.label}${d.os === 'linux' ? ` (${d.detail})` : ''}</a>`).join('')}</p>
      <p class="fine" data-build-note>The Windows build isn’t signed yet, and the macOS and Linux builds are new and untested.</p>
      <p class="download-links"><a href="${installGuide}">How to install</a><a href="${releases}">All releases</a><a href="${support}">Support Kiln</a></p>`;
}

/** Three real screenshots of the app, taped to the page, so the sheets above aren't the only picture of it. */
const shots = [
  { file: 'skill-installs', alt: 'Kiln showing the code-review skill: install switches for the Agents and Claude folders, and the Claude copy flagged as edited outside Kiln.', note: 'one skill, a switch per folder. the Claude copy was edited by hand.' },
  { file: 'video-distilled', alt: 'A YouTube video in Kiln, distilled into a prompt, techniques, an insight and a tool, each linked to its minute in the video.', note: 'a video, turned into a prompt and the bits worth keeping.' },
  { file: 'experiment-result', alt: 'A Claude Code experiment in Kiln: the prompt tested read-only on a local project, with the agent’s output and a pass verdict.', note: 'the prompt, tested on my own repo. read-only, and it passed.' },
];
function screenshotsMarkup() {
  return `<section class="sheet screenshots" id="screenshots" aria-labelledby="screenshots-title">
    <div class="sheet-head"><h2 id="screenshots-title">And here’s the real app.</h2><p>Screenshots of Kiln on Windows, with a made-up library. The agent’s replies in them are scripted.</p></div>
    <ul class="shots">${shots.map((shot, index) => {
      const url = new URL(`./screenshots/${shot.file}.webp`, import.meta.url).href;
      return `<li style="--r:${[-1.2, .8, -.6][index]}deg"><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${shot.alt}" width="1440" height="900" loading="lazy" decoding="async"></a><p class="shot-note">${shot.note}</p></li>`;
    }).join('')}</ul>
  </section>`;
}

function closing() {
  const faq = [
    ['Do I need an API key?', 'No. Kiln drives the Codex or Claude Code you’re already signed into, on your ChatGPT or Claude plan. Its usage limits still apply. Editing, approving and installing never call a model.'],
    ['Will a test change my code?', 'No. Experiments are read-only, and the output is saved with the exact revision you ran.'],
    ['Where does an approved skill live?', 'In your own Kiln repository on GitHub, pinned to the revision you approved, so your other machines can sync it.'],
    ['Is Kiln free?', `Yes, and MIT licensed. I build it on my own; if it saves you time, you can <a href="${kofi}">support it on Ko-fi</a>. <a href="${support}">Other ways to help</a>.`],
  ];
  return `<section class="closing" id="download" aria-labelledby="download-title">
    <div class="get-kiln">
      <h2 id="download-title">Point it at your own skill folders.</h2>
      <p>Import what you have, switch off what you don’t use, and test the next prompt you save on your own repo.</p>
      ${downloadBlock()}
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
      ${screenshotsMarkup()}
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
