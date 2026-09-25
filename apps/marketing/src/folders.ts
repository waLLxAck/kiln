// Act 1, "Here's what was actually in my skill folders": the skill folders, doodled in red pen, tidy themselves into a crisp
// Kiln panel. Folder labels become the columns, every file flies into its own cell, duplicates merge into one row, and the dead
// link and the empty folder crumple into the cleanup bar. The originals stay behind, faded, because Kiln doesn't move your files.
import { folders, rows, slotOf, type DoodleFile, type DoodleFolder } from './content';
import type { Ink, InkMark, InkNote } from './ink';
import { prefersReducedMotion, wait } from './motion';
import { panelMarkup, type Panels } from './panel';
import { cross, folder, line, reseed } from './rough';
import { penNote, titlebar } from './ui';

export const folderNotes: InkNote[] = [
  { id: 'n-merge', when: 'tidied', reserve: true, target: '[data-panel="library"] tr[data-row="code-review"] small', mark: 'underline', side: 'above', ref: '[data-folders-window]', dx: -40, w: 250, bend: 1 },
  { id: 'n-flip', when: 'tidied', reserve: true, target: '[data-slot="col:codex"]', mark: 'none', side: 'above', ref: '[data-folders-window]', dx: 40, w: 260, noArrow: true },
  { id: 'n-amber', when: 'tidied', reserve: true, target: '[data-panel="library"] tr[data-row="code-review"] td[data-col="project"] .switch', mark: 'circle', side: 'right', w: 176 },
  { id: 'n-found', when: 'tidied', reserve: true, target: '[data-panel="library"] tr[data-row="pr-summary"] td[data-col="codex"] .switch', mark: 'circle', side: 'right', w: 176, bend: -1 },
  { id: 'n-clean', when: 'tidied', reserve: true, target: '[data-slot="cleanup"]', mark: 'none', side: 'right', w: 176, dy: 30 },
  { id: 'n-context', when: 'tidied', reserve: true, target: '[data-context]', mark: 'none', side: 'below', ref: '[data-folders-window]', dx: 60, w: 420, bend: -1 },
];
export const folderMarks: InkMark[] = [{ id: 'm-link', when: 'drawn', from: '[data-doodle]', to: '[data-folders-window]', mark: 'link' }];

function doodle() {
  const file = (f: DoodleFile, d: DoodleFolder) => `<li><span class="file${f.broken ? ' is-broken' : ''}" data-flyer data-to="${slotOf(f, d)}" data-r="${d.rot}">${f.text}</span>${f.remark ? `<em>${f.remark}</em>` : ''}</li>`;
  const box = (d: DoodleFolder) => `<div class="folder" style="--rot:${d.rot}deg"><svg class="folder-art" aria-hidden="true"></svg>
    <p class="folder-path" data-flyer data-to="col:${d.col}" data-r="${d.rot}">${d.path} <span>${d.who}</span></p><ul>${d.files.map(f => file(f, d)).join('')}</ul></div>`;
  return `<figure class="doodle" data-doodle role="img" aria-label="A red-pen doodle of five skill folders: ~/.claude/skills with code-review, a duplicate code-review (1), research and writing-for-agents; ~/.agents/skills with another code-review, an older research and a dead link; ~/.codex/skills with a forgotten pr-summary; an empty skill in ~/.copilot/skills; and my-game/.github/skills with a hand-edited code-review and playtest-brief.">
    <div class="doodle-cols">${folders.map(col => `<div class="doodle-col">${col.map(box).join('')}${col.length === 2 ? '<p class="scrawl" data-flyer data-to="context" data-r="-4">which one is<br>Claude reading??</p>' : ''}</div>`).join('')}</div>
  </figure>`;
}

export function foldersMarkup() {
  return `<section class="sheet folders" id="folders" aria-labelledby="folders-title" data-state="mess">
    <i class="crop crop-tl"></i><i class="crop crop-tr"></i><i class="crop crop-bl"></i><i class="crop crop-br"></i>
    <div class="folders-grid">
      <div class="folders-mess">
        <header class="sheet-head">
          <h2 id="folders-title">Here’s what was actually in my skill folders.</h2>
          <p>Five folders, three agents, one skill in three places. Kiln reads them all: one row per skill, one switch per place an agent looks.</p>
        </header>
        ${doodle()}
        <p class="tidy-row"><button type="button" class="btn btn-ink btn-big" data-tidy>Pop them into Kiln</button><span class="tidy-status" data-tidy-status aria-live="polite"></span></p>
      </div>
      <div class="pen-notes">${penNote('n-merge', '3 folders, <b>1 row</b>. the “(1)” copy gets flagged as a duplicate.', -2)}${penNote('n-amber', 'amber = changed outside Kiln. hand-edited, or just old. it shows me the diff first.', 2)}${penNote('n-flip', 'p.s. the switches are real. flip one.', -1.5)}</div>
      <div class="app-window folders-window" data-folders-window>${titlebar()}${panelMarkup('library')}</div>
      <div class="pen-notes">${penNote('n-context', 'every description here rides along on <b>every turn</b>, used or not. switch it off and it’s out of context.', -1)}${penNote('n-clean', 'dead link + empty folder: flagged, cleaned up safely. nothing else touched.', 1.5)}${penNote('n-found', 'the one I forgot I had. import it, or bin it.', -2)}</div>
      <div class="margin-column" data-margin aria-hidden="true"></div>
    </div>
    <div class="flight-layer" data-flight aria-hidden="true"></div>
    <svg class="ink-layer" data-ink aria-hidden="true"></svg>
  </section>`;
}

