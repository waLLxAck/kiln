import { useEffect, useState } from 'react';
import { ArrowRight, Check, Download, ExternalLink, FolderGit2, Github, Loader2, Plus, RefreshCw, Upload } from 'lucide-react';
import type { Provider, ProviderId, Snapshot, Target } from '../../../packages/protocol/schema';
import type { DefaultRepository, GitHubState } from '../../../packages/git/github';
import { api } from './api';
import { Field, InlineError, KilnMark } from './components';
import { LocalAgentsDialog, LocalSkillsDialog, RepositorySkillsDialog } from './Import';

import { SkillLocationSettings, ScanDialog } from './Skills';
import { unmanagedSourceFolders } from './skill-folders';
import { joinAnd } from './item-source';
import { skillLocationLabel } from '../../../packages/providers/skill-locations';

type Repo = { nameWithOwner: string; url: string; isPrivate: boolean; description: string };
type Inspection = { root: string; exists: boolean; kiln: boolean; git: boolean; remote: string; items: number };
/** The library Kiln was pointed at before setup began, so its items can be carried over. */
export type PreviousLibrary = { root: string; items: number; standard: boolean; dedicated: boolean } | null;
type Props = { snapshot: Snapshot; previous: PreviousLibrary; /** Attach a repository; the app stays on this screen until `onDone`. */ onAttach: (root: string) => Promise<void>; onRefresh: () => Promise<void>; providers: Provider[]; onSetLocation: (provider: Provider, on: boolean, native?: boolean) => Promise<void>; onDone: (review?: boolean) => Promise<void> };

const short = (message: string) => message.replace(/^[A-Z_]+: /, '');
const why = (state: Snapshot['repository']) => !state.standard ? 'This folder is not a Kiln repository.' : !state.dedicated ? 'This is a skills repository, not a Kiln repository.' : !state.git ? 'This folder is not a Git repository.' : 'This repository has no GitHub remote yet.';
/**
 * First-launch (and any-time-unready) flow. Kiln keeps every approval in a GitHub repository it owns,
 * so nothing else works until one is connected: sign in through GitHub CLI, create or open a Kiln repo, then bring in existing skills.
 */
