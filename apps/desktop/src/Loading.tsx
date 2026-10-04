import { Component, useCallback, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react';
import { Loader2, RotateCcw, TriangleAlert } from 'lucide-react';
import { api } from './api';
import { report } from './diagnostics';
import { busyLine, errorText, WAITING_MS, type BackendStatus } from './load-state';

/** True once `since` is more than WAITING_MS ago; false while `since` is null. */
export function useLate(since: number | null, after = WAITING_MS) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (since === null) { setLate(false); return; }
    const left = since + after - Date.now();
    setLate(left <= 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setLate(true), left);
    return () => clearTimeout(timer);
  }, [since, after]);
  return late;
}

/** What the backend is busy with, asked every second while `active`. Answered by the main process; an older one doesn't know it, and then this stays null. */
export function useBackendStatus(active: boolean) {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  useEffect(() => {
    if (!active) { setStatus(null); return; }
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => void api<BackendStatus>('backend.status').then(next => { if (!live) return; setStatus(next); timer = setTimeout(ask, 1000); }).catch(() => undefined);
    ask();
    return () => { live = false; clearTimeout(timer); };
  }, [active]);
  return status;
}

/**
 * A spinner for something on its way. After a few seconds it says it is waiting for Kiln, and what the backend is busy with
 * when the main process can tell, so a slow reply reads as "busy", not as "stuck".
 */
export function Waiting({ since, label, children, block = false }: { since: number | null; /** For screen readers, e.g. "Opening item". */ label: string; /** Shown beside the spinner from the start, e.g. "Reading configs…". */ children?: string; /** The large centred form, for a whole pane. */ block?: boolean }) {
  const late = useLate(since), status = useBackendStatus(late), busy = busyLine(status);
  return <div className={block ? 'item-loading' : 'load-wait muted'} role="status" aria-label={label}>
    <Loader2 className="spin" size={block ? 18 : 14} />
    {(children || late) && <span>{late ? 'Waiting for Kiln…' : children}{late && busy && <small className="faint"> {busy}</small>}</span>}
  </div>;
}

/** A failed load in place of what it was loading: why, Retry, and optionally a way back. */
export function LoadError({ error, onRetry, back, block = false }: { error: string; onRetry: () => void; back?: { label: string; onClick: () => void }; block?: boolean }) {
  return <div className={block ? 'item-loading load-error block' : 'load-error'} role="alert">
    <span className="load-error-text"><TriangleAlert size={14} />{error}</span>
    <span className="inline"><button type="button" className="button" onClick={onRetry}><RotateCcw size={14} />Retry</button>{back && <button type="button" className="text-button" onClick={back.onClick}>{back.label}</button>}</span>
  </div>;
}

/**
 * Catches a render error below it, so one broken screen shows what happened instead of blanking the window. `fallback` gets
 * the error and a `reset` that tries rendering again; a change of `resetKey` (the item shown, say) resets it too.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: (error: Error, reset: () => void) => ReactNode; resetKey?: unknown }, { error: Error | null; key: unknown }> {
  state: { error: Error | null; key: unknown } = { error: null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) { return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null; }
  componentDidCatch(error: Error) { report('renderer.renderError', { name: error.name }); }
  render() { return this.state.error ? this.props.fallback(this.state.error, () => this.setState({ error: null })) : this.props.children; }
}

/**
 * Loads once per change of `deps`: `data` (null again when `deps` change; kept during a Retry), `error` (with `retry`, which
 * skips a read already on its way) and `since` (when the load still running started, else null). `load` gets `fresh` on a Retry.
 */
export function useLoad<T>(load: (fresh: boolean) => Promise<T>, deps: DependencyList) {
  const [state, setState] = useState<{ data: T | null; error: string; since: number | null }>(() => ({ data: null, error: '', since: Date.now() }));
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(load); latest.current = load;
  const tried = useRef(attempt);
  useEffect(() => {
    let live = true;
    const retrying = tried.current !== attempt; tried.current = attempt;
    setState(current => ({ data: retrying ? current.data : null, error: '', since: Date.now() }));
    latest.current(attempt > 0).then(data => { if (live) setState({ data, error: '', since: null }); }, error => { if (live) setState(current => ({ ...current, error: errorText(error), since: null })); });
    return () => { live = false; };
  }, [...deps, attempt]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { ...state, retry, setData: (data: T | null) => setState(current => ({ ...current, data })) };
}
