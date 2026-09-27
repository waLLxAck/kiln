import { useState, type MouseEvent } from 'react';
import { ArrowRightLeft, Check, Copy, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react';
import { ContextMenu, type MenuEntry } from './components';
import { addHook, addRule, checkRule, columnLabel, columns, moveRule, removeHook, removeRule, updateHook, type Column, type HookInput, type HookRow } from './configModel';

/** A structured edit: turns the current JSON text into the next one. The parent applies it to the draft. */
export type Apply = (edit: (text: string) => string) => void;
const columnHint: Record<Column, string> = { allow: 'Runs without asking', ask: 'Asks every time', deny: 'Never allowed' };
const placeholder: Record<Column, string> = { allow: 'Add rule, e.g. Bash(npm run build:*)', ask: 'Add rule, e.g. Bash(git push:*)', deny: 'Add rule, e.g. Read(./.env)' };

/** permissions.allow / ask / deny as three columns of rule chips. */
export function PermissionsEditor({ rules, saved, other, apply }: { rules: Record<Column, string[]>; /** The rules on disk, to mark unsaved ones. */ saved: Record<Column, string[]> | null; other: string[]; apply: Apply }) {
  const [adding, setAdding] = useState<Record<Column, string>>({ allow: '', ask: '', deny: '' });
  const [problem, setProblem] = useState<Partial<Record<Column, string>>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; column: Column; rule: string } | null>(null);
  const add = (column: Column) => {
    const rule = adding[column].trim();
    if (!rule) return;
    const issue = checkRule(rule, rules);
    if (issue) { setProblem({ ...problem, [column]: issue }); return; }
    apply(text => addRule(text, column, rule)); setAdding({ ...adding, [column]: '' }); setProblem({ ...problem, [column]: undefined });
  };
  const open = (event: MouseEvent<HTMLButtonElement>, column: Column, rule: string) => {
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ x: event.type === 'contextmenu' ? event.clientX : box.right - 220, y: event.type === 'contextmenu' ? event.clientY : box.bottom + 4, column, rule });
  };
  const entries = (column: Column, rule: string): MenuEntry[] => [
    ...columns.filter(c => c !== column).map(to => ({ label: `Move to ${columnLabel[to]}`, icon: <ArrowRightLeft size={14} />, onSelect: () => apply(text => moveRule(text, column, to, rule)) })),
    { label: 'Copy rule', icon: <Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(rule).catch(() => undefined) },
    'separator',
    { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: () => apply(text => removeRule(text, column, rule)) },
  ];
  return <div className="cfg-permissions">
    <div className="cfg-columns">
      {columns.map(column => <section key={column} className={`cfg-col ${column}`} aria-label={`${columnLabel[column]} rules`}>
        <div className="cfg-colhead"><span className="cfg-coldot" aria-hidden="true" /><b>{columnLabel[column]}</b><span className="cfg-colcount">{rules[column].length}</span><span className="muted">{columnHint[column]}</span></div>
        <div className="cfg-rules">
          {rules[column].map(rule => { const fresh = saved !== null && !saved[column].includes(rule); return <button key={rule} className={`cfg-rule ${fresh ? 'new' : ''} ${menu?.rule === rule && menu.column === column ? 'open' : ''}`} title={fresh ? 'Not saved yet' : undefined} aria-haspopup="menu" aria-label={`${rule}, ${columnLabel[column]} rule`} onClick={event => open(event, column, rule)} onContextMenu={event => open(event, column, rule)}>
            <code>{rule}</code><MoreHorizontal size={13} aria-hidden="true" />
          </button>; })}
          {!rules[column].length && <div className="cfg-emptycol">No rules</div>}
        </div>
        <form className="cfg-add" onSubmit={event => { event.preventDefault(); add(column); }}>
          <Plus size={13} aria-hidden="true" /><input aria-label={`Add ${columnLabel[column]} rule`} spellCheck={false} value={adding[column]} placeholder={placeholder[column]} onChange={event => { setAdding({ ...adding, [column]: event.target.value }); setProblem({ ...problem, [column]: undefined }); }} />
          {adding[column].trim() && <button className="text-button" type="submit">Add</button>}
        </form>
        {problem[column] && <div className="cfg-adderror" role="alert">{problem[column]}</div>}
      </section>)}
    </div>
    <p className="cfg-note muted small">Deny wins over Ask, and Ask over Allow. Rules are checked for format only; Kiln does not work out what a session will actually allow.{other.length > 0 && <> Other permission settings ({other.join(', ')}) are kept; edit them in Raw.</>}</p>
    {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries(menu.column, menu.rule)} onClose={() => setMenu(null)} />}
  </div>;
}

