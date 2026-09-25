// Act 2, "Then: how do I add new skills to this?": drag the phone, the post or the repo into Capture, drag the prompt into
// Test, fix the one line that made it uncertain, rerun it, approve it, and it lands on the same skills panel with its
// install switches off, waiting for you to flip them. Test runs replay sample output; nothing on this page calls a model.
import { packs, type LogLine, type Pack, type SourceKey } from './content';
import { draggable, flyInto } from './drag';
import type { Ink, InkMark, InkNote } from './ink';
import { prefersReducedMotion, restart, wait } from './motion';
import { panelMarkup, type Panels } from './panel';
import type { Tidy } from './folders';
import { editor, icon, icons, penNote, titlebar } from './ui';

export const newSkillNotes: InkNote[] = [
  { id: 'n-drag', when: 'shown', until: 'captured', target: '[data-zone="capture"]', mark: 'none', side: 'above', ref: '[data-capture-window]', dx: 40, w: 330 },
  { id: 'n-star', when: 'captured-prompt', until: 'captured-gh', target: '[data-star]', mark: 'none', side: 'above', ref: '[data-capture-window]', dx: 30, w: 360 },
  { id: 'n-gh', when: 'captured-gh', until: 'captured-prompt', target: '[data-star]', mark: 'none', side: 'above', ref: '[data-capture-window]', dx: 30, w: 360 },
  { id: 'n-ro', when: 'shown', target: '[data-ro]', mark: 'circle', side: 'right', w: 170 },
  { id: 'n-tokens', when: 'ran', target: '[data-meter]', mark: 'none', side: 'right', w: 170 },
  { id: 'n-uncertain', when: 'uncertain', until: 'passed', target: '[data-edit]', mark: 'box', side: 'right', w: 170 },
  { id: 'n-verdict', when: 'passed', target: '[data-yours]', mark: 'box', side: 'right', w: 170 },
  { id: 'n-landed', when: 'approved', target: '[data-panel="landing"] tr.is-fresh:last-child td:last-child', mark: 'none', side: 'right', w: 170 },
];
export const newSkillMarks: InkMark[] = [
  { id: 'm-yt', when: 'shown', target: '[data-src="yt"] .phone', mark: 'loop', pad: 2 },
  { id: 'm-x', when: 'shown', target: '[data-src="x"] .clipping', mark: 'loop', pad: 2 },
  { id: 'm-gh', when: 'shown', target: '[data-src="gh"] .clipping', mark: 'loop', pad: 2 },
];

function phone() {
  return `<div class="phone"><div class="phone-screen">
    <p class="phone-status"><span>9:41</span><i class="island"></i><span class="phone-bat"><i></i></span></p>
    <div class="player">
      <div class="frame"><i class="frame-sun"></i><span class="frame-tab"><i class="frame-icon"></i><i class="frame-line"></i><i class="frame-line"></i></span></div>
      <div class="paused"><span class="ctl ctl-prev"></span><span class="ctl ctl-play"><i></i></span><span class="ctl ctl-next"></span></div>
      <p class="player-time"><b>4:12</b> / 18:24</p>
      <span class="scrub"><i></i><b></b></span>
    </div>
    <div class="yt-info"><b>I let a seven-year-old test my app (with an agent)</b><small>31K views · 3 weeks ago</small></div>
    <p class="yt-chan"><i class="avatar avatar-yt">P</i><span>Pixel &amp; Pine</span><em>Subscribe</em></p>
    <p class="yt-pills"><span>Like</span><span>Share</span><span>Save</span></p>
    <p class="yt-next"><i></i><span></span></p><p class="yt-next"><i></i><span></span></p>
  </div></div>`;
}

