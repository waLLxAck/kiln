import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowDown, CloudOff, Github, GitMerge, Loader2, RefreshCw, Upload, X } from 'lucide-react';
import { api, date } from './api';
import { Modal } from './components';
import type { Snapshot } from '../../../packages/protocol/schema';
import type { PullResult, SyncStatus } from '../../../packages/git/sync';

/**
 * Background sync with GitHub, in the status bar's repository segment: where the library stands (Up to date, N new on GitHub
 * with Pull, N waiting to push, Offline), the popover with what is on its way, and the fetches behind it: shortly after
 * start, on a timer and when the window comes back. The backend runs them in its Git queue, after any commit or push.
 */
let current: SyncStatus | null = null;
const listeners = new Set<() => void>();
const publish = (next: SyncStatus | null) => { current = next; listeners.forEach(l => l()); };
/** The last fetch result, shared by the status bar and the Settings card. */
export function useSyncStatus() { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current); }
/** Asks the status bar to fetch, pull or merge, so Settings buttons share its explanations when something blocks. */
export const requestSync = (action: 'fetch' | 'pull' | 'merge') => window.dispatchEvent(new CustomEvent('kiln:sync', { detail: action }));

/** "owner/name" from a GitHub remote URL, the folder name for any other remote. */
export const repoName = (remote: string) => !/github\.com[/:]/.test(remote) && remote ? remote.split(/[\\/]/).filter(Boolean).at(-1)!.replace(/\.git$/, '') : remote.replace(/^(https:\/\/github\.com\/|git@github\.com:)/, '').replace(/\.git$/, '') || 'GitHub remote';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "just now", "4 min ago", "2 h ago", else the date. */
export function ago(value: string | null | undefined) {
  if (!value) return '';
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 24 * 60 ? `${Math.round(minutes / 60)} h ago` : date(value);
}
/** Commits and approvals still on their way to GitHub: what `ahead` counts plus jobs that have not made their commit yet. */
function waiting(snapshot: Snapshot) {
  const pending = snapshot.publish.filter(j => !['done', 'failed'].includes(j.status));
  const failed = snapshot.publish.filter(j => j.status === 'failed');
  return { pending, failed, count: snapshot.git.ahead + pending.filter(j => !j.commit).length + failed.filter(j => !j.commit).length };
}

/** Settings → Kiln repository line: what the last fetch found, instead of a blanket "up to date". */
export function SyncSummary({ git }: { git: Snapshot['git'] }) {
  const status = useSyncStatus();
  const parts = [git.behind ? `${git.behind} new on GitHub` : '', git.ahead ? `${plural(git.ahead, 'commit')} not on GitHub yet` : ''].filter(Boolean);
  const checked = status?.error ? `couldn’t reach GitHub${status.fetchedAt ? `; last fetched ${ago(status.fetchedAt)}` : ''}` : status?.fetchedAt ? `checked ${ago(status.fetchedAt)}` : 'not checked with GitHub yet';
  return <>{parts.length ? parts.join(' · ') : status?.fetchedAt && !status.error ? 'nothing new on GitHub' : 'no commits waiting here'} · {checked}</>;
}

