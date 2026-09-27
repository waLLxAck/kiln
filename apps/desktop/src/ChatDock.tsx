import { useEffect, useRef, useState } from 'react';
import { Download, Eye, History, MessageSquare, RotateCcw, Undo2, X } from 'lucide-react';
import type { AgentJob } from '../../../packages/agent/service';
import { activeRun } from '../../../packages/agent/run-notice';
import type { Item, ItemDetail, Revision, RunProviderId } from '../../../packages/protocol/schema';
import { changeCandidates, chatSessions, chatTurns, mergeTurns, turnChange, type TurnChange } from '../../../packages/agent/chat-history';
import { api, date, shortHash } from './api';
import { ContextMenu, Modal, providerName, type MenuEntry } from './components';
import { ChatThread } from './AgentPanel';
import { LineDiff } from './Diff';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';

/** Which conversation each item shows, so closing the chat, switching items or restarting brings the same one back. Machine-private, like the turns. */
const STORE = 'kiln-chat-conversations';
const remembered = (): Record<string, string> => { try { const value = JSON.parse(localStorage.getItem(STORE) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };

/**
 * chatHistory experiment: the chat about the open item as a resizable panel beside the detail pane, instead of ChatPopover's overlay.
 * Each item keeps its conversation (New session starts another; Sessions reopens an earlier one, resuming its CLI session), replies
 * render as Markdown, and a turn that changed items shows what changed with View changes and Undo change. Takes `initialMessage`
 * from `kiln:ask-agent` exactly as ChatPopover does (see TrialLoop.tsx).
 */
export function ChatDock({ jobs, items, item, source, provider, onClose, onOpenItem, initialMessage, refresh }: { jobs: AgentJob[]; items: Item[]; item: Item; source: Item | null; provider: RunProviderId; onClose: () => void; onOpenItem: (id: string) => void; initialMessage?: { text: string; nonce: number }; refresh: () => Promise<void> }) {
  const panel = usePanelWidth('kiln-chat-width', 400, 320, 760);
  const video = source?.tags.includes('youtube') ? source : null;
  const [history, setHistory] = useState<{ itemId: string; turns: AgentJob[] } | null>(null);
  const [conversations, setConversations] = useState(remembered);
  const [error, setError] = useState('');
  const [sending, setSending] = useState<{ itemId: string; message: string } | null>(null);
  const [accepted, setAccepted] = useState<AgentJob | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const body = useRef<HTMLDivElement>(null), menuClosed = useRef(0);
  const live = chatTurns(jobs, item.id), liveKey = live.map(turn => `${turn.id}:${turn.status}`).join();
  // agent.jobs carries only recent runs; the full history of this item comes from disk, and again whenever one of its turns changes state.
  useEffect(() => { let active = true; api<AgentJob[]>('agent.chatHistory', { itemId: item.id }).then(turns => { if (active) setHistory({ itemId: item.id, turns }); }).catch(e => { if (active) { setHistory({ itemId: item.id, turns: [] }); setError(String(e)); } }); return () => { active = false; }; }, [item.id, liveKey]);
  const loaded = history?.itemId === item.id;
  const all = mergeTurns(live, accepted?.itemId === item.id ? [accepted] : [], loaded ? history.turns : []);
  const sessions = chatSessions(all);
  // Without a remembered choice the item's latest conversation comes back; an item never chatted about gets a fresh one.
  const conversationId = conversations[item.id] ?? (loaded ? sessions[0]?.conversationId : undefined);
  const choose = (id: string) => { const next = { ...remembered(), [item.id]: id }; localStorage.setItem(STORE, JSON.stringify(next)); setConversations(next); setAccepted(null); setError(''); };
  useEffect(() => { if (loaded && !conversationId) choose(crypto.randomUUID()); }, [loaded, conversationId, item.id]);
  // The prefill counts as used once the composer that shows it is on screen, so waiting for the history does not drop it.
  const prefilled = useRef(0), draft = initialMessage && initialMessage.nonce !== prefilled.current ? initialMessage : undefined;
  useEffect(() => { if (initialMessage && conversationId) prefilled.current = initialMessage.nonce; }, [initialMessage?.nonce, conversationId]);
  const turns = all.filter(turn => turn.conversationId === conversationId), busy = sending?.itemId === item.id || all.some(activeRun);
  const who = providerName[turns.at(-1)?.provider ?? jobs.find(j => j.itemId === (source ?? item).id && j.kind === 'distill' && j.threadId)?.provider ?? provider];
  const last = turns.at(-1); const lastKey = last ? `${last.id}:${last.status}:${last.phase}:${last.steps.at(-1)?.text}` : '';
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }); }, [lastKey, item.id, conversationId]);
  useEffect(() => { setError(''); setMenu(null); }, [item.id]);
  const send = async (message: string) => {
    const id = conversationId ?? crypto.randomUUID(); if (!conversationId) choose(id);
    setError(''); setSending({ itemId: item.id, message });
    try { setAccepted(await api<AgentJob>('agent.chat', { message, itemId: item.id, conversationId: id })); }
    catch (e) { setError(String(e)); throw e; }
    finally { setSending(null); }
  };
  const entries: MenuEntry[] = [{ heading: `Sessions about “${item.title.slice(0, 40)}”` }, ...sessions.map(s => ({ label: s.question.split('\n')[0].slice(0, 70) || 'Untitled session', note: `${date(s.startedAt)} · ${providerName[s.provider]}`, hint: `${s.turns} message${s.turns === 1 ? '' : 's'}, last ${date(s.lastAt)}`, checked: s.conversationId === conversationId, disabled: busy, onSelect: () => choose(s.conversationId) }))];
  return <>
    <ResizeHandle panel={panel} label="Resize chat" invert />
    <aside className="chat-dock" style={panel.style} role="complementary" aria-label="Ask the agent" onKeyDown={event => { if (event.key === 'Escape' && !document.querySelector('dialog[open], .context-menu') && performance.now() - menuClosed.current > 250) { event.stopPropagation(); onClose(); } }}>
      <div className="chat-head"><b><MessageSquare size={15} />Ask {who}</b><button type="button" className="icon-button" aria-label="Close chat" title="Close (Esc)" onClick={onClose}><X size={16} /></button></div>
      <div className="wrap-actions"><button type="button" className="text-button" disabled={busy} onClick={() => choose(crypto.randomUUID())}><RotateCcw size={13} />New session</button><button type="button" className="text-button" aria-haspopup="menu" aria-expanded={Boolean(menu)} disabled={!sessions.length} title="Earlier conversations about this item" onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ x: box.left, y: box.bottom + 4 }); }}><History size={13} />Sessions{sessions.length ? ` (${sessions.length})` : ''}</button>{last && !busy && <button type="button" className="text-button" title="The CLI’s transcript of this session, which includes its earlier turns" onClick={() => void api('desktop.exportSession', { id: last.id }).catch(e => setError(String(e)))}><Download size={13} />Export conversation…</button>}</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={() => { setMenu(null); menuClosed.current = performance.now(); }} />}
      <div className="chat-context"><span>About <b>{item.title}</b></span><span>{item.kind}{item.collection ? ` · ${item.collection}` : ''}{source ? source.id === item.id ? video ? ' · with its transcript' : ' · with everything made from it' : <> · from the {video ? 'video' : 'source'} <button type="button" className="text-button" onClick={() => onOpenItem(source.id)}>{source.title}</button>, {video ? 'transcript' : 'material'} included</> : ''}</span></div>
      <div className="chat-body" ref={body}>
        {!turns.length && <div className="chat-empty"><p>{source ? `Ask about the ${video ? 'video' : 'source'} or this entry, or ask for changes. The agent has the ${video ? 'transcript' : 'source material'}, this item and every entry made from the ${video ? 'video' : 'source'}, and is instructed to use Kiln’s CLI for library edits.` : 'Ask about this item, or ask for changes. The agent reads it and its attached files, and is instructed to use Kiln’s CLI for library edits.'} It runs through your installed CLI with the permissions explained before your first message each time Kiln starts. Changes it makes show here, with Undo.</p><p className="small">Try: {video ? '“Which prompt did they use for the outline step?” · “Make this technique more detailed” · “Add an entry for the tool mentioned at 12:30”' : source ? '“What did the analysis leave out?” · “Make this technique more detailed” · “Add a prompt for the review step it describes”' : '“Make this prompt more specific” · “Summarise this in three bullets” · “Turn the steps into a checklist”'}</p></div>}
        {sending?.itemId === item.id && <div role="status" className="chat-question"><span>You · sending to {who}…</span><p>{sending.message}</p></div>}
        {conversationId ? <ChatThread key={conversationId} turns={turns} busy={busy} error={error} onSend={send} placeholder={`Ask about “${item.title}”, or ask for a change…`} hint="Ctrl+Enter sends. Each item keeps its conversations; Sessions reopens earlier ones. They stay private on this machine." draft={draft} markdown extra={turn => <TurnChanges turn={turn} items={items} refresh={refresh} onOpenItem={onOpenItem} />} /> : <p className="muted small" role="status">Loading this item’s conversation…</p>}
      </div>
    </aside>
  </>;
}