function sources() {
  const x = `<div class="clipping x-post"><header><i class="avatar">NB</i><p><b>Nadia Brooks</b><small>@nadiabuilds · 2h</small></p><span class="x-logo" aria-hidden="true"></span></header>
    <p class="x-text">Agent did exactly what you didn’t mean? Don’t fix the output. Ask it which instruction made it do that, then fix the instruction.</p>
    <footer aria-hidden="true">${icon('M4 5h12v8H9l-4 3v-3H4z', 13)}${icon('M5 8l3-3 3 3M8 5v8h6M15 12l-3 3-3-3', 13)}${icon('M10 16s-6-3.6-6-8a3 3 0 0 1 6-1 3 3 0 0 1 6 1c0 4.4-6 8-6 8z', 13)}</footer></div>`;
  const gh = `<div class="clipping gh-repo"><header><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.71 1.71.75.75 0 0 1-1.07 1.05A2.5 2.5 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.71A2.5 2.5 0 0 1 4.5 9h8Z"/></svg><p><span>mattpocock</span> / <b>skills</b></p><em>Public</em></header>
    <div class="gh-bar"><span>main</span><b>Code &#x25BE;</b></div>
    <ul><li class="is-dir">skills/</li><li>README.md</li><li>LICENSE</li></ul></div>`;
  const labels: Record<SourceKey, string> = {
    yt: 'A phone playing a YouTube video, paused at 4:12 of 18:24: I let a seven-year-old test my app (with an agent), by Pixel &amp; Pine. Drag it into Kiln’s capture area.',
    x: 'A clipped post on X by Nadia Brooks, @nadiabuilds. Drag it into Kiln’s capture area.',
    gh: 'A clipped GitHub page for the repository mattpocock/skills. Drag it into Kiln’s capture area.',
  };
  const item = (key: SourceKey, art: string, caption: string, rot: number, tape: boolean) => `<div class="source" data-src="${key}" style="--rot:${rot}deg">
    <div class="source-drag${key === 'yt' ? ' phone-holder' : ''}" data-drag="${key}" data-r="${rot}" aria-label="${labels[key]}" role="group">${tape ? '<i class="tape" aria-hidden="true"></i>' : ''}${art}</div>
    <p class="source-foot"><span>${caption}</span><button type="button" class="btn btn-sm" data-add="${key}">Add to Kiln</button></p>
  </div>`;
  return `<div class="sources" aria-label="Where good ideas come from">
    ${item('yt', phone(), 'watched it twice. tried it never.', -2.2, false)}
    ${item('x', x, 'saved. obviously never tried.', 1.2, true)}
    ${item('gh', gh, 'a whole repo of them.', -.8, true)}
  </div>`;
}

