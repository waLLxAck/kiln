import { Download, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import type { UpdateStatus } from '../../../packages/protocol/schema';

type Actions = { update: UpdateStatus | null; working: boolean; onPrepare: () => void; onRestart: () => void };
export function UpdateAction({ update, working, onPrepare, onRestart, compact = false }: Actions & { compact?: boolean }) {
  if (!update) return null;
  const stage = update.stage;
  if (stage.state === 'preparing') return <button className="button" disabled aria-label={`Preparing update ${stage.progress}%`}><Loader2 className="spin" size={14} />{compact ? `${stage.progress}%` : `Preparing ${stage.progress}%`}</button>;
  if (stage.state === 'ready') return <button className="button primary" disabled={working} aria-label="Restart to update" title={`Restart and apply Kiln ${stage.version}. Save your work first.`} onClick={onRestart}><RefreshCw size={14} />{compact ? 'Restart' : 'Restart to update'}</button>;
  if (!update.available) return null;
  return <button className={compact ? 'icon-button update-available' : 'button primary'} disabled={working} aria-label="Prepare update" title={`Prepare Kiln ${update.available.version} while you keep working`} onClick={onPrepare}><Download size={15} />{!compact && (stage.state === 'failed' ? 'Retry update' : `Prepare ${update.available.version}`)}</button>;
}

export function UpdatesPanel({ update, working, onPrepare, onRestart, onCheck, onSource }: Actions & { onCheck: () => void; onSource: (value?: { clear?: boolean; off?: boolean }) => void }) {
  return <section className="settings-card"><h3>Updates</h3>
    <p>Prepare an update while you keep working. When it is ready, click <b>Restart to update</b> to apply it. Kiln stays open until you choose to restart.</p>
    {update?.stage.state === 'preparing' && <p role="status">Preparing Kiln {update.stage.version}… {update.stage.progress}%</p>}
    {update?.stage.state === 'ready' && <p role="status">Kiln {update.stage.version} is ready. Restart whenever you’re ready; save your work first.</p>}
    {update?.stage.state === 'failed' && <p className="error-box" role="alert">{update.stage.message}</p>}
    {update?.source ? <><code className="path-text">{update.source}</code><p className="muted small">{update.sourceKind === 'build' ? 'Watching this build’s release folder.' : 'Watching the folder chosen here.'} {update.available ? `Version ${update.available.version} available.` : `Running ${update.current}. No newer installer found.`}</p></> : <p className="muted small">{update?.sourceKind === 'off' ? 'Update checks are off.' : 'Choose a release folder to check for updates.'}</p>}
    {update?.error && <p className="error-box">{update.error}</p>}
    {update?.packaged === false && <p className="muted small">Running from source. Restart to update applies the installer to your installed Kiln and closes this development window.</p>}
    <div className="wrap-actions"><UpdateAction {...{ update, working, onPrepare, onRestart }} />
      <button className="button" disabled={!update?.source || working} onClick={onCheck}><RefreshCw size={15} />Check now</button>
      <button className="button" disabled={working || update?.stage.state === 'preparing'} onClick={() => onSource()}><FolderOpen size={15} />Watch a different folder</button>
      {update?.sourceKind === 'setting' && <button className="text-button" onClick={() => onSource({ clear: true })}>Back to this build’s folder</button>}
      {update?.sourceKind !== 'off' ? <button className="text-button" onClick={() => onSource({ off: true })}>Stop checking</button> : <button className="text-button" onClick={() => onSource({ clear: true })}>Check again</button>}
    </div>
  </section>;
}
