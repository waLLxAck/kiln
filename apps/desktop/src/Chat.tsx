import { useEffect, useRef, useState } from 'react';
import { MessageSquare, RotateCcw, Download, X } from 'lucide-react';
import type { AgentJob } from '../../../packages/agent/service';
import type { Item, RunProviderId } from '../../../packages/protocol/schema';
import { api } from './api';
import { providerName } from './components';
import { ChatThread } from './AgentPanel';

/** Chat turns about one item, oldest first. Turns from the older per-video conversation belong to the same thread. */
export const itemTurns = (jobs: AgentJob[], itemId: string) => jobs.filter(job => job.kind === 'chat' && job.itemId === itemId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

/**
 * The assistant, opened from the top bar, about the item that is open. Behind a video, or an entry distilled from one, the agent also
 * gets the transcript and the other entries; otherwise it gets the item alone. Stays open while browsing; Esc closes it.
 */
export function ChatPopover({ jobs, item, video, provider, onClose, onOpenItem }: { jobs: AgentJob[]; item: Item; /** The video behind the open item, when there is one. */ video: Item | null; provider: RunProviderId; onClose: () => void; onOpenItem: (id: string) => void }) {
  const conversation = useRef({ itemId: item.id, id: crypto.randomUUID() });
  const [, redraw] = useState(0);
  if (conversation.current.itemId !== item.id) conversation.current = { itemId: item.id, id: crypto.randomUUID() };
  const [error, setError] = useState('');
  const [sending, setSending] = useState<{ itemId: string; message: string } | null>(null);
  const [accepted, setAccepted] = useState<AgentJob | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const turns = itemTurns(accepted && !jobs.some(job => job.id === accepted.id) ? [...jobs, accepted] : jobs, item.id).filter(j => j.conversationId === conversation.current.id), busy = sending?.itemId === item.id || turns.some(turn => turn.status === 'running');
  const who = providerName[turns.at(-1)?.provider ?? jobs.find(j => j.itemId === (video ?? item).id && j.kind === 'distill' && j.threadId)?.provider ?? provider];
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('dialog[open], .context-menu')) { event.stopPropagation(); onClose(); } }; window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true); }, [onClose]);
  const last = turns.at(-1); const lastKey = last ? `${last.id}:${last.status}:${last.phase}:${last.steps.at(-1)?.text}` : '';
  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight }); }, [lastKey, item.id]);
  useEffect(() => { setError(''); }, [item.id]);
  const send = async (message: string) => {
    setError(''); setSending({ itemId: item.id, message });
    try { setAccepted(await api<AgentJob>('agent.chat', { message, itemId: item.id, conversationId: conversation.current.id })); }
    catch (e) { setError(String(e)); throw e; }
    finally { setSending(null); }
  };
  return <aside className="chat-popover" role="dialog" aria-label="Ask the agent">
    <div className="chat-head"><b><MessageSquare size={15} />Ask {who}</b><button type="button" className="icon-button" aria-label="Close chat" title="Close (Esc)" onClick={onClose}><X size={16} /></button></div>
    <div className="wrap-actions"><button type="button" className="text-button" disabled={busy} onClick={() => { conversation.current = { itemId: item.id, id: crypto.randomUUID() }; setAccepted(null); setError(''); redraw(n => n + 1); }}><RotateCcw size={13} />New session</button>{last && !busy && <button type="button" className="text-button" onClick={() => void api('desktop.exportSession', { id: last.id }).catch(e => setError(String(e)))}><Download size={13} />Export conversation…</button>}</div>
    <div className="chat-context"><span>About <b>{item.title}</b></span><span>{item.kind} · {item.collection}{video ? video.id === item.id ? ' · with its transcript' : <> · from the video <button type="button" className="text-button" onClick={() => onOpenItem(video.id)}>{video.title}</button>, transcript included</> : ''}</span></div>
    <div className="chat-body" ref={body}>
      {!turns.length && <div className="chat-empty"><p>{video ? 'Ask about the video or this entry, or ask for changes. The agent has the transcript, this item and every entry distilled from the video, and is instructed to use Kiln’s CLI for library edits. It runs through your installed CLI with the permissions explained before each interaction.' : 'Ask about this item, or ask for changes. The agent reads it and its attached files, and is instructed to use Kiln’s CLI for library edits. It runs through your installed CLI with the permissions explained before each interaction.'}</p><p className="small">Try: {video ? '“Which prompt did they use for the outline step?” · “Make this technique more detailed” · “Add an entry for the tool mentioned at 12:30”' : '“Make this prompt more specific” · “Summarise this in three bullets” · “Turn the steps into a checklist”'}</p></div>}
      {sending?.itemId === item.id && <div role="status" className="chat-question"><span>You · sending to {who}…</span><p>{sending.message}</p></div>}
      <ChatThread key={conversation.current.id} turns={turns} busy={busy} error={error} onSend={send} placeholder={`Ask about “${item.title}”, or ask for a change…`} hint="Ctrl+Enter sends. Switching items starts a new session. Conversations stay private on this machine." />
    </div>
  </aside>;
}
