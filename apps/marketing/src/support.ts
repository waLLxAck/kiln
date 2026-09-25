// The support page: why Kiln asks for support, the Ko-fi button, and the other ways to help. Same printed sheet and red pen
// as the homepage, with the pen marks drawn once on load.
import './fonts/fonts.css';
import './styles.css';
import { refineMacDownload, siteFooter, siteHeader } from './chrome';
import { home, issues, kofi, repository } from './content';
import { prefersReducedMotion } from './motion';
import { ellipse, line, reseed } from './rough';
import { icon } from './ui';

const cup = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 8h13v5.5A5.5 5.5 0 0 1 11.5 19h-2A5.5 5.5 0 0 1 4 13.5zM17 9.5h1.5a2.5 2.5 0 0 1 0 5H17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 3.5c-.8 1 .8 1.6 0 2.8M12.5 3.5c-.8 1 .8 1.6 0 2.8" fill="none" stroke="#e8892b" stroke-width="1.6" stroke-linecap="round"/></svg>';

const arrow = icon('M4 10h12M11 5l5 5-5 5', 13);

/** A red-pen mark over an inline element. Its stroke is drawn in pixels once the page is laid out (see drawPens). */
const pen = (kind: 'circle' | 'underline') => `<svg class="pen-mark pen-${kind}" data-pen="${kind}" aria-hidden="true"><path class="pen-stroke" pathLength="1"/></svg>`;

function drawPens(root: HTMLElement) {
  reseed(11);
  root.querySelectorAll<SVGSVGElement>('[data-pen]').forEach(svg => {
    const { width: w, height: h } = svg.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.querySelector('path')!.setAttribute('d', svg.dataset.pen === 'circle' ? ellipse(w / 2, h / 2, w / 2 - 4, h / 2 - 4, .05) : line(3, h * .75, w - 3, h * .45, 1.2));
  });
}

function markup() {
  const circle = pen('circle'), underline = pen('underline');
  const help = [
    { title: 'Star the repository', text: 'Stars help other people find Kiln on GitHub, and tell me the work is landing somewhere.', link: repository, label: 'waLLxAck/kiln on GitHub' },
    { title: 'Report what breaks', text: 'An issue with the steps, what you expected and what happened is the most useful thing you can send. Ideas and questions are welcome too, and so are pull requests.', link: issues, label: 'Open an issue' },
    { title: 'Share it', text: 'Know someone whose agents load skills they forgot they had? Send them the homepage.', link: home, label: 'The Kiln homepage' },
  ];
  return `<div class="page support-page" data-page>
    ${siteHeader('support')}
    <main id="main">
      <section class="hero support-hero" aria-labelledby="support-title">
        <h1 id="support-title">Kiln is <span class="pen-target">free${circle}</span>. Keeping it going takes time.</h1>
        <div class="hero-side">
          <p>I build Kiln on my own. It’s MIT licensed, and every feature is in the free download. If it saves you time, you can help pay for the time it takes to keep building it.</p>
        </div>
      </section>
      <section class="sheet support-sheet" aria-labelledby="why-title">
        <i class="crop crop-tl"></i><i class="crop crop-tr"></i><i class="crop crop-bl"></i><i class="crop crop-br"></i>
        <div class="support-grid">
          <div class="support-letter">
            <h2 id="why-title">Why I’m asking</h2>
            <p>I made Kiln because my agents were loading skills I’d forgotten I had, and I couldn’t tell which version of a prompt I had actually tested. It’s the tool I wanted, so I’m giving it away.</p>
            <p>Codex, Claude Code and Copilot keep changing. Keeping Kiln in step with them, fixing what you report and shipping the next release is <span class="pen-target">real time${underline}</span>. Support pays for it.</p>
            <p>Paying unlocks nothing. There’s no paid tier, no account and no tracking on this site, and Kiln works the same whether you give or not.</p>
            <p class="support-cta"><a class="kofi-button" href="${kofi}" data-kofi>${cup}<span>Support Kiln on Ko-fi</span></a></p>
            <p class="fine">The button opens Ko-fi, which handles the payment. A one-off coffee helps as much as anything.</p>
            <p class="pen-note is-on support-thanks" style="--r:-3deg">Thank you, really.</p>
          </div>
          <div class="support-help">
            <h2>Other ways to help</h2>
            <ol class="help-list">${help.map((h, i) => `<li><span class="help-number" aria-hidden="true">${i + 1}</span><div><h3>${h.title}</h3><p>${h.text}</p><a href="${h.link}">${h.label}${arrow}</a></div></li>`).join('')}</ol>
            <p class="pen-note is-on support-margin" style="--r:2deg">A good bug report is worth a coffee to me.</p>
          </div>
        </div>
      </section>
    </main>
    ${siteFooter()}
  </div>`;
}

const root = document.querySelector<HTMLElement>('#app')!;
root.innerHTML = markup();
refineMacDownload(root);
drawPens(root);
document.fonts?.ready.then(() => drawPens(root));
addEventListener('resize', () => drawPens(root));
// Draw the pen marks once the page is showing; reduced motion gets them drawn already.
const marks = root.querySelectorAll('.pen-mark');
if (prefersReducedMotion()) marks.forEach(mark => mark.classList.add('is-on'));
else requestAnimationFrame(() => requestAnimationFrame(() => marks.forEach((mark, i) => { (mark as HTMLElement).style.setProperty('--i', String(i + 1)); mark.classList.add('is-on'); })));