/** What a finished turn changed in the library: each item whose revision moved while the agent worked, with its diff and an undo. */
function TurnChanges({ turn, items, refresh, onOpenItem }: { turn: AgentJob; items: Item[]; refresh: () => Promise<void>; onOpenItem: (id: string) => void }) {
  const candidates = changeCandidates(turn, items), key = candidates.map(i => `${i.id}:${i.revision}:${i.deletedAt ?? ''}`).join();
  const [changes, setChanges] = useState<TurnChange[]>([]);
  const [view, setView] = useState<TurnChange | null>(null), [undo, setUndo] = useState<TurnChange | null>(null);
  useEffect(() => {
    let active = true;
    if (!candidates.length) { setChanges([]); return; }
    void Promise.all(candidates.map(i => api<ItemDetail>('items.read', { id: i.id }).then(detail => turnChange(turn, detail)).catch(() => null))).then(found => { if (active) setChanges(found.filter((c): c is TurnChange => Boolean(c))); });
    return () => { active = false; };
  }, [key, turn.id, turn.finishedAt]);
  if (!changes.length) return null;
  return <div className="chat-changes" role="group" aria-label="Changes the agent made">
    {changes.map(c => { const again = !c.undone && c.current !== c.after; return <div className="chat-change" key={c.itemId}>
      <p><b>{c.before ? 'Changed' : 'Created'} {c.title}</b>{c.notes.length > 0 && <>: {c.notes.join('; ')}</>}</p>
      {c.undone ? <p className="muted small">Undone: restored to {shortHash(c.before!)}.</p> : again ? <p className="muted small">Changed again since. Compare versions in History.</p> : null}
      <div className="wrap-actions">
        {c.itemId !== turn.itemId && <button type="button" className="text-button" onClick={() => onOpenItem(c.itemId)}>Open</button>}
        {c.before && <button type="button" className="text-button" onClick={() => setView(c)}><Eye size={13} />View changes</button>}
        {c.before && !c.undone && <button type="button" className="text-button" disabled={again || c.deleted} title={again ? 'It changed again after this turn, so undoing could lose that edit.' : c.deleted ? 'The item is in the trash.' : `Restore ${shortHash(c.before)} as a new revision`} onClick={() => setUndo(c)}><Undo2 size={13} />Undo change</button>}
      </div>
    </div>; })}
    {view && <ChangeDiff change={view} onClose={() => setView(null)} />}
    {undo && <UndoChange change={undo} refresh={refresh} onClose={() => setUndo(null)} />}
  </div>;
}

