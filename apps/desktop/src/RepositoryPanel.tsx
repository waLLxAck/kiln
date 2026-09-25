import { useEffect, useState } from 'react';
import { Check, Download, FolderGit2, Github, Lock, RefreshCw, Upload } from 'lucide-react';
import { api } from './api';
import { Badge, Modal } from './components';
import { LocalSkillsDialog, RepositorySkillsDialog } from './Import';
import type { GitHubState } from '../../../packages/git/github';

type Props = { root: string; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void>; /** Opens the setup screen: sign-in, create or connect a Kiln repository. */ onSetup: () => void; onMessage: (message: string) => void };
type Infra = { hash: string; version: number; files: { relative: string; operation: string; blocked: boolean }[] };
/** GitHub identity, standard-layout status, importing skills as drafts, and infrastructure updates. Creating or switching repositories goes through setup. */
export function RepositoryPanel({ root, perform, refresh, onSetup, onMessage }: Props) {
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState<GitHubState | null>(null), [standard, setStandard] = useState<{ standard: boolean; infrastructureVersion: number; current: boolean } | null>(null);
  const [dialog, setDialog] = useState<'' | 'local' | 'repository' | 'infrastructure'>('');
  const [infra, setInfra] = useState<Infra | null>(null);
  const reload = async () => { setChecking(true); try { await Promise.all([api<GitHubState>('github.status').then(setState), api<typeof standard>('repository.status').then(setStandard)]); } finally { setChecking(false); } };
  useEffect(() => { void reload().catch(() => {}); }, [root]);
  const imported = (summary: string) => { setDialog(''); onMessage(summary); void refresh(); };
  return <section className="settings-card github-card"><div className="section-heading"><h3><Github size={19} />GitHub & standard repository</h3><button className="icon-button" aria-label="Refresh GitHub connection" onClick={() => void perform(reload)}><RefreshCw size={15} className={checking ? 'spin' : ''} /></button></div>
    {!state ? <p className="muted">{checking ? 'Checking GitHub…' : ''}</p> : state.authenticated ? <><div className="github-identity"><span className="github-avatar"><Github size={21} /></span><div><b>{state.login}</b><small>Connected through GitHub CLI · credentials stay in its keyring</small></div><Badge status="connected" /></div>{state.repo && <div className="connected-repo"><FolderGit2 size={18} /><div><b>{state.repo.nameWithOwner}</b><small>{state.repo.isPrivate ? 'Private' : 'Public'} · {state.repo.defaultBranchRef?.name ?? 'No default branch'}</small></div>{state.repo.isPrivate && <Lock size={14} />}</div>}</> : <><p>{state.error}</p></>}
    <div className="standard-state"><Check size={15} /><span>{standard?.standard ? `Kiln standard v1 · infrastructure v${standard.infrastructureVersion}` : 'This library has not adopted the shared repository infrastructure.'}</span></div>
    <div className="wrap-actions"><button className="button" onClick={onSetup}><FolderGit2 size={15} />Create or connect a Kiln repository…</button><button className="button" onClick={() => setDialog('local')}><Download size={15} />Import my installed skills</button><button className="button" onClick={() => setDialog('repository')}><Upload size={15} />Import from a skills repository…</button><button className="button" onClick={() => void perform(async () => { setInfra(await api('repository.infrastructurePlan')); setDialog('infrastructure'); })}>Review infrastructure update</button></div>
    <p className="muted small">Your Kiln repository holds only what Kiln approves. Skills installed on this machine or kept in another repository come in as drafts; approve the ones you want on GitHub.</p>
    {dialog === 'local' && <LocalSkillsDialog onClose={() => setDialog('')} onDone={imported} />}
    {dialog === 'repository' && <RepositorySkillsDialog onClose={() => setDialog('')} onDone={imported} />}
    {dialog === 'infrastructure' && infra && <Modal title="Standard infrastructure update" subtitle={`Kiln infrastructure v${infra.version}. Skill content is outside this update.`} onClose={() => setDialog('')}><div className="file-preview-list">{infra.files.map(file => <div key={file.relative}><code>{file.relative}</code><Badge status={file.blocked ? 'blocked' : file.operation} /></div>)}</div><div className="modal-actions"><button className="button primary" disabled={infra.files.some(f => f.blocked)} onClick={() => void perform(async () => { await api('repository.upgrade', { expect: infra.hash, confirm: true }); await reload(); setDialog(''); }, 'Standard infrastructure updated')}>Apply reviewed update</button></div></Modal>}
  </section>;
}