export function newSkillsMarkup() {
  const repos = ['~/code/my-game', '~/code/recipe-box', 'Isolated example'];
  const rail: [keyof typeof icons, string][] = [['capture', 'Capture'], ['library', 'Library'], ['tests', 'Tests'], ['skills', 'Skills'], ['config', 'Config']];
  return `<section class="sheet new-skills" id="new-skills" aria-labelledby="new-skills-title">
    <i class="crop crop-tl"></i><i class="crop crop-tr"></i><i class="crop crop-bl"></i><i class="crop crop-br"></i>
    <header class="sheet-head">
      <h2 id="new-skills-title">Then: how do I add new skills to this?</h2>
      <p>I’d find a great prompt in a video, save it, and never try it. Now I drag it into Kiln, test it on a repo, and keep it only if it works.</p>
    </header>
    <div class="new-skills-grid">
      ${sources()}
      <div class="app-window capture-window" data-capture-window>
        ${titlebar()}
        <div class="app-body">
          <nav class="rail" aria-label="Sample app sections">${rail.map(([key, name], i) => `<span class="${i === 0 ? 'is-lit' : ''}">${icon(icons[key], 17)}<small>${name}</small></span>`).join('')}</nav>
          <div class="pen-notes">${penNote('n-drag', 'drag one in here. <small>(no mouse? tab to <b>Add to Kiln</b>.)</small>', -1.5)}${penNote('n-star', 'the prompt is the star. techniques, insights and tools come along, <b>with timestamps</b>.', -1.5)}${penNote('n-gh', 'a repo comes in as drafts. nothing installs until I approve one.', -1.5)}</div>
          <section class="pane capture-pane" data-zone="capture" aria-labelledby="capture-title">
            <header class="pane-head"><b id="capture-title">Capture</b><span>Analyze and add</span><kbd>Ctrl+Shift+Space</kbd></header>
            <div class="capture-body" data-cap></div>
          </section>
          <div class="pen-notes">${penNote('n-ro', 'read-only. it can’t change a line of my code.', 2)}</div>
          <section class="pane test-pane" data-zone="test" aria-labelledby="test-title">
            <header class="pane-head"><b id="test-title">Test</b><span data-rev>no prompt yet</span><span class="run-state" data-live>idle</span></header>
            <div class="test-context">
              <p><span>Experiments inspect your code. They never edit it.</span><i class="badge badge-ro" data-ro>Read-only</i></p>
              <div class="test-pick">
                <label><span>Project (sample)</span><select data-repo>${repos.map(r => `<option>${r}</option>`).join('')}</select></label>
                <label><span>Agent</span><select data-agent><option>Claude Code</option><option>Codex</option></select></label>
              </div>
            </div>
            <div class="test-body" data-testbody></div>
          </section>
          <div class="pen-notes">${penNote('n-verdict', 'pass is the agent’s call. keeping it is <b>mine</b>.', -1.5)}${penNote('n-uncertain', 'it said uncertain instead of faking a pass. one line fixes it.', 1.5)}${penNote('n-tokens', 'every run shows its tokens. <small>(sample numbers. my Claude plan, no API key.)</small>', -2)}</div>
        </div>
        <div class="landing" data-landing hidden>${panelMarkup('landing')}</div>
        <div class="pen-notes">${penNote('n-landed', 'same panel as up top. pick where it goes.', 2)}</div>
      </div>
      <div class="margin-column" data-margin aria-hidden="true"></div>
    </div>
    <svg class="ink-layer" data-ink aria-hidden="true"></svg>
  </section>`;
}

