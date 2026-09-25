import { Markdown } from './Markdown';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Command, Copy, Flame, Search, X } from 'lucide-react';
import type { Item, ItemDetail } from '../../../packages/protocol/schema';
import { api, variablesIn } from './api';
import { Badge, KindIcon } from './components';
import { VariablesDialog } from './dialogs';
export default function Palette() {
  const [query, setQuery] = useState(''), [items, setItems] = useState<Item[]>([]), [selected, setSelected] = useState(0), [error, setError] = useState('');
  const [variableItem, setVariableItem] = useState<ItemDetail | null>(null);
  const [preview, setPreview] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const focus = () => { input.current?.focus(); setQuery(''); }; window.addEventListener('focus', focus); input.current?.focus(); return () => window.removeEventListener('focus', focus); }, []);
  useEffect(() => { let active = true; setLoading(true); setError(''); const timer = setTimeout(() => void api<Item[]>('items.list', { query }).then(result => { if (active) { setItems(result.slice(0, 30)); setSelected(0); setLoading(false); } }).catch(e => { if (active) { setError(String(e)); setLoading(false); } }), 100); return () => { active = false; clearTimeout(timer); }; }, [query]);
  const copy = async (item: Item) => {
    try { const detail = await api<ItemDetail>('items.read', { id: item.id }); if (variablesIn(detail.revision.content).length) { setVariableItem(detail); return; } await api('desktop.copy', { id: item.id, revision: item.revision }); await api('desktop.hide'); } catch (e) { setError(String(e)); }
  };
  const item = items[selected];
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (item && !loading) void api<ItemDetail>('items.read', { id: item.id }).then(detail => { if (active) setPreview(detail); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [item?.id, loading]);
  useEffect(() => { document.getElementById(`result-${item?.id}`)?.scrollIntoView({ block: 'nearest' }); }, [item?.id]);
  const open = async () => { if (!item || loading) return; try { await api('desktop.workbench', { id: item.id }); } catch (error) { setError(String(error)); } };
  return <div className="palette" onKeyDown={e => {
    if (variableItem) return;
    if (e.key === 'Escape') void api('desktop.hide');
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => Math.max(0, Math.min(items.length - 1, i + 1))); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(i => Math.max(0, i - 1)); }
    if (e.key === 'Enter' && item && !loading && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); if (e.ctrlKey || e.metaKey) void open(); else void copy(item); }
  }}>
    <div className="palette-search"><Flame size={24} /><input ref={input} aria-label="Quick search" placeholder="Find a prompt, skill, or useful idea…" value={query} onChange={e => { setQuery(e.target.value); setLoading(true); }} role="combobox" aria-controls="palette-results" aria-expanded="true" aria-activedescendant={item && !loading ? `result-${item.id}` : undefined} /><button className="icon-button" aria-label="Close quick search" onClick={() => void api('desktop.hide')}><X size={18} /></button></div>
    <div className="palette-label">{loading ? 'SEARCHING…' : query ? 'SEARCH RESULTS' : 'YOUR LIBRARY'}</div>
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="palette-body"><div className="palette-results" role="listbox" id="palette-results" aria-busy={loading}>
      {!loading && items.map((item, i) => <button id={`result-${item.id}`} role="option" aria-selected={selected === i} key={item.id} className={selected === i ? 'active' : ''} onMouseEnter={() => setSelected(i)} onFocus={() => setSelected(i)} onClick={() => void copy(item)}><KindIcon kind={item.kind} /><span><b>{item.title}</b><small>{item.collection} · {item.tags.join(', ')}</small></span><Copy size={14} /></button>)}
      {!loading && !items.length && <p className="empty-inline">{query ? 'No matching items. Try another search.' : 'Your library is empty. Capture something in the workbench.'}</p>}
    </div><section className="palette-preview" aria-label="Search preview">{!loading && item ? <><h2>{item.title}</h2><Badge status={item.status} />{preview ? <Markdown>{preview.revision.content}</Markdown> : <p className="muted">Loading preview…</p>}</> : <p className="muted">Select a result to preview its content.</p>}</section></div>
    <div className="palette-footer"><span><kbd>Enter</kbd> copy · <kbd>Ctrl Enter</kbd> open</span><button className="button" disabled={!item || loading} onClick={() => void open()}>Open item <ArrowRight size={13} /></button><button className="text-button" onClick={() => void api('desktop.workbench')}>Open workbench</button></div>
    {variableItem && <VariablesDialog detail={variableItem} onClose={() => setVariableItem(null)} onDone={() => { setVariableItem(null); void api('desktop.hide'); }} />}
  </div>;
}
