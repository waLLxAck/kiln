import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AtSign, Check, ChevronDown, Download, ListChecks, Loader2, MessageSquare, MoreHorizontal, Plus, RotateCcw, ScrollText, Send, Sparkles, SquarePen, Undo2, X } from 'lucide-react';
import type { AgentJob, ChatChange, ChatResult } from '../../../packages/agent/service';
import type { Item, ItemDetail, RunProviderId } from '../../../packages/protocol/schema';
import { api, shortHash } from './api';
import { KindIcon, providerName } from './components';
import { ChatActivity, ChatRunMeta } from './AgentPanel';
import { LineDiff } from './Diff';
import './chat.css';

/** Chat turns about one item, oldest first. Turns from the older per-video conversation belong to the same thread. */
export const itemTurns = (jobs: AgentJob[], itemId: string) => jobs.filter(job => job.kind === 'chat' && job.itemId === itemId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

const providers: RunProviderId[] = ['claude', 'codex'];
/** What the user did with each change card, by `jobId:itemId`. Kept on this machine so a reopened chat does not ask again. */
type Decision = { state: 'kept' } | { state: 'undone'; revision: string };
const DECISIONS = 'kiln-chat-decisions';
const readDecisions = (): Record<string, Decision> => { try { return JSON.parse(localStorage.getItem(DECISIONS) ?? '{}'); } catch { return {}; } };

/**
 * The assistant, docked beside the item that is open. For a source, or an entry made from one, the agent also gets the source material (a video's
 * transcript) and the other entries; otherwise it gets the item alone, plus any items mentioned with @. The agent edits through Kiln's CLI, so each
 * reply lists the items that changed while it ran, with Keep and Undo. Stays open while browsing; Esc closes it.
 */
export function ChatPopover({ jobs, item, source, provider, onClose, onOpenItem, items, onRefresh }: { jobs: AgentJob[]; item: Item; /** The source behind the open item, when there is one. */ source: Item | null; provider: RunProviderId; onClose: () => void; onOpenItem: (id: string) => void; /** Library items, for @-mentions, item links and the entry count. */ items?: Item[]; /** Reloads the library after an Undo. */ onRefresh?: () => unknown }) {
  const video = source?.tags.includes('youtube') ? source : null;
  const conversation = useRef({ itemId: item.id, id: crypto.randomUUID() });
  const [, redraw] = useState(0);
  const [chosen, setChosen] = useState<RunProviderId | null>(null);
  const [mentions, setMentions] = useState<Item[]>([]);
  const [text, setText] = useState('');
  if (conversation.current.itemId !== item.id) conversation.current = { itemId: item.id, id: crypto.randomUUID() };
  const [error, setError] = useState('');
  const [sending, setSending] = useState<{ itemId: string; message: string } | null>(null);
  const [accepted, setAccepted] = useState<AgentJob | null>(null);
  const [menu, setMenu] = useState<'provider' | 'more' | 'context' | 'mention' | null>(null);
  const body = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const mentionKeys = useRef<((event: ReactKeyboardEvent) => void) | null>(null);
  const turns = itemTurns(accepted && !jobs.some(job => job.id === accepted.id) ? [...jobs, accepted] : jobs, item.id).filter(j => j.conversationId === conversation.current.id);
  const running = turns.find(turn => turn.status === 'running'), busy = sending?.itemId === item.id || Boolean(running);
  // A session stays on the CLI it started with; before the first turn the choice (or Settings) decides.
  const current: RunProviderId = turns.at(-1)?.provider ?? chosen ?? provider, who = providerName[current];
  const last = turns.at(-1);
  const reset = () => { conversation.current = { itemId: item.id, id: crypto.randomUUID() }; setAccepted(null); setError(''); setText(''); setMentions([]); setMenu(null); redraw(n => n + 1); };
  // Esc closes an open chat menu first, then the chat.
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key !== 'Escape' || document.querySelector('dialog[open], .context-menu')) return; event.stopPropagation(); if (document.querySelector('.chat-menu')) setMenu(null); else onClose(); }; window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true); }, [onClose]);
  const lastKey = last ? `${last.id}:${last.status}:${last.phase}:${last.steps.at(-1)?.text}` : '';
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }); }, [lastKey, item.id]);
  useEffect(() => { setError(''); setText(''); setMentions([]); setMenu(null); }, [item.id]);
  useEffect(() => { if (!menu) return; const close = (event: MouseEvent) => { if (!(event.target as Element).closest('.chat-menu, .chat-menu-anchor')) setMenu(null); }; window.addEventListener('mousedown', close); return () => window.removeEventListener('mousedown', close); }, [menu]);

  const byId = useMemo(() => new Map((items ?? []).map(i => [i.id, i])), [items]);
  const entries = source && items ? items.filter(i => i.origin?.itemId === source.id && !i.deletedAt).length : 0;
  const send = async () => {
    const message = text.trim(); if (!message || busy) return;
    setError(''); setSending({ itemId: item.id, message }); setMenu(null);
    try {
      setAccepted(await api<AgentJob>('agent.chat', { message, itemId: item.id, conversationId: conversation.current.id, provider: current, contextItemIds: mentions.map(m => m.id) }));
      setText(''); setMentions([]);
    } catch (e) { setError(String(e)); }
    finally { setSending(null); }
  };
  const pick = (picked: Item) => {
    setMentions(all => all.some(m => m.id === picked.id) ? all : [...all, picked]);
    // Typed "@query" becomes the chip.
    if (menu === 'mention') setText(value => { const caret = input.current?.selectionStart ?? value.length; const before = value.slice(0, caret).replace(/(^|\s)@[^\s@]*$/, '$1'); return before + value.slice(caret); });
    setMenu(null); input.current?.focus();
  };
  const mentionQuery = menu === 'mention' ? (/(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, input.current?.selectionStart ?? text.length))?.[1] ?? '') : '';

  return <aside className="chat-popover chat-dock" aria-label="Ask the agent">
    <header className="chat-head">
      <div className="chat-menu-anchor">
        <button type="button" className="chat-provider" aria-haspopup="menu" aria-expanded={menu === 'provider'} disabled={busy} title="Which CLI answers in this chat" onClick={() => setMenu(menu === 'provider' ? null : 'provider')}><Sparkles size={15} />Ask {who}<ChevronDown size={14} /></button>
        {menu === 'provider' && <div className="chat-menu" role="menu">
          {providers.map(id => <button key={id} type="button" role="menuitemradio" aria-checked={id === current} onClick={() => { if (id !== current) { if (turns.length) reset(); setChosen(id); } setMenu(null); }}>{providerName[id]}{id === provider && <span className="muted small">default</span>}{id === current && <Check size={14} />}</button>)}
          <p className="chat-menu-note">{turns.length ? 'Switching starts a new session.' : 'For this chat only. The default is in Settings.'}</p>
        </div>}
      </div>
      <span className="chat-grow" />
      <button type="button" className="chat-headbutton" disabled={busy} onClick={reset}><SquarePen size={14} />New session</button>
      <div className="chat-menu-anchor">
        <button type="button" className="icon-button" aria-label="More chat actions" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')}><MoreHorizontal size={17} /></button>
        {menu === 'more' && <div className="chat-menu right" role="menu">
          <button type="button" role="menuitem" disabled={!last || busy} title={!last ? 'Nothing to export yet' : busy ? 'Wait for the reply to finish' : undefined} onClick={() => { setMenu(null); if (last) void api('desktop.exportSession', { id: last.id }).catch(e => setError(String(e))); }}><span className="inline"><Download size={14} />Export conversation…</span></button>
        </div>}
      </div>
      <button type="button" className="icon-button" aria-label="Close chat" title="Close (Esc)" onClick={onClose}><X size={16} /></button>
    </header>

    <div className="chat-context" aria-label="Context for the agent">
      <span className="chat-chip" title="The open item, as it is when you send"><KindIcon kind={item.kind} size={13} /><span className="chat-chip-label">{item.title}</span><code>{shortHash(item.revision)}</code></span>
      {source && (video || source.id !== item.id) && (source.id === item.id
        ? <span className="chat-chip" title="The video’s transcript is attached"><ScrollText size={13} /><span className="chat-chip-label">Video transcript</span></span>
        : <button type="button" className="chat-chip" title={`Made from “${source.title}”. Open it`} onClick={() => onOpenItem(source.id)}><ScrollText size={13} /><span className="chat-chip-label">{video ? 'Video transcript' : 'Source material'}</span></button>)}
      {entries > 0 && <span className="chat-chip" title={`Every entry made from “${source!.title}” is listed for the agent`}><ListChecks size={13} /><span className="chat-chip-label">{entries} entr{entries === 1 ? 'y' : 'ies'} from this {video ? 'video' : 'source'}</span></span>}
      {mentions.map(m => <span key={m.id} className="chat-chip added" title="Its current content goes with your next message"><KindIcon kind={m.kind} size={13} /><span className="chat-chip-label">{m.title}</span><button type="button" aria-label={`Remove ${m.title}`} onClick={() => setMentions(all => all.filter(x => x.id !== m.id))}><X size={12} /></button></span>)}
      {items && <div className="chat-menu-anchor">
        <button type="button" className="chat-addchip" aria-haspopup="listbox" aria-expanded={menu === 'context'} onClick={() => setMenu(menu === 'context' ? null : 'context')}><Plus size={13} />Add context</button>
        {menu === 'context' && <MentionPicker items={items} exclude={[item.id, ...mentions.map(m => m.id)]} onPick={pick} onClose={() => setMenu(null)} keys={mentionKeys} />}
      </div>}
    </div>

    <div className="chat-body" ref={body}>
      {!turns.length && !sending && <div className="chat-empty">
        <MessageSquare size={20} />
        <p>{source ? `Ask about the ${video ? 'video' : 'source'} or this entry, or ask for a change. The agent has the ${video ? 'transcript' : 'source material'}, this item and every entry made from the ${video ? 'video' : 'source'}.` : 'Ask about this item, or ask for a change. The agent reads it and its attached files.'} It edits through Kiln’s CLI, so every change is a new revision you can undo. It runs through your installed CLI with the permissions explained before each interaction.</p>
        <div className="chat-suggest">{(video ? ['Which prompt did they use for the outline step?', 'Make this technique more detailed', 'Add an entry for the tool mentioned at 12:30'] : source ? ['What did the analysis leave out?', 'Make this technique more detailed', 'Add a prompt for the review step it describes'] : ['Make this prompt more specific', 'Summarise this in three bullets', 'Turn the steps into a checklist']).map(suggestion => <button key={suggestion} type="button" onClick={() => { setText(suggestion); input.current?.focus(); }}>{suggestion}</button>)}</div>
      </div>}
      {turns.length > 0 && <ol className="chat-turns">{turns.map(turn => <Turn key={turn.id} turn={turn} byId={byId} onOpenItem={onOpenItem} onRefresh={onRefresh} onError={setError} />)}</ol>}
      {sending?.itemId === item.id && <div role="status" className="chat-you pending"><p>{sending.message}</p><span>Sending to {who}…</span></div>}
    </div>

    <form className="chat-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
      {menu === 'mention' && items && <MentionPicker items={items} exclude={[item.id, ...mentions.map(m => m.id)]} query={mentionQuery} onPick={pick} onClose={() => setMenu(null)} keys={mentionKeys} above />}
      <textarea ref={input} rows={3} value={text} aria-label="Your message" placeholder="Ask about this item, or ask for a change…"
        onChange={event => { const value = event.target.value; setText(value); if (items) { const typing = /(?:^|\s)@[^\s@]*$/.test(value.slice(0, event.target.selectionStart)); if (typing && menu !== 'mention') setMenu('mention'); else if (!typing && menu === 'mention') setMenu(null); } }}
        onKeyDown={event => { if (menu === 'mention' && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) { mentionKeys.current?.(event); return; } if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }} />
      {error && <p role="alert" className="error-box">{error}</p>}
      <div className="chat-compose-bar">
        {items && <button type="button" className="icon-button chat-menu-anchor" aria-label="Add an item as context" title="Add an item as context (@)" onClick={() => setMenu(menu === 'context' ? null : 'context')}><AtSign size={16} /></button>}
        <span className="chat-hint">Ctrl+Enter sends. Switching items starts a new session. Conversations stay private on this machine.</span>
        {running
          ? <button type="button" className="button" onClick={() => void api('agent.cancel', { id: running.id }).catch(e => setError(String(e)))}><Loader2 size={14} className="spin" />Cancel</button>
          : <button className="button primary" type="submit" disabled={busy || !text.trim()}>{sending ? <><Loader2 size={14} className="spin" />Sending…</> : <><Send size={14} />Send</>}</button>}
      </div>
    </form>
  </aside>;
}