type Problem = { kind: 'blocked'; items: { id: string; title: string }[]; paths: string[] } | { kind: 'diverged'; ahead: number; behind: number } | null;
type Props = { snapshot: Snapshot; refresh: () => Promise<void>; perform: (action: () => Promise<unknown>, success?: string) => Promise<void>; onMessage: (message: string) => void; onConflicts: (conflicts: unknown) => void; onReveal: (id: string) => void; onSettings: () => void };
/** The repository segment: `owner/name · branch · state`, Pull when GitHub has new commits, and the sync popover. */
export function RepoStatus({ snapshot, refresh, perform, onMessage, onConflicts, onReveal, onSettings }: Props) {
  const status = useSyncStatus();
  const [open, setOpen] = useState(false), [problem, setProblem] = useState<Problem>(null), [checking, setChecking] = useState(false);
  const box = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const attached = snapshot.git.attached;
  const fetchNow = useCallback(async (maxAgeMs: number) => {
    try {
      const next = await api<SyncStatus>('sync.fetch', { maxAgeMs });
      const changed = next.checkedAt !== current?.checkedAt; publish(next);
      if (changed) await refresh().catch(() => undefined);
    } catch { /* The library changed meanwhile; the next check starts over. */ }
  }, [refresh]);
  // Shortly after start, then on a timer, and on focus once the first check has run. The backend skips a fetch younger than asked.
  useEffect(() => {
    if (!attached) return;
    let active = true, started = false, timer: ReturnType<typeof setTimeout> | undefined, focusMs = 60_000;
    void api<SyncStatus>('sync.status').then(first => {
      if (!active) return; publish(first); focusMs = first.focusMs;
      const next = (delay: number) => { timer = setTimeout(async () => { started = true; await fetchNow(Math.floor(first.intervalMs / 2)); if (active) next(first.intervalMs); }, delay); };
      next(first.delayMs);
    }).catch(() => undefined);
    const onFocus = () => { if (started) void fetchNow(focusMs); };
    window.addEventListener('focus', onFocus);
    return () => { active = false; clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [attached, snapshot.root, fetchNow]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const pull = useCallback(() => perform(async () => {
    setOpen(false); setProblem(null);
    await fetchNow(0);
    const result = await api<PullResult>('sync.pull');
    await refresh();
    if (result.status === 'pulled') onMessage(`Pulled ${plural(result.count, 'change')} from GitHub`);
    else if (result.status === 'current') onMessage('Already up to date with GitHub');
    else if (result.status === 'blocked') setProblem({ kind: 'blocked', items: result.items, paths: result.paths });
    else setProblem({ kind: 'diverged', ahead: result.ahead, behind: result.behind });
  }), [perform, fetchNow, refresh, onMessage]);
  const merge = useCallback(() => perform(async () => {
    setOpen(false); setProblem(null);
    await fetchNow(0);
    onConflicts(await api('git.merge'));
    await refresh();
  }), [perform, fetchNow, refresh, onConflicts]);
  const check = useCallback(async () => { setChecking(true); try { await fetchNow(0); } finally { setChecking(false); } }, [fetchNow]);
  useEffect(() => { const listen = (event: Event) => { const action = (event as CustomEvent<string>).detail; if (action === 'pull') void pull(); else if (action === 'merge') void merge(); else if (action === 'fetch') void check(); }; window.addEventListener('kiln:sync', listen); return () => window.removeEventListener('kiln:sync', listen); }, [pull, merge, check]);

  const git = snapshot.git, { pending, failed, count } = waiting(snapshot);
  const where = <><b>{repoName(git.remote)}</b><span className="status-sep">·</span>{git.branch || 'no branch'}<span className="status-sep">·</span></>;
  if (!attached) return <button type="button" className="status-item repo" onClick={onSettings} title="Not connected to GitHub · open Settings & repository"><Github size={12} /><span className="repo-state">Local library</span></button>;
  const offline = Boolean(status?.error);
  const failedText = `${failed.length} failed to publish`;
  const state = git.behind ? 'behind' : failed.length ? 'bad' : pending.length ? 'busy' : count ? 'warn' : offline ? 'offline' : 'ok';
  const label = state === 'behind' ? `${git.behind} new on GitHub${failed.length ? ` · ${failedText}` : ''}` : state === 'bad' ? failedText : state === 'busy' ? `publishing ${pending.length}…` : state === 'warn' ? `${count} waiting to push` : state === 'offline' ? 'Offline' : status?.fetchedAt ? 'Up to date' : 'Not checked yet';
  const title = `${git.remote || 'No remote'}${status?.fetchedAt ? ` · checked GitHub ${ago(status.fetchedAt)}` : ''}${offline ? ` · couldn’t reach GitHub: ${status!.error}` : ''}`;
  const icon = checking || status?.fetching || state === 'busy' ? <Loader2 size={12} className="spin" /> : state === 'offline' ? <CloudOff size={12} /> : state === 'bad' ? <AlertTriangle size={12} /> : <Github size={12} />;
  return <div className="status-repo" ref={box}>
    <button type="button" ref={trigger} className={`status-item repo ${state} ${open ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-label={`Repository: ${label}`} title={title} onClick={() => setOpen(value => !value)}>
      {icon}{where}<span className="repo-state">{label}</span>
    </button>
    {state === 'behind' && <button type="button" className="status-item repo-pull" title="Bring GitHub’s changes to this machine. Drafts stay as they are." onClick={() => void pull()}><ArrowDown size={12} />Pull</button>}
    {open && <div className="sync-pop" role="dialog" aria-label="Sync with GitHub">
      <div className="runs-head"><span>{repoName(git.remote)} · {git.branch}</span><button type="button" className="icon-button" aria-label="Close sync" title="Close (Esc)" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={14} /></button></div>
      <p className="muted small sync-checked">{offline ? `Couldn’t reach GitHub ${ago(status!.checkedAt)}. Kiln tries again in a few minutes; nothing is lost meanwhile.` : status?.fetchedAt ? `Checked GitHub ${ago(status.fetchedAt)}.` : 'Kiln has not checked GitHub yet.'}</p>
      {git.behind > 0 && <div className="sync-row"><span>{git.behind} new on GitHub</span><button type="button" className="button primary" onClick={() => void pull()}><ArrowDown size={14} />Pull</button></div>}
      {pending.map(j => <div className="sync-row" key={j.id}><span>{j.title}</span><small className="muted"><Loader2 className="spin" size={12} /> {j.status}</small></div>)}
      {failed.slice(0, 5).map(j => <div className="sync-row failed" key={j.id}><span><b>{j.title}</b><small>{j.error}</small></span><button type="button" className="button" onClick={() => void perform(async () => { await api('publish.retry', { id: j.id }); await refresh(); })}>Retry</button></div>)}
      {git.ahead > 0 && !pending.length && <div className="sync-row"><span>{plural(git.ahead, 'commit')} not on GitHub yet</span><button type="button" className="button" onClick={() => void perform(async () => { await api('git.sync', { action: 'push' }); await refresh(); }, 'Pushed to GitHub')}><Upload size={14} />Push now</button></div>}
      <div className="sync-foot"><button type="button" className="button" disabled={checking || status?.fetching} onClick={() => void check()}><RefreshCw size={14} />Check now</button><button type="button" className="text-button" onClick={() => { setOpen(false); onSettings(); }}>Repository settings</button></div>
    </div>}
    {problem?.kind === 'blocked' && <Modal title="Can’t pull yet" subtitle="GitHub changed things you also changed on this machine. Nothing was changed here." onClose={() => setProblem(null)}>
      <ul className="sync-blockers">{problem.items.map(i => <li key={i.id}><span>{i.title}</span><button className="text-button" onClick={() => { setProblem(null); onReveal(i.id); }}>Open</button></li>)}{problem.paths.map(p => <li key={p}><code>{p}</code></li>)}</ul>
      <p>Approve your draft of each one (then <b>Merge from GitHub</b> combines both versions) or discard it, then pull again.</p>
      <div className="modal-actions"><button className="button primary" onClick={() => setProblem(null)}>OK</button></div>
    </Modal>}
    {problem?.kind === 'diverged' && <Modal title="Merge from GitHub?" subtitle={`GitHub has ${plural(problem.behind, 'new commit')} and this machine has ${plural(problem.ahead, 'commit')} GitHub doesn’t.`} onClose={() => setProblem(null)}>
      <p>Merging combines both. Items changed on both sides are shown side by side for you to choose; drafts of other items stay as they are.</p>
      <div className="modal-actions"><button className="button" onClick={() => setProblem(null)}>Not now</button><button className="button primary" onClick={() => void merge()}><GitMerge size={15} />Merge from GitHub</button></div>
    </Modal>}
  </div>;
}
