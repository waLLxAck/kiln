// The skills panel: one row per skill, one switch per place an agent looks. The folders act shows it filling up from the
// doodled folders; the new-skills act shows a second copy of it where the approved skill lands. Both paint from the same rows.
import { columns, off, plain, rows, stateText, targets, type Col, type Row } from './content';
import type { Ink } from './ink';
import { prefersReducedMotion, restart } from './motion';
import { editor, paperBall } from './ui';

export type PanelScope = 'library' | 'landing';

export function panelMarkup(scope: PanelScope) {
  const main = scope === 'library';
  return `<section class="pane panel" data-panel="${scope}" aria-label="${main ? 'Skills panel, sample library' : 'The same skills panel, with the skill you just approved'}">
    <header class="pane-head"><b>Skills</b><span>${main ? 'one row per skill, one switch per place your agents look' : 'just approved, not installed yet'}</span>${main ? '<span class="tabs"><i class="is-on">Installed</i><i>Receipts</i></span>' : '<a class="mini-link" href="#folders" data-see-all>See it with the others</a>'}</header>
    <div class="table-wrap">
      <table><thead><tr><th scope="col">Skill</th>${columns.map(c => `<th scope="col"${main ? ` data-slot="col:${c.key}"` : ''} title="${c.name}"><span>${c.short}</span><code data-aim>${c.path}</code></th>`).join('')}</tr></thead><tbody data-rows></tbody></table>
      ${main ? '<p class="waiting" data-waiting>Kiln hasn’t read your folders yet.</p>' : ''}
    </div>
    ${main ? `<div class="cleanup" data-slot="cleanup"><span class="ball-slot" data-aim>${paperBall}</span><p data-cleanup-text>Found a broken link in <code>~/.agents/skills</code> and an empty skill folder in <code>~/.copilot/skills</code>.</p><button type="button" class="btn" data-cleanup>Clean up safely</button></div>
    <ul class="switch-key" aria-label="What the switches mean"><li><i class="key-swatch key-swatch-on"></i>installed</li><li><i class="key-swatch key-swatch-edited"></i>changed outside Kiln</li><li><i class="key-swatch key-swatch-found"></i>found outside the library</li><li><i class="key-swatch key-swatch-off"></i>off</li></ul>` : ''}
    <footer class="panel-foot"><p class="context"${main ? ' data-slot="context"' : ''}><span class="highlight" data-hl="n-context" data-context data-aim></span></p><p class="status" data-status aria-live="polite"></p></footer>
    <div class="flyout" data-flyout hidden role="dialog" aria-modal="false" aria-label="Skill copy"></div>
  </section>`;
}