const events = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionStart', 'SessionEnd'];
const blank: HookInput = { event: 'PreToolUse', matcher: '', command: '' };

/** The `hooks` object as one row per command: event, matcher, command. */
export function HooksEditor({ rows, apply }: { rows: HookRow[]; apply: Apply }) {
  const [editing, setEditing] = useState<{ row: HookRow; value: HookInput } | null>(null);
  const [draft, setDraft] = useState<HookInput>(blank);
  const same = (a: HookRow, b: HookRow) => a.event === b.event && a.group === b.group && a.index === b.index;
  const commit = () => { if (!editing || !editing.value.command.trim() || !editing.value.event.trim()) return; const { row, value } = editing; apply(text => updateHook(text, row, { event: value.event.trim(), matcher: value.matcher.trim(), command: value.command.trim() })); setEditing(null); };
  const create = () => { if (!draft.command.trim() || !draft.event.trim()) return; apply(text => addHook(text, { event: draft.event.trim(), matcher: draft.matcher.trim(), command: draft.command.trim() })); setDraft({ ...blank, event: draft.event }); };
  const fields = (value: HookInput, set: (value: HookInput) => void, submit: () => void, label: string) => <>
    <td><input list="cfg-hook-events" aria-label={`${label} event`} value={value.event} onChange={event => set({ ...value, event: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') submit(); }} /></td>
    <td><input aria-label={`${label} matcher`} spellCheck={false} placeholder="Bash, Edit|Write, or empty for all" value={value.matcher} onChange={event => set({ ...value, matcher: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') submit(); }} /></td>
    <td><input aria-label={`${label} command`} spellCheck={false} placeholder="Command to run, e.g. ./scripts/check.sh" value={value.command} onChange={event => set({ ...value, command: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') submit(); if (event.key === 'Escape' && editing) { event.stopPropagation(); setEditing(null); } }} /></td>
  </>;
  return <div className="cfg-hooks">
    <datalist id="cfg-hook-events">{events.map(event => <option key={event} value={event} />)}</datalist>
    <table>
      <thead><tr><th>Event</th><th>Matcher</th><th>Command</th><th aria-label="Actions" /></tr></thead>
      <tbody>
        {rows.map(row => editing && same(editing.row, row)
          ? <tr key={`${row.event}-${row.group}-${row.index}`} className="cfg-hookedit">{fields(editing.value, value => setEditing({ row, value }), commit, 'Edited hook')}<td><button className="icon-button" aria-label="Keep hook changes" onClick={commit}><Check size={14} /></button><button className="icon-button" aria-label="Cancel editing" onClick={() => setEditing(null)}><X size={14} /></button></td></tr>
          : <tr key={`${row.event}-${row.group}-${row.index}`}>
            <td><span className="cfg-event">{row.event}</span></td>
            <td>{row.matcher ? <code>{row.matcher}</code> : <span className="muted small">all</span>}</td>
            <td>{row.type !== 'command' && <span className="cfg-hooktype">{row.type}</span>}<code>{row.command}</code></td>
            <td><button className="icon-button" aria-label={`Edit ${row.event} hook`} onClick={() => setEditing({ row, value: { event: row.event, matcher: row.matcher, command: row.command } })}><Pencil size={14} /></button><button className="icon-button" aria-label={`Delete ${row.event} hook`} onClick={() => apply(text => removeHook(text, row))}><Trash2 size={14} /></button></td>
          </tr>)}
        {!rows.length && <tr><td colSpan={4} className="cfg-hooksnone muted small">No hooks yet.</td></tr>}
        <tr className="cfg-hookadd">{fields(draft, setDraft, create, 'New hook')}<td><button className="button" disabled={!draft.command.trim() || !draft.event.trim()} onClick={create}><Plus size={14} />Add</button></td></tr>
      </tbody>
    </table>
    <p className="cfg-note muted small">Claude Code runs these commands during a session; Kiln only edits them and never runs a hook.</p>
  </div>;
}