export function bindNewSkills(root: HTMLElement, page: HTMLElement, panels: Panels, tidy: Tidy, ink: Ink) {
  const sheet = root.querySelector<HTMLElement>('.new-skills')!;
  const cap = sheet.querySelector<HTMLElement>('[data-cap]')!;
  const capZone = sheet.querySelector<HTMLElement>('[data-zone="capture"]')!;
  const testZone = sheet.querySelector<HTMLElement>('[data-zone="test"]')!;
  const testBody = sheet.querySelector<HTMLElement>('[data-testbody]')!;
  const live = sheet.querySelector<HTMLElement>('[data-live]')!;
  const revLabel = sheet.querySelector<HTMLElement>('[data-rev]')!;
  const repo = sheet.querySelector<HTMLSelectElement>('[data-repo]')!;
  const agent = sheet.querySelector<HTMLSelectElement>('[data-agent]')!;
  const landing = sheet.querySelector<HTMLElement>('[data-landing]')!;
  let pack: Pack | null = null, rev = 1, phase: 'empty' | 'ready' | 'running' | 'uncertain' | 'passed' | 'approved' = 'empty', analysing = false;
  const approved = new Set<string>();

  const idleCapture = () => `<div class="drop" data-capdrop>
    <span class="drop-icon">${icon(icons.capture, 22)}</span>
    <p><b>Drop a video, a post, a repo or a screenshot</b><span>Kiln analyzes it and adds what it finds to a collection linked to the source.</span></p>
    <div class="drop-actions"><span class="fake-input">Paste a link or some text…</span><span class="fake-btn">Save only</span><span class="fake-btn fake-btn-ink">Analyze and add</span></div>
    <small>From anywhere: <kbd>Ctrl+Shift+Space</kbd></small>
  </div>`;
  const idleTest = () => `<div class="drop drop-test${pack?.run ? ' is-ready' : ''}">${icon(icons.tests, 22)}<p><b>${pack?.run ? 'Drag the prompt here' : pack ? 'Drafts from a repo are tested one at a time' : 'Nothing to test yet'}</b><span>${pack?.run ? `It runs that exact revision on <code>${repo.value}</code>, read-only. On this page it replays a sample run.` : pack ? 'Open a draft in the app to test it. Here, the video and the post come with a sample run.' : 'Capture a source first. Nothing in your code changes.'}</span></p></div>`;
  cap.innerHTML = idleCapture();
  testBody.innerHTML = idleTest();

  const logLine = ([kind, text]: LogLine) => `<li class="step-${kind}">${icon(icons[kind], 14)}<span>${text}</span></li>`;
  const kindClass = (kind: string) => kind.toLowerCase().replace(/\s+/g, '-');

  function collection(p: Pack) {
    const promptText = p.star.kind === 'Prompt' && rev > 1 && p.run?.edit ? p.star.text.replace(p.run.edit.del, `<mark>${p.run.edit.add}</mark>`) : p.star.text;
    const testable = p.star.kind === 'Prompt';
    return `<div class="collection">
      <p class="collection-head"><b>${p.key === 'yt' ? 'Fresh eyes' : p.key === 'x' ? 'Agent workflows' : 'mattpocock/skills'}</b><span>Collection, linked to ${p.key === 'yt' ? 'the video' : p.key === 'x' ? 'the post' : 'the repository'}</span></p>
      <article class="star-item${testable ? '' : ' is-repo'}" data-star${testable ? ' data-drag="prompt"' : ''} aria-label="${p.star.kind}: ${p.star.title}${testable ? '. Drag it into the test run.' : ''}">
        <header>${testable ? `<span class="grip" aria-hidden="true">${icon('M7 5h.01M13 5h.01M7 10h.01M13 10h.01M7 15h.01M13 15h.01', 15)}</span>` : ''}<i class="kind kind-${kindClass(p.star.kind)}">${testable ? icon(icons.star, 12) : ''}${p.star.kind}</i><span class="rev">${testable ? `rev ${rev}` : 'drafts'}</span></header>
        <h3>${p.star.title}</h3>
        <p class="star-text">${promptText}</p>
        <footer>${p.star.from ? `<a href="#new-skills" class="timestamp" data-ts>${icon(icons.play, 11)}from ${p.star.from}</a>` : `<span class="source-plain">${p.key === 'x' ? 'from the post' : 'from the repository'}</span>`}${testable ? `<button type="button" class="btn btn-sm" data-test-it${phase === 'running' ? ' disabled' : ''}>Test on my repo</button>` : ''}</footer>
      </article>
      <ul class="cards">${p.cards.map((c, i) => `<li style="--i:${i}"><i class="kind">${c.kind}</i><b>${c.title}</b>${c.from ? `<span class="timestamp-small">from ${c.from}</span>` : ''}</li>`).join('')}</ul>
    </div>`;
  }

  function bindStar() {
    const star = cap.querySelector<HTMLElement>('[data-drag="prompt"]');
    if (!star) return;
    draggable(star, { host: page, zones: () => [testZone], enabled: () => phase !== 'running' && phase !== 'approved', onDrop: () => startTest() });
    cap.querySelector<HTMLButtonElement>('[data-test-it]')?.addEventListener('click', () => {
      if (phase === 'running' || phase === 'approved') return;
      flyInto(star, testZone, page).then(() => startTest());
    });
  }

  async function capture(key: SourceKey) {
    if (analysing || phase === 'running') return;
    analysing = true;
    pack = packs[key]; rev = 1; phase = 'empty';
    sheet.querySelectorAll<HTMLElement>('.source').forEach(src => src.classList.toggle('is-used', src.dataset.src === key || src.classList.contains('is-used')));
    capZone.classList.add('is-busy');
    cap.innerHTML = `<div class="analysing">
      <div class="source-chip source-chip-${key}"><span class="source-chip-icon" aria-hidden="true"></span><div><b>${pack.chip}</b><small>${pack.chipMeta}</small></div></div>
      <p class="analyze-line"><span class="spinner" aria-hidden="true"></span>Analyze and add: ${key === 'yt' ? 'reading the captions of an 18-minute video' : key === 'x' ? 'reading the post' : 'importing the skills in skills/ as drafts'}…</p>
      <span class="progress"><i></i></span></div>`;
    testBody.innerHTML = idleTest(); testZone.classList.remove('is-loaded');
    revLabel.textContent = 'no prompt yet'; live.textContent = 'idle'; live.className = 'run-state';
    await wait(1300);
    capZone.classList.remove('is-busy');
    cap.innerHTML = `<p class="found-note"><span class="ok-dot" aria-hidden="true">${icon(icons.check, 13)}</span>${pack.found}</p>${collection(pack)}`;
    cap.querySelector('.collection')!.classList.add('is-new');
    bindStar();
    analysing = false;
    phase = 'ready';
    testBody.innerHTML = idleTest();
    ink.reach('captured');
    ink.reach(key === 'gh' ? 'captured-gh' : 'captured-prompt');
    ink.refresh();
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  async function runLines(lines: LogLine[], total: number, base: { t: number; i: number; c: number; o: number }) {
    const log = testBody.querySelector<HTMLElement>('[data-tlog]')!, elapsed = testBody.querySelector<HTMLElement>('[data-elapsed]')!, tokens = testBody.querySelector<HTMLElement>('[data-tokens]')!;
    for (let i = 0; i < lines.length; i++) {
      await wait(640);
      log.insertAdjacentHTML('beforeend', logLine(lines[i]));
      const k = (i + 1) / lines.length;
      elapsed.textContent = fmt(base.t + total * k);
      tokens.textContent = `${(base.i + 38.4 * k).toFixed(1)}k in · ${(base.c + 26.1 * k).toFixed(1)}k cached · ${(base.o + 1.9 * k).toFixed(1)}k out`;
      ink.refresh();
    }
  }
  const finished = (seconds: number) => {
    testBody.querySelector<HTMLElement>('[data-runmeta]')!.innerHTML = `<span class="ok-dot" aria-hidden="true">${icon(icons.check, 13)}</span><span>Finished in ${fmt(seconds)}. Nothing in <code>${repo.value}</code> changed.</span>`;
  };

  async function startTest() {
    if (!pack?.run || phase === 'running' || phase === 'approved') return;
    const p = pack, run = p.run!;
    phase = 'running';
    cap.querySelectorAll<HTMLButtonElement>('[data-test-it]').forEach(b => { b.disabled = true; });
    cap.querySelector('[data-star]')?.classList.add('is-testing');
    testZone.classList.add('is-loaded');
    revLabel.textContent = `rev ${rev}`;
    live.textContent = 'running'; live.className = 'run-state is-running';
    testBody.innerHTML = `<div class="run-top"><b>${p.star.title}</b><span class="rev">rev ${rev}</span></div>
      <p class="run-meta" data-runmeta><span class="spinner" aria-hidden="true"></span><span>Running on <code>${repo.value}</code> through ${agent.value}, read-only</span></p>
      <div class="meter" data-meter><span><b data-elapsed>0:00</b> elapsed</span><span data-tokens>0.0k in · 0.0k cached · 0.0k out</span><em>sample</em></div>
      <ol class="run-log" data-tlog></ol><div class="verdict-wrap" data-verdict aria-live="polite"></div>`;
    ink.reach('ran');
    await runLines(rev > 1 && run.again ? run.again : run.lines, 178, { t: 0, i: 0, c: 0, o: 0 });
    await wait(420);
    finished(178);
    cap.querySelector('[data-star]')?.classList.remove('is-testing');
    const verdict = testBody.querySelector<HTMLElement>('[data-verdict]')!;
    if (run.verdict === 'uncertain' && rev === 1 && run.edit) {
      phase = 'uncertain'; live.textContent = 'uncertain'; live.className = 'run-state is-unsure';
      verdict.innerHTML = `<div class="verdict verdict-unsure"><b>Uncertain</b><span>The agent’s own assessment. ${run.text}</span></div>
        <div class="prompt-edit" data-edit><p class="prompt-edit-head">Change one line, then run it again on the same repo</p>
        ${editor(`prompt · ${p.star.title}`, 'rev 1 → rev 2', 2, run.edit.del, run.edit.add)}
        <button type="button" class="btn btn-ink" data-rerun>Save as rev 2 and run it</button></div>`;
      ink.reach('uncertain');
      verdict.querySelector<HTMLButtonElement>('[data-rerun]')!.addEventListener('click', rerun);
      verdict.querySelector<HTMLButtonElement>('[data-rerun]')!.focus({ preventScroll: true });
    } else pass(verdict, run.verdict === 'pass' ? run.text : run.passText!);
    cap.querySelectorAll<HTMLButtonElement>('[data-test-it]').forEach(b => { b.disabled = false; });
  }

  async function rerun() {
    if (!pack?.run?.again || phase !== 'uncertain') return;
    const run = pack.run;
    rev = 2; phase = 'running';
    cap.querySelector('.collection')!.outerHTML = collection(pack); bindStar();
    const star = cap.querySelector<HTMLElement>('[data-star]')!;
    star.classList.add('is-testing');
    restart(star.querySelector('mark'), 'is-new');
    cap.querySelector<HTMLButtonElement>('[data-test-it]')!.disabled = true;
    revLabel.textContent = 'rev 2';
    live.textContent = 'running'; live.className = 'run-state is-running';
    testBody.querySelector('.run-top .rev')!.textContent = 'rev 2';
    testBody.querySelector('[data-runmeta]')!.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Running rev 2 on <code>${repo.value}</code>, read-only</span>`;
    const verdict = testBody.querySelector<HTMLElement>('[data-verdict]')!;
    verdict.innerHTML = '';
    testBody.querySelector('[data-tlog]')!.insertAdjacentHTML('beforeend', `<li class="run-log-sep">${icon('M4 10a6 6 0 1 0 2-4.5M4 3.5V6h2.5', 14)}<span>rev 2, same repo</span></li>`);
    ink.refresh();
    await runLines(run.again!, 101, { t: 178, i: 38.4, c: 26.1, o: 1.9 });
    await wait(420);
    finished(279);
    star.classList.remove('is-testing');
    pass(verdict, run.passText!);
    cap.querySelector<HTMLButtonElement>('[data-test-it]')!.disabled = false;
  }

  function pass(verdict: HTMLElement, text: string) {
    const p = pack!;
    phase = 'passed'; live.textContent = 'pass'; live.className = 'run-state is-pass';
    const already = approved.has(p.skill!);
    verdict.innerHTML = `<div class="verdict verdict-pass"><b>Pass</b><span>The agent’s assessment. ${text}</span></div>
      <div class="your-call" data-yours><p><b>Your call.</b> Approving pins rev ${rev} and publishes it to your Kiln repo. Nothing becomes a skill until you do.</p>
      <div class="row-actions"><button type="button" class="btn btn-ink" data-approve${already ? ' disabled' : ''}>${already ? `Approved as ${p.skill}` : `Approve rev ${rev} as a skill`}</button><button type="button" class="btn btn-ghost" data-notyet${already ? ' hidden' : ''}>Not yet</button></div></div>`;
    ink.reach('passed');
    const approve = verdict.querySelector<HTMLButtonElement>('[data-approve]')!;
    approve.addEventListener('click', () => doApprove(approve));
    verdict.querySelector('[data-notyet]')!.addEventListener('click', event => {
      (event.currentTarget as HTMLElement).closest('.your-call')!.querySelector('p')!.innerHTML = '<b>Kept as a prompt.</b> Nothing was installed. Run it again whenever you like.';
    });
    if (!already) approve.focus({ preventScroll: true });
  }

  async function doApprove(button: HTMLButtonElement) {
    const p = pack!;
    if (!p.skill || approved.has(p.skill)) return;
    approved.add(p.skill);
    phase = 'approved';
    tidy.tidyNow();
    button.disabled = true; button.textContent = `Approved as ${p.skill}`;
    button.parentElement!.querySelector('[data-notyet]')?.setAttribute('hidden', '');
    button.closest('.your-call')!.querySelector('p')!.innerHTML = `<b>Approved rev ${rev}.</b> Pinned and published to <code>you/my-kiln</code> on GitHub (sample). Editing it later makes a new draft.`;
    const firstReveal = landing.hidden;
    landing.hidden = false;
    panels.add(p.skill, rev);
    ink.reach('approved');
    const row = landing.querySelector<HTMLElement>(`tr[data-row="${p.skill}"]`)!;
    if (firstReveal && !prefersReducedMotion()) landing.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1)' });
    const r = row.getBoundingClientRect();
    if (r.bottom > innerHeight - 40 || r.top < 0) { row.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); await wait(560); }
    // The prompt's title flies into the new row: the prompt becomes the skill.
    const title = cap.querySelector<HTMLElement>('.star-item h3');
    if (title && !prefersReducedMotion()) {
      const from = title.getBoundingClientRect(), to = row.querySelector('th b')!.getBoundingClientRect();
      const chip = document.createElement('span');
      chip.className = 'skill-chip'; chip.textContent = p.skill; chip.setAttribute('aria-hidden', 'true');
      page.append(chip);
      const W = chip.offsetWidth, H = chip.offsetHeight;
      const fx = from.left + Math.min(from.width, 200) / 2 - W / 2, fy = from.top + from.height / 2 - H / 2;
      Object.assign(chip.style, { left: `${fx}px`, top: `${fy}px` });
      const dx = to.left + to.width / 2 - W / 2 - fx, dy = to.top + to.height / 2 - H / 2 - fy;
      row.classList.add('is-waiting');
      await chip.animate([
        { transform: 'translate(0px, 0px) rotate(-4deg) scale(.6)', opacity: 0 },
        { transform: 'translate(0px, -16px) rotate(-3deg) scale(1.08)', opacity: 1, offset: .18 },
        { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(.9)`, opacity: 1, offset: .82 },
        { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(${to.width / W}, ${to.height / H})`, opacity: 0 },
      ], { duration: 900, easing: 'cubic-bezier(.55,0,.2,1)', fill: 'forwards' }).finished;
      chip.remove(); row.classList.remove('is-waiting');
    }
    root.querySelectorAll<HTMLElement>(`tr[data-row="${p.skill}"]`).forEach(tr => restart(tr, 'is-landed'));
    landing.querySelector<HTMLElement>(`tr[data-row="${p.skill}"] .switch`)?.focus({ preventScroll: true });
    ink.refresh();
  }

  const lock = () => analysing || phase === 'running';
  sheet.querySelectorAll<HTMLElement>('.source [data-drag]').forEach(el => {
    const key = el.dataset.drag as SourceKey;
    draggable(el, { host: page, zones: () => [capZone], enabled: () => !lock(), onDrop: () => capture(key) });
  });
  sheet.querySelectorAll<HTMLButtonElement>('[data-add]').forEach(button => button.addEventListener('click', () => {
    if (lock()) return;
    const key = button.dataset.add as SourceKey;
    flyInto(sheet.querySelector<HTMLElement>(`[data-drag="${key}"]`)!, capZone, page).then(() => capture(key));
  }));
  [repo, agent].forEach(select => select.addEventListener('change', () => { if (phase === 'ready' || phase === 'empty') testBody.innerHTML = idleTest(); }));
  sheet.addEventListener('click', event => { if ((event.target as Element).closest('[data-ts]')) event.preventDefault(); });
}