export function Setup({ snapshot, previous, onAttach, onRefresh, providers, onSetLocation, onDone }: Props) {
  const [github, setGithub] = useState<GitHubState | null>(null), [checking, setChecking] = useState(false);
  const [login, setLogin] = useState<{ active: boolean; message: string }>({ active: false, message: '' });
  const [discovery, setDiscovery] = useState<{ loading: boolean; result: DefaultRepository; error: string }>({ loading: false, result: null, error: '' });
  const [alternative, setAlternative] = useState(false);
  const [mode, setMode] = useState<'create' | 'github'>('create');
  const [name, setName] = useState('my-kiln'), [parent, setParent] = useState(''), [visibility, setVisibility] = useState('private');
  const [existing, setExisting] = useState<Inspection | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null), [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [dialog, setDialog] = useState<'' | 'local' | 'repository' | 'agents'>(''), [imported, setImported] = useState<string[]>([]);
  const [scanTarget, setScanTarget] = useState<{ provider: ProviderId; target: Target } | null>(null);
  // Skill folders brought in by "Import my installed skills". While their folder is not managed, those skills read "Not installed".
  const [sources, setSources] = useState<string[]>([]), [managed, setManaged] = useState('');
  const importedDone = async (summary: string, paths: string[] = []) => { await onRefresh(); setImported(list => [...list, summary]); setSources(list => [...new Set([...list, ...paths])]); setDialog(''); };
  const unmanaged = unmanagedSourceFolders(sources, providers, snapshot.targets);
  const manageSources = () => run('locations', async () => {
    for (const folder of unmanaged) await onSetLocation(folder.provider, true, folder.native);
    setManaged(`Kiln now manages ${joinAnd(unmanaged.map(f => f.folder))}. Nothing was installed or changed; identical copies already there show as found.`);
  });
  const ready = snapshot.repository.ready;
  const [changing, setChanging] = useState(false);
  useEffect(() => { setChanging(false); }, [snapshot.root]);
  useEffect(() => { void api<string>('repository.defaultParent').then(value => setParent(current => current || value)).catch(() => {}); }, []);
  const check = async () => { setChecking(true); try { setGithub(await api<GitHubState>('github.status')); } catch (e) { setError(short(String(e))); } finally { setChecking(false); } };
  useEffect(() => { void check(); }, []);
  useEffect(() => {
    if (!login.active) return;
    const timer = setInterval(() => void api<{ status: string; message: string }>('github.loginStatus').then(result => { setLogin({ active: result.status === 'waiting', message: result.message }); if (result.status === 'complete') void check(); }), 2000);
    return () => clearInterval(timer);
  }, [login.active]);
  useEffect(() => {
    if (!github?.authenticated || (ready && !changing)) return;
    let active = true;
    setAlternative(false);
    setRepos(null);
    setDiscovery({ loading: true, result: null, error: '' });
    void api<DefaultRepository>('github.defaultRepository').then(result => {
      if (active) setDiscovery({ loading: false, result, error: '' });
    }).catch(error => { if (active) setDiscovery({ loading: false, result: null, error: short(String(error)) }); });
    return () => { active = false; };
  }, [github, ready, changing]);
  const run = async (label: string, action: () => Promise<void>) => { setBusy(label); setError(''); try { await action(); } catch (e) { setError(short(e instanceof Error ? e.message : String(e))); } finally { setBusy(''); } };
  const choose = async () => { const folder = await api<string | null>('desktop.chooseDirectory'); if (folder) setParent(folder); };
  const publishAndAttach = async (root: string) => { await api('github.publish', { root, name, visibility, confirm: true }); await onAttach(root); };
  /** Create new: an empty spot gets a fresh repository; a Kiln repository already there is offered for reuse; anything else needs another name. */
  const create = () => run('create', async () => {
    if (discovery.result && name.toLowerCase() === 'my-kiln') throw new Error('my-kiln already exists on your GitHub account. Choose another repository name.');
    setExisting(null);
    const found = await api<Inspection>('repository.inspect', { parent, name });
    if (found.exists) {
      if (!found.kiln) throw new Error(`${found.root} already exists and is not a Kiln repository. Choose another name or folder.`);
      setExisting(found); return;
    }
    const result = await api<{ root: string; committed: boolean; message: string }>('repository.create', { parent, name });
    if (!result.committed) throw new Error(result.message);
    await publishAndAttach(result.root);
  });
  const useExisting = () => run('create', async () => { if (!existing) return; if (existing.remote) await onAttach(existing.root); else await publishAndAttach(existing.root); setExisting(null); });
  const loadRepos = () => run('repos', async () => setRepos(await api<Repo[]>('github.kilnRepositories')));
  const clone = (repo: Repo) => run(repo.nameWithOwner, async () => {
    const result = await api<{ root: string; standard: boolean; dedicated: boolean }>('github.clone', { repo: repo.nameWithOwner, parent });
    if (!result.dedicated) throw new Error(`${repo.nameWithOwner} is not a Kiln repository. Import its skills in the last step instead.`);
    await onAttach(result.root);
  });
  const publishCurrent = () => run('publish', async () => { await api('github.publish', { root: snapshot.root, name: snapshot.root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'kiln', visibility, confirm: true }); await onAttach(snapshot.root); });
  const signedIn = Boolean(github?.authenticated);
  const filtered = (repos ?? []).filter(r => !filter.trim() || r.nameWithOwner.toLowerCase().includes(filter.toLowerCase()));
  const publishable = snapshot.repository.standard && snapshot.repository.dedicated && snapshot.repository.git && !snapshot.repository.remote;
  const step = (n: number, done: boolean) => <span className={`setup-number ${done ? 'done' : ''}`}>{done ? <Check size={14} /> : n}</span>;

  return <div className="setup"><div className="setup-column">
    <header className="setup-hero"><span className="brand-symbol"><KilnMark /></span><div><h1>{ready ? 'Your Kiln repository is ready' : 'Set up your Kiln repository'}</h1><p>Kiln keeps your approved prompts and skills in a GitHub repository it manages. Approving something commits and pushes it there; only approved items can be installed. Drafts stay on this machine until you approve them.</p></div></header>
    {!ready && snapshot.root && (previous?.items || snapshot.repository.standard) ? <div className="notice warning"><b>{why(snapshot.repository)}</b><p>Kiln is currently pointed at <code>{snapshot.root}</code>{previous?.items ? ` with ${previous.items} item${previous.items === 1 ? '' : 's'}` : ''}. {publishable ? 'Publish it to GitHub below, or connect a different repository.' : snapshot.repository.standard && !snapshot.repository.dedicated ? 'Kiln keeps approved skills in a repository of its own. Create one below, then import this repository’s skills as drafts in the last step.' : previous?.items ? 'Connect a Kiln repository below; you can bring these items over at the end.' : 'Connect a Kiln repository below.'}</p>{publishable && signedIn && <button className="button primary" disabled={Boolean(busy)} onClick={publishCurrent}><Github size={15} />Publish this repository to GitHub ({visibility})</button>}{publishable && !signedIn && <p>Sign in with GitHub first (step 1) to publish it.</p>}</div> : null}
    <InlineError error={error} />

    <section className="setup-step"><div className="setup-step-head">{step(1, signedIn)}<h2>Connect GitHub</h2>{github && <button className="icon-button" aria-label="Check GitHub again" onClick={() => void check()}><RefreshCw size={15} className={checking ? 'spin' : ''} /></button>}</div>
      {!github ? <p className="muted">{checking ? 'Checking for GitHub CLI…' : 'Checking…'}</p>
        : !github.available ? <><p>Kiln uses the official GitHub CLI for sign-in, so your credentials stay in its keyring and never pass through Kiln.</p><div className="wrap-actions"><button className="button primary" onClick={() => void api('desktop.openUrl', { url: 'https://cli.github.com/' })}><ExternalLink size={15} />Get GitHub CLI</button><button className="button" disabled={checking} onClick={() => void check()}>I installed it, check again</button></div></>
        : !github.authenticated ? <><p>{github.error}</p><div className="wrap-actions"><button className="button primary" disabled={login.active} onClick={() => void run('login', async () => { const started = await api<{ message: string }>('github.login'); setLogin({ active: true, message: started.message }); })}><Github size={15} />{login.active ? 'Waiting for GitHub…' : 'Sign in with GitHub'}</button><button className="button" disabled={checking} onClick={() => void check()}>Check again</button></div>{login.active && <pre className="prompt-preview">{login.message || 'Opening GitHub device sign-in in your browser…'}</pre>}</>
        : <div className="github-identity"><span className="github-avatar"><Github size={21} /></span><div><b>{github.login}</b><small>Signed in through GitHub CLI</small></div></div>}
    </section>

    <section className={`setup-step ${signedIn ? '' : 'disabled'}`}><div className="setup-step-head">{step(2, ready)}<h2>Your Kiln repository</h2></div>
      {ready && !changing ? <div className="connected-repo"><FolderGit2 size={18} /><div><b>{snapshot.git.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}</b><small>{snapshot.root}</small></div><button className="text-button" onClick={() => setChanging(true)}>Change</button></div> : <>
        <p>One repository, created by Kiln, holds everything you approve. Create it now, or open the one Kiln created for you before.</p>
        {signedIn && discovery.loading && <p role="status">Checking your GitHub account for my-kiln…</p>}
        {signedIn && discovery.error && <div className="notice warning"><b>Could not check for my-kiln</b><p>{discovery.error}</p><button className="button" onClick={() => void check()}>Try again</button></div>}
        {signedIn && discovery.result && !alternative && <div className="notice"><b>{discovery.result.dedicated ? 'Your Kiln repository was found' : 'The name my-kiln is already in use'}</b><p>{discovery.result.repo.nameWithOwner} · {discovery.result.repo.isPrivate ? 'Private' : 'Public'}</p>{discovery.result.dedicated ? <><p>Use this repository to bring your approved library onto this machine.</p><Field label="Keep the local copy under"><div className="input-button"><input value={parent} onChange={e => setParent(e.target.value)} /><button className="button" onClick={() => void choose()}>Browse</button></div></Field></> : <p>This repository is not a Kiln library. Choose another name or open a different Kiln repository.</p>}<div className="wrap-actions">{discovery.result.dedicated && <button className="button primary" disabled={!parent || Boolean(busy)} onClick={() => void clone(discovery.result!.repo)}>{busy ? 'Opening…' : 'Use this repository'}</button>}<button className="button" disabled={Boolean(busy)} onClick={() => { setAlternative(true); setName('my-kiln-2'); }}>Use something else</button></div></div>}
        {(!signedIn || (!discovery.loading && (!discovery.result || alternative))) && <>
        <div className="setup-choice" role="tablist">{([['create', 'Create new', Plus], ['github', 'Open from GitHub', Github]] as const).map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={mode === id} className={mode === id ? 'active' : ''} disabled={!signedIn} onClick={() => { setMode(id); setExisting(null); if (id === 'github' && repos === null) void loadRepos(); }}><Icon size={15} />{label}</button>)}</div>
        {mode === 'create' && !existing && <form onSubmit={e => { e.preventDefault(); void create(); }}><div className="form-grid"><Field label="Repository name"><input required value={name} onChange={e => setName(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,99}" disabled={!signedIn} /></Field><Field label="GitHub visibility"><select value={visibility} onChange={e => setVisibility(e.target.value)} disabled={!signedIn}><option value="private">Private · recommended</option><option value="public">Public · anyone can read</option></select></Field></div><Field label="Keep the local copy under" hint="A folder with the repository name is created inside it."><div className="input-button"><input required value={parent} onChange={e => setParent(e.target.value)} placeholder="Choose a parent folder" disabled={!signedIn} /><button type="button" className="button" disabled={!signedIn} onClick={() => void choose()}>Browse</button></div></Field><div className="modal-actions"><button className="button primary" type="submit" disabled={!signedIn || Boolean(busy)}>{busy === 'create' ? <Loader2 size={15} className="spin" /> : <Github size={15} />}Create {visibility} repository on GitHub</button></div></form>}
        {mode === 'create' && existing && <div className="notice"><b>A Kiln repository is already at {existing.root}</b><p>{existing.remote ? `It is connected to ${existing.remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}${existing.items ? ` and holds ${existing.items} item${existing.items === 1 ? '' : 's'}` : ''}.` : `It was prepared earlier but never reached GitHub${existing.items ? ` and holds ${existing.items} item${existing.items === 1 ? '' : 's'}` : ''}.`} Use it, or go back and choose another name.</p><div className="wrap-actions"><button className="button primary" disabled={Boolean(busy)} onClick={useExisting}>{busy === 'create' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}{existing.remote ? 'Use this repository' : `Use it and publish to GitHub (${visibility})`}</button><button className="button" onClick={() => setExisting(null)}>Choose another name</button></div></div>}
        {mode === 'github' && <><p>Only repositories Kiln created appear here. A skills repository of your own is imported in the last step instead.</p><Field label="Clone into" hint="A folder with the repository name is created inside it."><div className="input-button"><input value={parent} onChange={e => setParent(e.target.value)} placeholder="Choose a parent folder" /><button type="button" className="button" onClick={() => void choose()}>Browse</button></div></Field>{repos === null ? <p className="muted"><Loader2 size={13} className="spin" /> Looking through your GitHub repositories for Kiln ones…</p> : <>{repos.length > 4 && <input className="setup-filter" placeholder="Filter repositories" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter repositories" />}<div className="inventory-list">{filtered.map(repo => <div key={repo.nameWithOwner}><div><b>{repo.nameWithOwner}</b><p className="small muted">{repo.isPrivate ? 'Private' : 'Public'}{repo.description ? ` · ${repo.description}` : ''}</p></div><button className="button" disabled={!parent || Boolean(busy)} onClick={() => void clone(repo)}>{busy === repo.nameWithOwner ? 'Cloning…' : 'Clone & open'}</button></div>)}{!repos.length && <div><span className="muted">No Kiln repositories in your account yet. Create one instead.</span></div>}{repos.length > 0 && !filtered.length && <div><span className="muted">No repositories match.</span></div>}</div><button className="text-button" onClick={() => void loadRepos()} disabled={Boolean(busy)}><RefreshCw size={12} /> Look again</button></>}</>}
        </>}
      </>}
    </section>

    <section className={`setup-step ${ready ? '' : 'disabled'}`}><div className="setup-step-head">{step(3, snapshot.targets.length > 0)}<h2>Choose your providers and folders <small>optional</small></h2></div>
      <p>Choose the folders you want to manage for your clients. You can import existing skills and agent definitions before installing anything.</p>
      <fieldset disabled={!ready || Boolean(busy)} style={{ border: 0, padding: 0, margin: 0 }}><SkillLocationSettings providers={providers} targets={snapshot.targets} onSet={(provider, on, native) => void run('locations', () => onSetLocation(provider, on, native))} onScan={(provider, target) => setScanTarget({ provider, target })} /></fieldset>
    </section>
    <section className={`setup-step ${ready ? '' : 'disabled'}`}><div className="setup-step-head">{step(4, imported.length > 0)}<h2>Bring in the skills and agents you already have <small>optional</small></h2></div>
      <p>Everything comes in as a draft; approve the ones you want on GitHub. Nothing is moved or deleted where it lives now.</p>
      {imported.map(line => <div className="notice success" key={line}><Check size={14} /> {line}</div>)}
      {unmanaged.length > 0 && <div className="notice" data-testid="manage-sources"><b>Manage these folders so Kiln can show the copies already there</b><p>Kiln doesn’t manage {unmanaged.map((f, i) => <span key={f.folder}>{i === 0 ? '' : i === unmanaged.length - 1 ? ' and ' : ', '}<code>{f.folder}</code></span>)} yet, so the skills you imported from there read “Not installed”. Managing a folder only lets Kiln recognise what is in it: nothing is installed, moved or changed. You can turn this off in step 3 or in Settings.</p><button className="button primary" disabled={!ready || Boolean(busy)} onClick={manageSources}>{`Manage the ${joinAnd(unmanaged.map(f => skillLocationLabel[f.location]))} folder${unmanaged.length === 1 ? '' : 's'}`}</button></div>}
      {managed && !unmanaged.length && <div className="notice success"><Check size={14} /> {managed}</div>}
      <div className="wrap-actions"><button className="button primary" disabled={!ready || Boolean(busy)} onClick={() => setDialog('local')}><Download size={15} />Import my installed skills</button><button className="button" disabled={!ready || Boolean(busy)} onClick={() => setDialog('agents')}><Download size={15} />Import my agents</button><button className="button" disabled={!ready || Boolean(busy)} onClick={() => setDialog('repository')}><Upload size={15} />Import from a skills repository…</button></div>
      <p className="muted small">Discovery includes shared Agents, Claude, Codex-specific and Copilot skill folders, plus your configured locations. Agent imports discover Codex, Claude Code and Copilot definitions. A skills repository is a Git repository (or a clone of one) that holds SKILL.md folders; every skill in it is found, with its supporting and linked files.</p>
      <p>Review everything together in the library: select all or pick individual items to archive, move to trash, or preview removal of local copies. Approve drafts before letting Kiln manage their installed copies.</p><div className="setup-finish"><button className="button" disabled={!ready || Boolean(busy)} onClick={() => void run('finish', () => onDone(true))}>Review and bulk manage my library</button><button className="button primary" disabled={!ready || Boolean(busy)} onClick={() => void run('finish', () => onDone())}>Start using Kiln <ArrowRight size={15} /></button></div>
    </section>
    {scanTarget && <ScanDialog provider={providers.find(p => p.id === scanTarget.provider)!} target={scanTarget.target} onClose={() => setScanTarget(null)} onImported={onRefresh} />}
    {dialog === 'agents' && <LocalAgentsDialog onClose={() => setDialog('')} onDone={importedDone} />}
    {dialog === 'local' && <LocalSkillsDialog onClose={() => setDialog('')} onDone={importedDone} />}
    {dialog === 'repository' && <RepositorySkillsDialog initialSource={previous && previous.standard && !previous.dedicated ? previous.root : ''} onClose={() => setDialog('')} onDone={importedDone} />}
  </div></div>;
}