/** Library search for items to add as context: typed in its own box (Add context) or after @ in the message, whose keys arrive through `keys`. */
function MentionPicker({ items, exclude, query, onPick, onClose, keys: forwarded, above = false }: { items: Item[]; exclude: string[]; query?: string; onPick: (item: Item) => void; onClose: () => void; keys: MutableRefObject<((event: ReactKeyboardEvent) => void) | null>; above?: boolean }) {
  const [own, setOwn] = useState('');
  const [active, setActive] = useState(0);
  const needle = (query ?? own).trim().toLowerCase();
  const matches = useMemo(() => items.filter(i => !i.deletedAt && !exclude.includes(i.id) && (!needle || i.title.toLowerCase().includes(needle) || i.collection.toLowerCase().includes(needle))).slice(0, 7), [items, exclude, needle]);
  useEffect(() => setActive(0), [needle]);
  const keys = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(n => Math.min(n + 1, matches.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(n => Math.max(n - 1, 0)); }
    else if ((event.key === 'Enter' || event.key === 'Tab') && matches[active]) { event.preventDefault(); onPick(matches[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  forwarded.current = keys;
  useEffect(() => () => { forwarded.current = null; }, [forwarded]);
  return <div className={`chat-menu chat-mention ${above ? 'above' : ''}`}>
    {query === undefined && <input autoFocus value={own} onChange={event => setOwn(event.target.value)} onKeyDown={keys} placeholder="Search your library…" aria-label="Search items to add" />}
    <div role="listbox" aria-label="Items to add as context">
      {matches.map((match, index) => <button key={match.id} type="button" role="option" aria-selected={index === active} className={index === active ? 'active' : ''} onMouseEnter={() => setActive(index)} onClick={() => onPick(match)}><KindIcon kind={match.kind} size={14} /><span className="chat-chip-label">{match.title}</span><span className="muted small">{match.collection}</span></button>)}
    </div>
    {!matches.length && <p className="chat-menu-note">No matching items</p>}
    {matches.length > 0 && <p className="chat-menu-note">Its current content goes with your next message.</p>}
  </div>;
}

function Turn({ turn, byId, onOpenItem, onRefresh, onError }: { turn: AgentJob; byId: Map<string, Item>; onOpenItem: (id: string) => void; onRefresh?: () => unknown; onError: (message: string) => void }) {
  const changed = (turn.changes ?? []).filter(c => c.from), created = (turn.changes ?? []).filter(c => !c.from);
  return <li>
    <div className="chat-you"><p>{turn.question}</p>
      {turn.contextItems?.length ? <div className="chat-you-context">{turn.contextItems.map(c => <button key={c.itemId} type="button" className="chat-item-link" onClick={() => onOpenItem(c.itemId)}>@{c.title}</button>)}</div> : null}
    </div>
    <div className="chat-agent">
      <div className="chat-agent-name"><Sparkles size={13} />{providerName[turn.provider]}</div>
      {turn.error && <p className="error-box">{turn.status === 'cancelled' ? 'Cancelled.' : turn.error}</p>}
      {turn.result && 'reply' in turn.result && <Reply text={(turn.result as ChatResult).reply} byId={byId} onOpenItem={onOpenItem} />}
      {changed.map(change => <ChangeCard key={change.itemId} jobId={turn.id} change={change} current={byId.get(change.itemId)} onOpenItem={onOpenItem} onRefresh={onRefresh} />)}
      {created.length > 0 && <div className="chat-created"><b>Added by the agent</b>{created.map(c => <div key={c.itemId}><KindIcon kind={c.kind} size={14} /><span className="chat-chip-label">{byId.get(c.itemId)?.title ?? c.title}</span><code>{shortHash(c.to)}</code><button type="button" className="button chat-sm" onClick={() => onOpenItem(c.itemId)}>Open</button></div>)}</div>}
      <ChatActivity job={turn} />
      <ChatRunMeta job={turn} onError={onError} />
    </div>
  </li>;
}

/** A bare file path, outside code and links, becomes inline code so it renders as a path chip. */
const barePath = /(?<![\w`/:.(\-[])((?:[\w.-]+\/)+[\w.-]+\.\w{1,6}|[\w-]+\.(?:tsx?|jsx?|mdx?|json|ya?ml|toml|py|rs|go|css|html|sh|ps1|cjs|mjs|txt))(?![\w`\]/])/g;
const isPath = (text: string) => !/\s/.test(text) && !/^[a-z]+:/i.test(text) && !/^[\d.]+$/.test(text) && (text.includes('/') || /\.[a-z]\w{0,5}$/i.test(text));
const itemId = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
/**
 * The reply as Markdown. Item ids and “quoted titles” of library items become links that open the item; file paths become path chips.
 * Only text outside code spans and fences is rewritten.
 */
function Reply({ text, byId, onOpenItem }: { text: string; byId: Map<string, Item>; onOpenItem: (id: string) => void }) {
  const [error, setError] = useState('');
  const source = useMemo(() => {
    const byTitle = new Map([...byId.values()].filter(i => !i.deletedAt).map(i => [i.title, i.id]));
    return text.split(/(`+[^`]*`+)/).map((part, index) => index % 2 ? part : part
      .replace(itemId, id => byId.has(id) ? `[${byId.get(id)!.title.replace(/[[\]]/g, '')}](kiln-item:${id})` : id)
      .replace(/“([^”\n]{2,160})”/g, (quote, title: string) => byTitle.has(title) ? `[${title.replace(/[[\]]/g, '')}](kiln-item:${byTitle.get(title)})` : quote)
      .replace(barePath, '`$1`')).join('');
  }, [text, byId]);
  return <div className="markdown-content chat-reply-text"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={url => url.startsWith('kiln-item:') ? url : defaultUrlTransform(url)} components={{
    a: ({ href, children }) => href?.startsWith('kiln-item:') ? <button type="button" className="chat-item-link" title="Open this item" onClick={() => onOpenItem(href.slice('kiln-item:'.length))}>{children}</button>
      : /^https?:\/\//i.test(href ?? '') ? <a href={href} onClick={event => { event.preventDefault(); setError(''); void api('desktop.openContentUrl', { url: href }).catch(e => setError(String(e))); }}>{children}</a>
      : <span>{children}</span>,
    code: ({ className, children }) => <code className={className ?? (isPath(String(children)) ? 'chat-path' : undefined)}>{children}</code>,
    img: ({ alt }) => <span className="muted">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
  }}>{source}</ReactMarkdown>{error && <p role="alert" className="error-box">{error}</p>}</div>;
}

/**
 * One item the agent changed during a reply: old → new revision with a line diff, then Keep (dismiss) or Undo (restore the previous
 * revision as a new draft, as History does). Undo expects the agent's revision, so a later edit is never overwritten silently.
 */
function ChangeCard({ jobId, change, current, onOpenItem, onRefresh }: { jobId: string; change: ChatChange; current?: Item; onOpenItem: (id: string) => void; onRefresh?: () => unknown }) {
  const key = `${jobId}:${change.itemId}`;
  const [decision, setDecision] = useState<Decision | undefined>(() => readDecisions()[key]);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const open = !decision;
  useEffect(() => { if (!open) return; let active = true; void api<ItemDetail>('items.read', { id: change.itemId }).then(d => { if (active) setDetail(d); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [open, change.itemId, change.to]);
  const decide = (next: Decision) => { const all = readDecisions(); all[key] = next; localStorage.setItem(DECISIONS, JSON.stringify(all)); setDecision(next); };
  const before = detail?.revisions.find(r => r.hash === change.from), after = detail?.revisions.find(r => r.hash === change.to);
  const since = current && current.revision !== change.to;
  const undo = async () => {
    setBusy(true); setError('');
    try { const restored = await api<Item>('items.restore', { id: change.itemId, expect: change.to, revision: change.from }); decide({ state: 'undone', revision: restored.revision }); await onRefresh?.(); }
    catch (e) { setError(/REVISION_CONFLICT/.test(String(e)) ? 'This item changed again after the reply. Restore from its History instead.' : String(e)); }
    finally { setBusy(false); }
  };
  const title = <button type="button" className="chat-change-title" title="Open this item" onClick={() => onOpenItem(change.itemId)}>{current?.title ?? change.title}</button>;
  const hashes = <code>{shortHash(change.from!)} → {shortHash(change.to)}</code>;
  if (decision) return <div className="chat-change-done">{decision.state === 'kept' ? <Check size={13} /> : <Undo2 size={13} />}<span>{decision.state === 'kept' ? 'Kept' : 'Undone'}</span>{title}{decision.state === 'kept' ? hashes : <code>restored as {shortHash(decision.revision)}</code>}</div>;
  const details: string[] = before && after ? [...(['title', 'description', 'kind'] as const).filter(field => before[field] !== after[field]), ...(before.tags.join() !== after.tags.join() ? ['tags'] : [])] : [];
  return <section className="chat-change" aria-label={`Changed by the agent: ${change.title}`}>
    <header><KindIcon kind={change.kind} size={14} /><div><span className="chat-change-kicker">Changed by the agent</span>{title}</div>{hashes}</header>
    {!detail && !error && <p className="chat-change-note"><Loader2 size={13} className="spin" />Loading the change…</p>}
    {before && after && (before.content === after.content
      ? <p className="chat-change-note">The content is the same.{details.length ? ` Changed: ${details.join(', ')}.` : ''}</p>
      : <><LineDiff className="chat-diff" before={before.content} after={after.content} names={{ before: 'the previous revision', after: 'the agent’s revision' }} />{details.length > 0 && <p className="chat-change-note">Also changed: {details.join(', ')}.</p>}</>)}
    {detail && (!before || !after) && <p className="chat-change-note">These revisions are not in this item’s history any more.</p>}
    {since && <p className="chat-change-note">Changed again since this reply.</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    <div className="chat-change-actions">
      <button type="button" className="button chat-sm" onClick={() => decide({ state: 'kept' })}><Check size={13} />Keep</button>
      <button type="button" className="button chat-sm" disabled={busy || since} title={since ? 'The item changed again; restore from its History instead' : `Restore ${shortHash(change.from!)} as a new draft`} onClick={() => void undo()}>{busy ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}Undo</button>
    </div>
  </section>;
}