export type Panels = ReturnType<typeof bindPanels>;
export function bindPanels(root: HTMLElement, inks: Ink[]) {
  // Which slots of the library panel the tidy-up has filled, so a repaint keeps them.
  const slots = new Set<string>(), rowsIn = new Set<string>();
  let cleaned = false;
  const mounts = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
  const count = (key: Col) => rows.filter(row => row.cells[key] === 'on' || row.cells[key] === 'edited').length;
  const sw = (row: Row, r: number, c: typeof columns[number]) => {
    const state = row.cells[c.key];
    return `<button type="button" role="switch" class="switch switch-${state}" data-row="${r}" data-col="${c.key}" aria-checked="${state === 'on' || state === 'edited'}" aria-label="${row.name} in ${c.name}: ${stateText[state]}"><i></i></button>`;
  };
  const slotAttr = (scope: PanelScope, slot: string) => (scope === 'library' && targets.has(slot) ? ` data-slot="${slot}"${slots.has(slot) ? ' class="is-in"' : ''}` : '');
  const rowHtml = (row: Row, r: number, scope: PanelScope) => `<tr data-row="${row.name}" class="${row.fresh ? 'is-fresh ' : ''}${row.pulse ? 'is-pulse ' : ''}${scope === 'landing' || row.fresh || rowsIn.has(row.name) ? 'is-in' : ''}">
    <th scope="row"${slotAttr(scope, `row:${row.name}`)}><b data-aim>${row.name}</b><small>${row.caption}</small></th>${columns.map(c => `<td data-col="${c.key}"${slotAttr(scope, `cell:${row.name}:${c.key}`)}>${sw(row, r, c)}</td>`).join('')}</tr>`;
  function paint() {
    for (const mount of mounts) {
      const scope = mount.dataset.panel as PanelScope;
      const body = mount.querySelector<HTMLElement>('[data-rows]')!;
      body.innerHTML = rows.map((row, r) => (scope === 'library' || row.fresh ? rowHtml(row, r, scope) : '')).join('');
      mount.querySelector('[data-context]')!.textContent = `Descriptions loaded in every new session: Claude Code ${count('claude')} · shared ${count('shared')} · Codex ${count('codex')} · Copilot ${count('copilot')} · my-game ${count('project')}`;
    }
    const cleanup = root.querySelector<HTMLElement>('[data-slot="cleanup"]')!;
    cleanup.classList.toggle('is-done', cleaned);
    inks.forEach(ink => ink.refresh());
  }
  const say = (mount: HTMLElement, text: string) => { const status = mount.querySelector<HTMLElement>('[data-status]')!; status.textContent = text; restart(status, 'is-new'); };
  const refocus = (mount: HTMLElement, r: number, col: string) => mount.querySelector<HTMLButtonElement>(`[data-row="${r}"][data-col="${col}"]`)?.focus();

  for (const mount of mounts) {
    const flyout = mount.querySelector<HTMLElement>('[data-flyout]')!;
    let returnTo: HTMLElement | null = null;
    // While a flyout is open, the red pen steps back so its circles don't land on the editor.
    const sheetOf = mount.closest('.sheet')!;
    new MutationObserver(() => sheetOf.classList.toggle('has-flyout', !flyout.hidden)).observe(flyout, { attributes: true, attributeFilter: ['hidden'] });
    const closeFlyout = () => { if (flyout.hidden) return; flyout.hidden = true; returnTo?.focus(); returnTo = null; };
    const openFlyout = (html: string, from: HTMLElement) => { flyout.innerHTML = html; flyout.hidden = false; returnTo = from; flyout.querySelector<HTMLElement>('button')?.focus(); };
    mount.addEventListener('click', event => {
      const target = event.target as Element;
      const button = target.closest<HTMLButtonElement>('.switch');
      if (button) {
        const r = Number(button.dataset.row), row = rows[r], c = columns.find(item => item.key === button.dataset.col)!, state = row.cells[c.key], path = plain(c.path);
        if (state === 'edited') {
          const drift = row.drift![c.key]!;
          openFlyout(`<h3><code>${path}/${row.name}</code> changed outside Kiln</h3><p>${drift.why} Compared with approved rev ${row.rev}; Kiln won’t overwrite it without asking.</p>
            ${editor(`${row.name}/SKILL.md`, `approved rev ${row.rev} → this copy`, drift.line, drift.del, drift.add)}
            <div class="row-actions"><button type="button" class="btn btn-ink" data-act="replace">Replace with rev ${row.rev}</button><button type="button" class="btn" data-act="draft">Keep my edit as draft rev ${row.rev + 1}</button><button type="button" class="btn btn-ghost" data-act="close">Cancel</button></div>`, button);
          flyout.dataset.row = String(r); flyout.dataset.col = c.key;
          say(mount, 'That copy changed outside Kiln. Compare it first.');
          return;
        }
        if (state === 'found') {
          openFlyout(`<h3>${row.name} isn’t in your library</h3><p>Import it as a draft. The folder in <code>${path}</code> stays exactly where it is.</p>
            <div class="row-actions"><button type="button" class="btn btn-ink" data-act="import">Import as a draft</button><button type="button" class="btn btn-ghost" data-act="close">Not now</button></div>`, button);
          flyout.dataset.row = String(r); flyout.dataset.col = c.key;
          return;
        }
        if (row.rev === 0) { say(mount, `Import ${row.name} first, then install it anywhere.`); return; }
        row.cells[c.key] = state === 'on' ? 'off' : 'on';
        const first = row.pulse;
        row.pulse = false;
        paint();
        say(mount, state === 'on' ? `Removed ${row.name} from ${path}. It stays in your library.` : `Installed rev ${row.rev} of ${row.name} into ${path}. ${first ? `A new ${c.who} session picks it up.` : 'Receipt saved.'}`);
        refocus(mount, r, c.key);
        return;
      }
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act) {
        const r = Number(flyout.dataset.row), row = rows[r], key = flyout.dataset.col as Col, path = plain(columns.find(c => c.key === key)!.path);
        flyout.hidden = true;
        if (act === 'replace') { row.cells[key] = 'on'; say(mount, `Moved the changed copy to a private backup and installed rev ${row.rev} into ${path}.`); }
        if (act === 'draft') { row.cells[key] = 'on'; row.caption = `rev ${row.rev} approved, draft rev ${row.rev + 1} from the edit`; say(mount, `Saved the edit as draft rev ${row.rev + 1}. Rev ${row.rev} stays installed until you approve it.`); }
        if (act === 'import') { row.cells[key] = 'on'; row.rev = 1; row.caption = 'draft, imported just now'; say(mount, `Imported ${row.name} as a draft. The original stays in ${path}.`); }
        paint();
        refocus(mount, r, key); returnTo = null;
        if (act === 'close') say(mount, 'Nothing changed.');
        return;
      }
      if (target.closest('[data-cleanup]')) {
        cleaned = true; paint();
        root.querySelector('[data-cleanup-text]')!.textContent = 'Removed the broken link and the empty folder. Nothing else was touched.';
        say(mount, 'Cleaned up 1 broken link and 1 empty folder.');
      }
    });
    flyout.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeFlyout(); } });
  }
  root.querySelector('[data-see-all]')!.addEventListener('click', event => {
    event.preventDefault();
    const row = root.querySelector<HTMLElement>('[data-panel="library"] tr.is-fresh:last-child') ?? root.querySelector<HTMLElement>('[data-panel="library"]')!;
    row.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    restart(row, 'is-landed');
  });
  paint();
  const library = root.querySelector<HTMLElement>('[data-panel="library"]')!;
  const librarySlot = (slot: string) => library.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  const rowOf = (slot: string) => (slot.startsWith('cell:') || slot.startsWith('row:') ? slot.split(':')[1] : '');
  return {
    paint,
    slot: librarySlot,
    /** Empty the library panel again (after the tidy-up ran in reverse). */
    clear() {
      slots.clear(); rowsIn.clear(); cleaned = false;
      root.querySelector('[data-cleanup-text]')!.innerHTML = 'Found a broken link in <code>~/.agents/skills</code> and an empty skill folder in <code>~/.copilot/skills</code>.';
      paint();
    },
    unland(slot: string) {
      slots.delete(slot);
      librarySlot(slot)?.classList.remove('is-in', 'is-landed');
      const name = rowOf(slot);
      if (name && ![...slots].some(s => rowOf(s) === name)) { rowsIn.delete(name); library.querySelector(`tr[data-row="${name}"]`)?.classList.remove('is-in'); }
    },
    /** A flyer arrived: show its slot and flash it like a highlighter swipe. Duplicates bump the row they merged into. */
    land(slot: string) {
      slots.add(slot);
      const el = librarySlot(slot);
      if (!el) return;
      const name = rowOf(slot);
      if (name) { rowsIn.add(name); library.querySelector(`tr[data-row="${name}"]`)?.classList.add('is-in'); }
      el.classList.add('is-in');
      restart(el, 'is-landed');
      if (slot.startsWith('row:')) { restart(el.querySelector('b'), 'is-hit'); restart(el.querySelector('small'), 'is-bump'); }
      if (slot.startsWith('cell:')) restart(el.querySelector('.switch'), 'is-hit');
    },
    landAll() {
      targets.forEach(slot => slots.add(slot));
      rows.forEach(row => rowsIn.add(row.name));
      paint();
    },
    add(name: string, rev: number) {
      if (rows.some(row => row.name === name)) return;
      rows.push({ name, caption: `approved rev ${rev}, just now`, rev, cells: { ...off }, fresh: true, pulse: true });
      paint();
      mounts.forEach(mount => say(mount, `Approved rev ${rev} of ${name}. It isn’t installed anywhere yet: flip a switch for Claude Code, Codex, Copilot or my-game.`));
    },
  };
}
