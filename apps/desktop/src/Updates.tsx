import { Download, ExternalLink, FolderOpen, Github, Loader2, RefreshCw } from 'lucide-react';
import { api, date, platform } from './api';
import type { UpdateStatus } from '../../../packages/protocol/schema';

type Actions = { update: UpdateStatus | null; working: boolean; onPrepare: () => void; onRestart: () => void };
/** Opens the release page of an update that this copy cannot install itself (macOS, the Linux tar.gz, development builds). */
const openRelease = (update: UpdateStatus) => void api('desktop.openUrl', { url: update.available?.path ?? update.source });
export function UpdateAction({ update, working, onPrepare, onRestart, compact = false }: Actions & { compact?: boolean }) {
  if (!update) return null;
  const stage = update.stage, github = update.sourceKind === 'github', verb = github ? 'Downloading' : 'Preparing';
  if (stage.state === 'preparing') return <button className="button" disabled aria-label={`${verb} update ${stage.progress}%`}><Loader2 className="spin" size={14} />{compact ? `${stage.progress}%` : `${verb} ${stage.progress}%`}</button>;
  if (stage.state === 'ready') return <button className="button primary" disabled={working} aria-label="Restart to update" title={`Restart and apply Kiln ${stage.version}. Save your work first.`} onClick={onRestart}><RefreshCw size={14} />{compact ? 'Restart' : 'Restart to update'}</button>;
  if (!update.available) return null;
  if (github && update.install === 'download') return <button className={compact ? 'icon-button update-available' : 'button primary'} aria-label={`Get Kiln ${update.available.version}`} title={`Kiln ${update.available.version} is out. Open its release page to download it.`} onClick={() => openRelease(update)}><ExternalLink size={15} />{!compact && `Get ${update.available.version}`}</button>;
  const label = github ? `Download ${update.available.version}` : `Prepare ${update.available.version}`;
  return <button className={compact ? 'icon-button update-available' : 'button primary'} disabled={working} aria-label={github ? 'Download update' : 'Prepare update'} title={`${github ? 'Download' : 'Prepare'} Kiln ${update.available.version} while you keep working`} onClick={onPrepare}><Download size={15} />{!compact && (stage.state === 'failed' ? 'Retry update' : label)}</button>;
}

/** Where macOS and Linux builds are updated from. */
const releasesPage = 'https://github.com/waLLxAck/kiln/releases';
export function UpdatesPanel({ update, working, onPrepare, onRestart, onCheck, onSource }: Actions & { onCheck: () => void; onSource: (value?: { clear?: boolean; off?: boolean; github?: boolean }) => void }) {
  const developer = <details className="update-developer"><summary>For developers: watch a local release folder</summary>
    <p className="muted small">Take installers from a folder instead of GitHub, such as the <code>release</code> folder of a Kiln checkout. Windows only.</p>
    <div className="wrap-actions"><button className="button" disabled={working || update?.stage.state === 'preparing'} onClick={() => onSource()}><FolderOpen size={15} />{update?.sourceKind === 'setting' || update?.sourceKind === 'build' ? 'Watch a different folder' : 'Watch a folder'}</button>
      {update?.sourceKind !== 'github' && <button className="text-button" onClick={() => onSource({ github: true })}>Use GitHub releases</button>}
      {update?.sourceKind === 'setting' && <button className="text-button" onClick={() => onSource({ clear: true })}>Back to this build’s default</button>}</div>
  </details>;
  const stopOrResume = update?.sourceKind !== 'off' ? <button className="text-button" onClick={() => onSource({ off: true })}>Stop checking</button> : <button className="text-button" onClick={() => onSource({ clear: true })}>Check again</button>;
  if (update?.sourceKind === 'github' || (update?.sourceKind === 'off' && !update.supported)) return <section className="settings-card"><h3>Updates</h3>
    {update.sourceKind === 'off' ? <p>Update checks are off. Kiln {update.current} is running.</p>
      : update.install === 'app' ? <p>Kiln checks GitHub for new releases shortly after it starts and every 30 minutes. When one is out, download it while you keep working, then click <b>Restart to update</b>.</p>
      : <p>Kiln checks GitHub for new releases shortly after it starts and every 30 minutes. This copy can’t replace itself{update.packaged ? ' (macOS only allows that for apps signed with an Apple Developer ID; the Linux tar.gz has no installer)' : ' (it runs from source)'}, so a new version opens its release page to download.</p>}
    {update.stage.state === 'preparing' && <p role="status">Downloading Kiln {update.stage.version}… {update.stage.progress}%</p>}
    {update.stage.state === 'ready' && <p role="status">Kiln {update.stage.version} is ready. Restart whenever you’re ready; save your work first.</p>}
    {update.stage.state === 'failed' && <p className="error-box" role="alert">{update.stage.message}</p>}
    {update.sourceKind === 'github' && <p className="muted small"><Github size={12} /> {update.available ? `Kiln ${update.available.version} is available; you have ${update.current}.` : `Kiln ${update.current} is the latest release.`}{update.checkedAt ? ` Checked ${date(update.checkedAt)}.` : ' Not checked yet.'}</p>}
    {update.error && <p className="error-box">{update.error}</p>}
    <div className="wrap-actions"><UpdateAction {...{ update, working, onPrepare, onRestart }} />
      {update.sourceKind === 'github' && <button className="button" disabled={working} onClick={onCheck}><RefreshCw size={15} />Check now</button>}
      <button className="button" onClick={() => void api('desktop.openUrl', { url: releasesPage })}><ExternalLink size={15} />Releases page</button>
      {stopOrResume}</div>
    {platform === 'win32' && update.sourceKind !== 'off' && developer}
  </section>;
  // A local build on macOS or Linux: its release folder holds no installer this platform can run.
  if (update?.supported === false) return <section className="settings-card"><h3>Updates</h3>
    <p>Kiln {update.current} is a local build, which watches its repository’s release folder for Windows installers. On this platform, follow GitHub releases instead.</p>
    <div className="wrap-actions"><button className="button primary" onClick={() => onSource({ github: true })}><Github size={15} />Use GitHub releases</button><button className="button" onClick={() => void api('desktop.openUrl', { url: releasesPage })}><ExternalLink size={15} />Releases page</button></div>
  </section>;
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
      <button className="text-button" onClick={() => onSource({ github: true })}>Use GitHub releases</button>
      {update?.sourceKind === 'setting' && <button className="text-button" onClick={() => onSource({ clear: true })}>Back to this build’s folder</button>}
      {stopOrResume}
    </div>
  </section>;
}