function ChangeDiff({ change, onClose }: { change: TurnChange; onClose: () => void }) {
  const [pair, setPair] = useState<{ before: Revision; after: Revision } | null>(null), [error, setError] = useState('');
  useEffect(() => { void Promise.all([api<Revision>('items.revision', { id: change.itemId, revision: change.before }), api<Revision>('items.revision', { id: change.itemId, revision: change.after })]).then(([before, after]) => setPair({ before, after })).catch(e => setError(String(e))); }, [change.itemId, change.before, change.after]);
  const other = pair ? (['title', 'description', 'tags', 'source', 'licence'] as const).filter(field => JSON.stringify(pair.before[field]) !== JSON.stringify(pair.after[field])) : [];
  const files = pair ? [...new Set([...Object.keys(pair.before.files), ...Object.keys(pair.after.files)])].filter(name => pair.before.files[name] !== pair.after.files[name]) : [];
  return <Modal wide title={`Changes to ${change.title}`} subtitle={`${shortHash(change.before!)} → ${shortHash(change.after)}${change.notes.length ? ` · ${change.notes.join('; ')}` : ''}`} onClose={onClose}>
    {error && <p role="alert" className="error-box">{error}</p>}
    {!pair && !error && <p className="muted" role="status">Loading both versions…</p>}
    {pair && <><LineDiff before={pair.before.content} after={pair.after.content} names={{ before: 'the version before this turn', after: 'the agent’s version' }} />{(other.length > 0 || files.length > 0) && <p className="muted small">Also changed: {[...other, ...files.map(name => `file ${name}`)].join(', ')}.</p>}</>}
  </Modal>;
}

function UndoChange({ change, refresh, onClose }: { change: TurnChange; refresh: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const confirm = async () => {
    setBusy(true); setError('');
    try {
      const current = await api<ItemDetail>('items.read', { id: change.itemId });
      if (current.item.revision !== change.after) throw new Error(`“${change.title}” changed again after this turn, so undoing could lose that edit. Compare versions in History instead.`);
      await api('items.restore', { id: change.itemId, expect: change.after, revision: change.before });
      await refresh(); onClose();
    } catch (e) { setError(String(e)); setBusy(false); }
  };
  return <Modal title="Undo this change?" subtitle={change.title} onClose={onClose}>
    <p>This restores “{change.title}” to how it was before this turn ({shortHash(change.before!)}) as a new revision. The agent’s version stays in History, and installed copies are unchanged.</p>
    {error && <p role="alert" className="error-box">{error}</p>}
    <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={busy} onClick={() => void confirm()}>{busy ? 'Undoing…' : 'Undo change'}</button></div>
  </Modal>;
}
