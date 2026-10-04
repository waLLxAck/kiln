import type { ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { Snapshot } from '../../../packages/protocol/schema';
import type { AgentJobSummary } from '../../../packages/agent/service';
import { RepoStatus } from './Sync';
import { RunsStatus, type RunRef } from './Runs';
import './shell.css';

export { repoName } from './Sync';
/** "4 s", "2 min", "1 h 5 min": how long a run has taken. */
export const elapsed = (from: string, to = Date.now()) => { const s = Math.max(0, Math.round((to - new Date(from).getTime()) / 1000)); return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`; };

type Props = {
  snapshot: Snapshot; jobs: AgentJobSummary[]; agentError: string; busy: boolean; onSettings: () => void;
  /** Opens a run's result: its item on the right view, or the chat. */ onOpenRun: (job: RunRef) => void;
  refresh: () => Promise<void>; perform: (action: () => Promise<unknown>, success?: string) => Promise<void>; onMessage: (message: string) => void; onConflicts: (conflicts: unknown) => void; onReveal: (id: string) => void;
  /** A finished analysis filed its entries here. */ onOpenCollection?: (name: string) => void;
  /** What loads at session start (SessionStart.tsx), after the runs; it brings its own divider. */ context?: ReactNode;
};

/**
 * The thin bar along the bottom of the window: where the repository stands with GitHub (kept current by background sync), the
 * agent runs with their list, and what a new agent session loads.
 */
export function StatusBar({ snapshot, jobs, agentError, busy, onSettings, onOpenRun, refresh, perform, onMessage, onConflicts, onReveal, onOpenCollection, context }: Props) {
  return <footer className="status-bar">
    <RepoStatus snapshot={snapshot} refresh={refresh} perform={perform} onMessage={onMessage} onConflicts={onConflicts} onReveal={onReveal} onSettings={onSettings} />
    <span className="status-divider" />
    <RunsStatus jobs={jobs} items={snapshot.items} onOpen={onOpenRun} onOpenCollection={onOpenCollection} />
    {context}
    {agentError && <span className="status-item bad" role="alert" title={agentError}><AlertTriangle size={12} />Agent updates disconnected. Retrying…</span>}
    <span className="status-grow" />
    {busy && <span className="status-item muted" aria-live="polite"><Loader2 size={12} className="spin" />Working…</span>}
  </footer>;
}
