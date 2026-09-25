// The Kiln homepage: a founder's marked-up printout. A hero, two printed sheets reviewed in red pen (the skill folders tidied
// into Kiln, then a new skill captured, tested and approved), and the download.
import './fonts/fonts.css';
import './styles.css';
import { siteFooter, siteHeader } from './chrome';
import { installer, kofi, releases, support, version } from './content';
import { bindTidy, drawDoodle, folderMarks, folderNotes, foldersMarkup } from './folders';
import { createInk } from './ink';
import { bindNewSkills, newSkillMarks, newSkillNotes, newSkillsMarkup } from './new-skills';
import { bindPanels } from './panel';
import { heart, windows } from './ui';

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
      <a class="download-button" href="${installer}">${windows}<span>Download Kiln ${version} for Windows</span></a>
      <p class="download-links"><a href="${releases}">All releases and release notes</a><a href="${support}">Support Kiln</a></p>
      <p class="fine">The build is unsigned, so Windows SmartScreen may warn you before it runs. Choose <b>More info</b>, then <b>Run anyway</b>. Kiln is a Windows app with a CLI your agents can use, MIT licensed.</p>
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
          <p>Kiln is a Windows app for Codex, Claude Code and Copilot. It shows every skill your agents load, one switch per folder, and lets you test a new prompt on your own repo before it becomes one.</p>
          <div class="hero-actions"><a class="download-button" href="${installer}">${windows}<span>Download for Windows</span></a><a class="text-link" href="#folders">See my folders</a></div>
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
