import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Gauge, X } from 'lucide-react';
import type { Installation, Item, Snapshot } from '../../../packages/protocol/schema';
import type { ContextSkill, Harness, HarnessContext, SessionStart } from '../../../packages/home/session-start';
import { api } from './api';
import { InvocationToggle } from './Invocation';
import './session-start.css';

type Props = {
  snapshot: Snapshot; installations: Installation[];
  onOpenItem: (id: string) => void; onInvocation: (item: Item, model: boolean) => void;
};
const projectKey = 'kiln-session-project';
const short: Record<Harness, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' };
/** 12,400 as "12.4k"; small numbers as they are. */
export const compact = (n: number) => n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Folders compare by resolved path; Windows paths ignore case. */
const same = (path: string) => path.replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase();
/** A harness is shown when it is set up here or anything of it was found. */
const shown = (h: HarnessContext) => h.present || h.skills.rows.length > 0 || h.instructions.files.length > 0 || h.hooks.rows.length > 0 || h.mcp.rows.length > 0;

/**
 * "Session start" in the status bar: roughly what each harness hands the model when a new session starts here (skill
 * descriptions, instruction files), with what cannot be sized listed beside it (hooks, MCP servers, the system prompt). The
 * breakdown opens above it; skill rows open the item and carry the model-invocation switch, so turning one off shows the drop.
 * Asked again whenever the library or its installs change; the backend re-reads only files that changed.
 */