export function drawDoodle(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.folder').forEach((fold, n) => {
    const svg = fold.querySelector('svg')!, w = fold.offsetWidth, h = fold.offsetHeight;
    if (!w) return;
    const label = fold.querySelector<HTMLElement>('.folder-path')!, top = label.offsetTop + label.offsetHeight + 3;
    const box = fold.getBoundingClientRect();
    reseed(40 + n * 11);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h));
    let d = `<path d="${folder(2, top, w - 6, h - top - 2)}" class="pen-stroke" pathLength="1" style="--i:${n}"/>`;
    fold.querySelectorAll<HTMLElement>('.is-broken').forEach(file => {
      const r = file.getBoundingClientRect(), x = r.left - box.left, y = r.top - box.top + r.height * .55;
      d += `<path d="${cross(x + 5, y, 5.5)}" class="pen-stroke" pathLength="1" style="--i:${n + 1}"/><path d="${line(x + 12, y, x + r.width + 3, y - 1, .8)}" class="pen-stroke" pathLength="1" style="--i:${n + 1.5}"/>`;
    });
    svg.innerHTML = d;
  });
}

export type Tidy = ReturnType<typeof bindTidy>;
export function bindTidy(root: HTMLElement, panels: Panels, ink: Ink) {
  const sheet = root.querySelector<HTMLElement>('.folders')!;
  const doodleEl = sheet.querySelector<HTMLElement>('[data-doodle]')!;
  const panelWindow = sheet.querySelector<HTMLElement>('[data-folders-window]')!;
  const layer = sheet.querySelector<HTMLElement>('[data-flight]')!;
  const button = sheet.querySelector<HTMLButtonElement>('[data-tidy]')!;
  const live = sheet.querySelector<HTMLElement>('[data-tidy-status]')!;
  // Folder labels first (they become the columns), then the files row by row so the copies of one skill merge in sequence,
  // then the junk, then the scrawled question, which lands on the context line that answers it.
  const rank = (el: HTMLElement) => {
    const to = el.dataset.to!;
    if (to.startsWith('col:')) return 0;
    if (to === 'cleanup') return 20;
    if (to === 'context') return 30;
    return 1 + rows.findIndex(r => r.name === to.split(':')[1]) * 2 + (to.startsWith('row:') ? 1 : 0);
  };
  const flyers = [...sheet.querySelectorAll<HTMLElement>('[data-flyer]')].map((el, n) => ({ el, n })).sort((a, b) => rank(a.el) - rank(b.el) || a.n - b.n).map(item => item.el);
  const tabs = flyers.filter(el => el.dataset.to!.startsWith('col:')).length;
  let busy = false, touched = false;
  const setState = (state: 'mess' | 'tidying' | 'tidy' | 'messing') => {
    sheet.dataset.state = state;
    panelWindow.inert = state !== 'tidy';
    button.textContent = state === 'tidy' || state === 'tidying' ? 'Put them back' : 'Pop them into Kiln';
    button.disabled = state === 'tidying' || state === 'messing';
  };
  const aim = (to: string) => { const slot = panels.slot(to)!; return slot.querySelector<HTMLElement>('[data-aim]') ?? slot; };

  // FLIP: First is the file in its folder, Last is its column header, cell or row in the panel. A clone flies in a layer over
  // the sheet; the original stays behind, faded, because Kiln doesn't move your files. Junk crumples into a paper ball.
  function plan(el: HTMLElement) {
    const box = layer.getBoundingClientRect(), rect = el.getBoundingClientRect(), W = el.offsetWidth, H = el.offsetHeight;
    const cx = rect.left + rect.width / 2 - box.left, cy = rect.top + rect.height / 2 - box.top, rotate = Number(el.dataset.r) || 0;
    const to = el.dataset.to!, target = aim(to).getBoundingClientRect();
    const dx = target.left - box.left + target.width / 2 - cx, dy = target.top - box.top + target.height / 2 - cy;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.removeAttribute('data-flyer'); clone.classList.remove('is-read');
    clone.classList.add('flyer');
    Object.assign(clone.style, { left: `${cx - W / 2}px`, top: `${cy - H / 2}px`, width: `${W}px`, height: `${H}px` });
    if (to === 'cleanup') {
      const flat = 'polygon(0% 0%, 50% 0%, 100% 0%, 100% 50%, 100% 100%, 50% 100%, 0% 100%, 0% 50%)';
      const crushed = 'polygon(10% 14%, 46% 6%, 90% 12%, 82% 48%, 94% 88%, 50% 80%, 8% 92%, 18% 52%)';
      const ball = 'polygon(30% 10%, 50% 30%, 70% 8%, 66% 50%, 74% 92%, 50% 70%, 28% 94%, 34% 50%)';
      const end = Math.max(.14, target.width / W * 1.4);
      clone.classList.add('is-junk');
      return { clone, keyframes: [
        { transform: `translate(0px, 0px) rotate(${rotate}deg) scale(1)`, clipPath: flat, backgroundColor: 'rgba(243, 234, 217, 0)' },
        { transform: `translate(0px, -8px) rotate(${rotate + 14}deg) scale(.78)`, clipPath: crushed, backgroundColor: 'rgba(243, 234, 217, 1)', offset: .22 },
        { transform: `translate(0px, 0px) rotate(${rotate + 70}deg) scale(.42)`, clipPath: ball, backgroundColor: 'rgba(233, 222, 202, 1)', offset: .45 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${rotate + 320}deg) scale(${end})`, clipPath: ball, backgroundColor: 'rgba(233, 222, 202, 1)', opacity: 1, offset: .92 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${rotate + 340}deg) scale(${end})`, clipPath: ball, backgroundColor: 'rgba(233, 222, 202, 1)', opacity: 0 },
      ], duration: 1250, easing: 'cubic-bezier(.45,.05,.4,1)' };
    }
    const sx = target.width / W, sy = target.height / H, mid = Math.min(Math.max(sy * 1.6, .5), 1);
    return { clone, keyframes: [
      { transform: `translate(0px, 0px) rotate(${rotate}deg) scale(1)`, opacity: 1 },
      { transform: `translate(0px, -14px) rotate(${rotate * .4 - 3}deg) scale(1.12)`, opacity: 1, offset: .16 },
      { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(${mid})`, opacity: 1, offset: .78 },
      { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(${Math.min(sx, 1)}, ${Math.min(sy, 1)})`, opacity: 0 },
    ], duration: 880, easing: 'cubic-bezier(.55,0,.2,1)' };
  }

  const finish = () => {
    setState('tidy'); busy = false;
    live.textContent = '11 files, 5 rows. The originals stay where they are.';
    ink.reach('tidied');
  };
  const instant = () => { flyers.forEach(f => f.classList.add('is-read')); panels.landAll(); finish(); };

  async function tidy() {
    if (busy) return;
    touched = true;
    if (prefersReducedMotion()) { instant(); return; }
    busy = true;
    setState('tidying');
    await wait(320);
    const runs = flyers.map((el, n) => {
      const { clone, keyframes, duration, easing } = plan(el), to = el.dataset.to!;
      layer.append(clone);
      const delay = n < tabs ? n * 90 : tabs * 90 + 160 + (n - tabs) * 115;
      const animation = clone.animate(keyframes, { duration, delay, easing, fill: 'both' });
      setTimeout(() => el.classList.add('is-read'), delay);
      return animation.finished.then(() => { clone.remove(); panels.land(to); });
    });
    await Promise.all(runs);
    finish();
  }

  async function untidy() {
    if (busy) return;
    touched = true;
    sheet.querySelectorAll<HTMLElement>('[data-flyout]').forEach(flyout => { flyout.hidden = true; });
    if (prefersReducedMotion()) { panels.clear(); flyers.forEach(f => f.classList.remove('is-read')); setState('mess'); live.textContent = 'Back in their folders.'; return; }
    busy = true;
    setState('messing');
    const order = [...flyers].reverse();
    const runs = order.map((el, n) => {
      const { clone, keyframes, duration, easing } = plan(el), to = el.dataset.to!;
      layer.append(clone);
      const animation = clone.animate(keyframes, { duration: duration * .7, delay: n * 45, easing, fill: 'both', direction: 'reverse' });
      setTimeout(() => panels.unland(to), n * 45);
      return animation.finished.then(() => { el.classList.remove('is-read'); clone.remove(); });
    });
    await Promise.all(runs);
    panels.clear();
    setState('mess'); busy = false;
    live.textContent = 'Back in their folders. Pop them in again whenever you like.';
  }

  button.addEventListener('click', () => (sheet.dataset.state === 'tidy' ? untidy() : tidy()));
  setState('mess');
  return {
    /** Approving a new skill needs the library panel filled; fill it at once if the visitor hasn't tidied up yet. */
    tidyNow() { if (sheet.dataset.state === 'mess' && !busy) { touched = true; instant(); } },
    start() {
      // The doodle draws itself on load; the files tidy themselves into Kiln once the panel is mostly in view.
      const drawn = () => { doodleEl.classList.add('is-drawn'); ink.reach('drawn'); };
      if (prefersReducedMotion()) { drawn(); instant(); return; }
      requestAnimationFrame(() => requestAnimationFrame(drawn));
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        document.fonts.ready.then(() => setTimeout(() => { if (!touched) tidy(); }, 1100));
      }, { threshold: .7 });
      observer.observe(panelWindow);
    },
  };
}
