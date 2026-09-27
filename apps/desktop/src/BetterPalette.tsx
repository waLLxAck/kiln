import { Markdown } from './Markdown';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Command, Copy, Flame, X } from 'lucide-react';
import type { Item, ItemDetail } from '../../../packages/protocol/schema';
import { api, variablesIn } from './api';
import { Badge, KindIcon } from './components';
import { VariablesDialog } from './dialogs';
import type { SearchResults } from './library-search';
import { matchCommands, paletteCommands } from './palette-commands';

type Row = { kind: 'item'; item: Item } | { kind: 'command'; command: typeof paletteCommands[number] };
const LIMIT = 30;
const rowId = (row: Row) => row.kind === 'item' ? `result-${row.item.id}` : `command-${row.command.id}`;

/**
 * Quick search with the betterSearch experiment: ranked results that stay on screen while the next ones load, Enter that is never
 * lost while a search is in flight, a short "Copied" confirmation, and commands (type ">" for all of them).
 */
export function BetterPalette() {
  const [query, setQuery] = useState(''), [results, setResults] = useState<SearchResults | null>(null), [selected, setSelected] = useState(0), [error, setError] = useState('');
  const [variableItem, setVariableItem] = useState<ItemDetail | null>(null);
  const [preview, setPreview] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  /** Enter pressed while a search was in flight: acts on the top result once it arrives. */
  const [pendingEnter, setPendingEnter] = useState<{ open: boolean } | null>(null);
  /** Bumped when the window is shown again, so a remembered query is searched afresh. */
  const [generation, setGeneration] = useState(0);
  const input = useRef<HTMLInputElement>(null), acting = useRef(false), hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    // The last query stays, selected, so typing replaces it and Enter copies the same thing again.
    const focus = () => { clearTimeout(hideTimer.current); setCopied(null); acting.current = false; input.current?.focus(); input.current?.select(); setGeneration(g => g + 1); };
    window.addEventListener('focus', focus); input.current?.focus();
    return () => { window.removeEventListener('focus', focus); clearTimeout(hideTimer.current); };
  }, []);
  const commandMode = query.startsWith('>');
  useEffect(() => {
    if (commandMode) { setLoading(false); setSelected(0); return; }
    let active = true; setLoading(true); setError('');
    const timer = setTimeout(() => void api<SearchResults>('items.search', { query, limit: LIMIT }).then(result => { if (active) { setResults(result); setSelected(0); setLoading(false); } }).catch(e => { if (active) { setError(String(e)); setLoading(false); } }), 100);
    return () => { active = false; clearTimeout(timer); };
  }, [query, generation]);
  const items = commandMode ? [] : results?.items ?? [];
  const commands = commandMode ? matchCommands(query.slice(1)) : query.trim() ? matchCommands(query).slice(0, 3) : [];
  const rows: Row[] = [...items.map(item => ({ kind: 'item' as const, item })), ...commands.map(command => ({ kind: 'command' as const, command }))];
  const row = rows[Math.min(selected, rows.length - 1)];
  const item = row?.kind === 'item' ? row.item : undefined;

  const confirm = (title: string) => { setCopied(title); clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => { acting.current = false; setCopied(null); void api('desktop.hide'); }, 600); };
  const copy = async (item: Item) => {
    // A source is material to read, not to paste: Enter opens it instead.
    if (item.kind === 'source') { await api('desktop.workbench', { id: item.id }); return; }
    const detail = await api<ItemDetail>('items.read', { id: item.id });
    if (variablesIn(detail.revision.content).length) { setVariableItem(detail); return; }
    await api('desktop.copy', { id: item.id, revision: item.revision }); confirm(item.title); return true;
  };
  const act = async (target: Row | undefined, open: boolean) => {
    if (!target || acting.current) return;
    acting.current = true; let confirming = false;
    try {
      if (target.kind === 'command') await api('desktop.workbench', { command: target.command.id });
      else if (open) await api('desktop.workbench', { id: target.item.id });
      else confirming = Boolean(await copy(target.item));
    } catch (e) { setError(String(e)); } finally { if (!confirming) acting.current = false; }
  };
  useEffect(() => { if (loading || !pendingEnter) return; setPendingEnter(null); void act(rows[0], pendingEnter.open); }, [loading, pendingEnter]);

  // Holding an arrow key moves through many rows; only the row it stops on is read for the preview.
  useEffect(() => {
    if (!item || (preview?.item.id === item.id && preview.item.revision === item.revision)) return;
    let active = true;
    const timer = setTimeout(() => void api<ItemDetail>('items.read', { id: item.id }).then(detail => { if (active) setPreview(detail); }).catch(error => { if (active) setError(String(error)); }), 120);
    return () => { active = false; clearTimeout(timer); };
  }, [item?.id, item?.revision]);
  useEffect(() => { if (row) document.getElementById(rowId(row))?.scrollIntoView({ block: 'nearest' }); }, [row && rowId(row)]);

  const capped = !commandMode && results && results.total > results.items.length;
  const label = loading ? 'SEARCHING…' : commandMode ? 'COMMANDS' : results?.close ? 'NO EXACT MATCHES — SHOWING CLOSE MATCHES' : query.trim() ? 'SEARCH RESULTS' : 'YOUR LIBRARY';
  const option = (r: Row, i: number, content: React.ReactNode) => <button id={rowId(r)} role="option" aria-selected={row === r} key={rowId(r)} className={row === r ? 'active' : ''} onMouseEnter={() => setSelected(i)} onFocus={() => setSelected(i)} onClick={() => void act(r, false)}>{content}</button>;
  return <div className="palette better-palette" onKeyDown={e => {
    if (variableItem) return;
    if (e.key === 'Escape') { clearTimeout(hideTimer.current); void api('desktop.hide'); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.max(0, Math.min(rows.length - 1, i + 1))); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(0, i - 1)); }
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); const open = e.ctrlKey || e.metaKey; if (loading) setPendingEnter({ open }); else void act(row, open); }
  }}>
    <div className="palette-search"><Flame size={24} /><input ref={input} aria-label="Quick search" placeholder="Find a prompt, skill, or useful idea… (> for commands)" value={query} onChange={e => { setQuery(e.target.value); if (!e.target.value.startsWith('>')) setLoading(true); }} role="combobox" aria-controls="palette-results" aria-expanded="true" aria-activedescendant={row ? rowId(row) : undefined} /><button className="icon-button" aria-label="Close quick search" onClick={() => void api('desktop.hide')}><X size={18} /></button></div>
    <div className="palette-label"><span>{label}</span>{capped && <span className="palette-capped">Showing {results.items.length} of {results.total} — keep typing to narrow</span>}</div>
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="palette-body"><div className="palette-results" role="listbox" id="palette-results" aria-busy={loading}>
      {items.map((item, i) => option(rows[i], i, <><KindIcon kind={item.kind} /><span><b>{item.title}</b><small>{[item.collection, item.tags.join(', ')].filter(Boolean).join(' · ')}</small></span><Copy size={14} /></>))}
      {commands.length > 0 && !commandMode && items.length > 0 && <div className="palette-group" role="presentation">Commands</div>}
      {commands.map((command, n) => option(rows[items.length + n], items.length + n, <><Command size={16} /><span><b>{command.title}</b><small>{command.hint}</small></span><ArrowRight size={14} /></>))}
      {!loading && !rows.length && <p className="empty-inline">{commandMode ? 'No matching commands.' : query ? 'No matching items. Try another search.' : 'Your library is empty. Capture something in the workbench.'}</p>}
    </div><section className="palette-preview" aria-label="Search preview">{row?.kind === 'command' ? <><h2>{row.command.title}</h2><p className="muted">{row.command.hint}. Press Enter to open Kiln and do it.</p></> : item ? <><h2>{item.title}</h2><Badge status={item.status} />{preview?.item.id === item.id ? <Markdown>{preview.revision.content}</Markdown> : <p className="muted">Loading preview…</p>}</> : <p className="muted">Select a result to preview its content.</p>}</section></div>
    <div className="palette-footer"><span><kbd>Enter</kbd> copy · <kbd>Ctrl Enter</kbd> open · <kbd>&gt;</kbd> commands</span><button className="button" disabled={!item} onClick={() => void act(row, true)}>Open item <ArrowRight size={13} /></button><button className="text-button" onClick={() => void api('desktop.workbench')}>Open workbench</button></div>
    {copied !== null && <div className="palette-copied" role="status"><Check size={18} />Copied <b>{copied}</b></div>}
    {variableItem && <VariablesDialog detail={variableItem} onClose={() => setVariableItem(null)} onDone={() => { const title = variableItem.item.title; setVariableItem(null); acting.current = true; confirm(title); }} />}
  </div>;
}