export function SessionStartStatus({ snapshot, installations, onOpenItem, onInvocation }: Props) {
  const [data, setData] = useState<SessionStart | null>(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Harness>('claude');
  const [project, setProject] = useState(() => localStorage.getItem(projectKey) ?? '');
  const box = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => void api<SessionStart>('context.sessionStart', project ? { project } : {}).then(result => { if (active) setData(result); })
      // A remembered project that has gone: fall back to personal files only.
      .catch(() => { if (active && project) { localStorage.removeItem(projectKey); setProject(''); } }), 300);
    return () => { active = false; clearTimeout(timer); };
  }, [snapshot, installations, project]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement)?.closest?.('select')) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true); };
  }, [open]);
  // Installed copies Kiln knows, by folder: a row found there opens its item and has its switch.
  const byFolder = useMemo(() => {
    const items = new Map(snapshot.items.filter(i => i.kind === 'skill' && !i.deletedAt).map(i => [i.id, i]));
    return new Map(installations.flatMap(copy => { const item = items.get(copy.itemId); return item ? [[same(copy.destination), item] as const] : []; }));
  }, [snapshot.items, installations]);
  const harnesses = data?.harnesses.filter(shown) ?? [];
  if (!data || !harnesses.length) return null;
  const current = harnesses.find(h => h.id === tab) ?? harnesses[0];
  const choose = (value: string) => {
    if (value === '?') { void api<string | null>('desktop.chooseDirectory').then(folder => { if (folder) { localStorage.setItem(projectKey, folder); setProject(folder); } }); return; }
    if (value) localStorage.setItem(projectKey, value); else localStorage.removeItem(projectKey);
    setProject(value);
  };
  const projects = [...new Set([...data.projects, ...(data.project ? [data.project] : [])])];
  const name = (folder: string) => folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;

  const skillRow = (row: ContextSkill) => {
    const item = byFolder.get(same(row.folder));
    return <li key={row.folder} className={`ctx-row ${row.listed ? '' : 'off'}`}>
      <span className="ctx-name">
        {item ? <button type="button" className="text-button" title="Open this skill" onClick={() => { setOpen(false); onOpenItem(item.id); }}>{row.name}</button> : <b title="Not in your library">{row.name}</b>}
        <small className="faint" title={row.folder}>{row.where}{row.scope === 'project' ? ' · project' : ''}{row.reason ? ` · ${row.reason}` : ''}</small>
      </span>
      {item ? <InvocationToggle compact item={item} listing={snapshot.invocation[item.id]} onToggle={onInvocation} /> : <span />}
      <span className="ctx-tokens">{row.tokens ? `≈ ${row.tokens.toLocaleString()}` : '—'}</span>
    </li>;
  };
  const listed = current.skills.rows.filter(r => r.listed).sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)), left = current.skills.rows.filter(r => !r.listed);

  return <><span className="status-divider" /><div className="status-context" ref={box}>
    <button type="button" ref={trigger} className={`status-item context ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}
      title="Estimated tokens each harness loads when a new session starts: skill descriptions and instruction files">
      <Gauge size={12} />Session start {harnesses.map(h => <span key={h.id} className="context-part"><span className="muted">{short[h.id]}</span> ≈ {compact(h.tokens)}</span>)}
    </button>
    {open && <div className="ctx-pop" role="dialog" aria-label="What loads at session start">
      <div className="ctx-head">
        <b>At session start</b>
        <select className="ctx-project" aria-label="Project" value={data.project ?? ''} onChange={event => choose(event.target.value)} title={data.project ?? 'Personal files only'}>
          <option value="">No project · personal files only</option>
          {projects.map(folder => <option key={folder} value={folder} title={folder}>{name(folder)}</option>)}
          <option value="?">Another folder…</option>
        </select>
        <button type="button" className="icon-button" aria-label="Close" onClick={() => setOpen(false)}><X size={14} /></button>
      </div>
      <div className="ctx-tabs" role="tablist" aria-label="Harness">{harnesses.map(h => <button key={h.id} type="button" role="tab" aria-selected={h.id === current.id} className={h.id === current.id ? 'on' : ''} onClick={() => setTab(h.id)}>{h.label}<span>≈ {compact(h.tokens)}</span></button>)}</div>
      <p className="ctx-summary">≈ <b>{current.tokens.toLocaleString()}</b> tokens Kiln can size: {current.skills.tokens.toLocaleString()} in skill descriptions, {current.instructions.tokens.toLocaleString()} in instruction files. Hooks, MCP servers and the system prompt add more.</p>

      <section className="ctx-section" aria-label="Skill descriptions">
        <h4>Skill descriptions <span>{plural(listed.length, 'skill')} · ≈ {current.skills.tokens.toLocaleString()}</span></h4>
        {listed.length ? <ul className="ctx-list">{listed.map(skillRow)}</ul> : <p className="ctx-note">None: no skill here lets the model invoke it.</p>}
        {left.length > 0 && <details className="ctx-left"><summary><ChevronRight size={12} />{left.length} not loaded</summary><ul className="ctx-list">{left.map(skillRow)}</ul></details>}
        <p className="ctx-note">{current.skills.budget}</p>
      </section>

      <section className="ctx-section" aria-label="Instruction files">
        <h4>Instruction files <span>{plural(current.instructions.files.length, 'file')} · ≈ {current.instructions.tokens.toLocaleString()}</span></h4>
        {current.instructions.files.length ? <ul className="ctx-list">{current.instructions.files.map(file => <li key={file.path} className="ctx-row">
          <span className="ctx-name"><b title={file.path}>{file.label}</b>{(file.note || file.truncated) && <small className="faint">{[file.note, file.truncated && 'cut at the limit'].filter(Boolean).join(' · ')}</small>}</span><span /><span className="ctx-tokens">≈ {file.tokens.toLocaleString()}</span>
        </li>)}</ul> : <p className="ctx-note">None found{data.project ? '' : ' in your home folder; choose a project to include its files'}.</p>}
      </section>

      <section className="ctx-section" aria-label="SessionStart hooks">
        <h4>SessionStart hooks <span>{current.hooks.rows.length}</span></h4>
        {current.hooks.rows.length > 0 && <ul className="ctx-list">{current.hooks.rows.map((hook, n) => <li key={n} className="ctx-row hook"><code title={hook.command}>{hook.command}</code><small className="faint">{hook.source}{hook.matcher ? ` · ${hook.matcher}` : ''}</small></li>)}</ul>}
        <p className="ctx-note">{current.hooks.rows.length ? 'Kiln never runs hooks, so their output is not counted. ' : ''}{current.hooks.limit}</p>
      </section>

      <section className="ctx-section" aria-label="MCP servers">
        <h4>MCP servers <span>{current.mcp.rows.length}</span></h4>
        {current.mcp.rows.length > 0 && <p className="ctx-servers">{current.mcp.rows.map(server => <code key={`${server.source}:${server.name}`} title={server.source}>{server.name}</code>)}</p>}
        <p className="ctx-note">{current.mcp.note}</p>
      </section>

      <ul className="ctx-unknown">{current.unknown.map(line => <li key={line}>{line}</li>)}<li>Estimates: characters ÷ {current.charsPerToken}.</li></ul>
    </div>}
  </div></>;
}
