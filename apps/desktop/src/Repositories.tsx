import { useEffect, useState } from 'react';
import { ArrowLeft, Eye, Github, Loader2, Lock, Plus, Sparkles, TriangleAlert, X } from 'lucide-react';
import { api } from './api';
import { agentStarted } from './AgentPanel';
import { InlineError, Modal, providerName } from './components';
import { LoadError, useLoad, Waiting } from './Loading';
import { Markdown } from './Markdown';
import { parseGitHubRepo } from '../../../packages/domain/github-url';
import type { Registry, RepoEntry, RepoImportResult, RepoScan } from '../../../packages/domain/repo-import';
import type { Item, RunProviderId } from '../../../packages/protocol/schema';
import './repos.css';

/** Where the repositories dialog opens: the public list, the user's own repositories, or the review of one repository link. */
export type RepositoriesStart = { view: 'browse' } | { view: 'mine' } | { view: 'review'; url: string };
type Repo = { nameWithOwner: string; url: string; isPrivate: boolean; description: string };
type Preview = { content: string; files: string[] } | string;
type Mine = { repos: Repo[] | null; filter: string; chosen: Set<string>; results: Record<string, RepoScan | string | null> };

const short = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^[A-Z_]+: /, '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** `owner/repo`, plus the folder a tree link points at. */
const label = (url: string) => { const link = parseGitHubRepo(url); return link ? `${link.owner}/${link.repo}${link.rest ? ` · ${link.rest}` : ''}` : url; };
/** A SKILL.md's frontmatter, shown as it is, and the Markdown body after it. */
const frontmatter = (content: string) => content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
const body = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
const entries = (scan: RepoScan) => [...scan.skills, ...scan.agents];
/** One line per repository in "Scan my GitHub repositories": how its skills compare with the library. */
function tally(scan: RepoScan) {
  const all = entries(scan); if (!all.length) return 'No skills or agents';
  const count = (status: RepoEntry['status']) => all.filter(e => e.status === status).length;
  return [plural(scan.skills.length, 'skill') + (scan.agents.length ? `, ${plural(scan.agents.length, 'agent')}` : ''), count('new') && `${count('new')} new`, count('differs') && `${count('differs')} differ`, count('identical') && `${count('identical')} in library`].filter(Boolean).join(' · ');
}
function Status({ entry }: { entry: RepoEntry }) {
  if (entry.error) return <span className="badge blocked" title={entry.error}>unreadable</span>;
  if (entry.status === 'new') return <span className="badge create">new</span>;
  const other = `“${entry.match?.title}”`;
  if (entry.status === 'identical') return <span className="badge imported" title={`Same as ${other} in your library${entry.match?.against === 'approved' ? ' (its approved revision)' : ''}`}>in library</span>;
  return <span className="badge differs" title={`Differs from ${other}${entry.match?.edited ? ', which you edited in Kiln' : ''}. ${entry.match?.sameSource ? 'Importing adds it to that item as a new draft revision.' : 'Importing adds a separate copy.'}`}>{entry.match?.against === 'approved' ? 'differs from approved' : 'differs'}</span>;
}

/**
 * Skills and agents from GitHub repositories, in one dialog with three views: Browse skill repositories (a curated, editable
 * list of public ones), Scan my GitHub repositories, and the review of one repository. Review lists what a scan found with a
 * checkbox each (offered ones ticked), a preview, and how each compares with the library; it imports the ticked ones as drafts
 * into a collection named after the repository, and "Dig deeper" asks an agent to read the repository for skills it does not package.
 */
export function RepositoriesDialog({ start, provider, onClose, onDone }: { start: RepositoriesStart; /** The agent Dig deeper runs; the Settings default when absent. */ provider?: RunProviderId; onClose: () => void; /** After an import or a started run; `sourceId` is the repository's source item. */ onDone: (summary: string, sourceId?: string) => void | Promise<void> }) {
  const [stack, setStack] = useState<RepositoriesStart[]>([start]);
  const [mine, setMine] = useState<Mine>({ repos: null, filter: '', chosen: new Set(), results: {} });
  const view = stack.at(-1)!, push = (next: RepositoriesStart) => setStack(current => [...current, next]);
  const back = stack.length > 1 ? () => setStack(current => current.slice(0, -1)) : undefined;
  if (view.view === 'review') return <Review key={view.url} url={view.url} provider={provider} onBack={back} onClose={onClose} onDone={onDone} />;
  if (view.view === 'mine') return <MyRepositories state={mine} setState={setMine} onReview={url => push({ view: 'review', url })} onBack={back} onClose={onClose} />;
  return <Browse onScan={url => push({ view: 'review', url })} onMine={() => push({ view: 'mine' })} onClose={onClose} />;
}

function Review({ url, provider, onBack, onClose, onDone }: { url: string; provider?: RunProviderId; onBack?: () => void; onClose: () => void; onDone: (summary: string, sourceId?: string) => void | Promise<void> }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState<'' | 'import' | 'dig'>('');
  const [chosen, setChosen] = useState<Set<string>>(new Set()), [collection, setCollection] = useState(''), [open, setOpen] = useState(''), [previews, setPreviews] = useState<Record<string, Preview>>({});
  const scanning = useLoad(async () => { const result = await api<RepoScan>('repos.scan', { url }); setCollection(result.collection); setChosen(new Set(entries(result).filter(e => e.selected).map(e => e.key))); return result; }, [url]), scan = scanning.data;
  const all = scan ? entries(scan) : [], offered = all.filter(e => !e.error && e.status !== 'identical');
  const toggle = (key: string) => setChosen(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const preview = (entry: RepoEntry) => {
    if (open === entry.key) { setOpen(''); return; }
    setOpen(entry.key);
    if (!previews[entry.key]) void api<{ content: string; files: string[] }>('repos.preview', { url, key: entry.key }).then(p => setPreviews(current => ({ ...current, [entry.key]: p }))).catch(e => setPreviews(current => ({ ...current, [entry.key]: short(e) })));
  };
  const agent = provider ? providerName[provider] : 'The agent';
  const run = async (dig: boolean) => {
    if (!scan) return;
    setBusy(dig ? 'dig' : 'import'); setError('');
    let result: RepoImportResult | null = null;
    try {
      if (chosen.size) result = await api<RepoImportResult>('repos.import', { url, select: [...chosen], collection: collection.trim() || scan.collection, confirm: true });
      const done = result ? [`${result.imported.length} imported as drafts`, result.updated.length && `${result.updated.length} updated with a new revision`, result.unchanged.length && `${result.unchanged.length} already in the library`, result.failed.length && `${result.failed.length} failed: ${result.failed.map(f => short(f.error)).join('; ')}`].filter(Boolean).join(', ') : '';
      let sourceId = result?.sourceItemId;
      if (dig) {
        try {
          sourceId ??= (await api<Item>('repos.source', { url, collection: collection.trim() || scan.collection })).id;
          await api('agent.start', { id: sourceId, kind: 'distill-repo', ...(provider ? { provider } : {}) }); agentStarted('distill-repo');
        } catch (e) { if (!result) throw e; await onDone(`${scan.name}: ${done}. Dig deeper did not start: ${short(e)}`, sourceId); return; }
      }
      await onDone(`${scan.name}: ${[done, dig && 'digging deeper, progress in the status bar'].filter(Boolean).join('; ')}.`, sourceId);
    } catch (e) { setError(short(e)); setBusy(''); }
  };
  const rows = (list: RepoEntry[], heading: string) => list.length > 0 && <>
    {scan!.skills.length > 0 && scan!.agents.length > 0 && <div className="repo-group">{heading}</div>}
    {list.map(entry => { const p = previews[entry.key]; return <div key={entry.key}>
      <div className={`repo-row ${open === entry.key ? 'open' : ''}`}>
        <label className="repo-check" title={entry.path || 'The repository root'}><input type="checkbox" disabled={Boolean(entry.error) || entry.status === 'identical' || Boolean(busy)} checked={chosen.has(entry.key)} onChange={() => toggle(entry.key)} /><span className="repo-title">{entry.title}</span>{entry.provider && <span className="repo-meta">{providerName[entry.provider]}</span>}</label>
        {entry.validation.length > 0 && <span className="repo-warn" title={entry.validation.join('\n')}><TriangleAlert size={12} /></span>}
        <Status entry={entry} />
        <button type="button" className="icon-button" aria-label={`Preview ${entry.title}`} aria-expanded={open === entry.key} disabled={Boolean(entry.error)} onClick={() => preview(entry)}><Eye size={14} /></button>
      </div>
      {open === entry.key && <div className="repo-preview">{typeof p === 'string' ? <p className="error-box">{p}</p> : !p ? <p className="muted small">Reading…</p> : <>{p.files.length > 0 && <p className="muted small">Bundled: {p.files.join(', ')}</p>}{frontmatter(p.content) && <pre className="repo-front">{frontmatter(p.content)}</pre>}<Markdown>{body(p.content)}</Markdown></>}</div>}
    </div>; })}
  </>;
  const facts = scan ? [scan.scope || scan.ref, scan.licence === 'Unknown' ? 'No licence found' : scan.licence, `at ${scan.commit.slice(0, 7)}`].filter(Boolean).join(' · ') : 'Fetching the latest commit…';
  return <Modal title={scan?.name ?? label(url)} subtitle={facts} onClose={() => { if (!busy) onClose(); }} wide>
    <InlineError error={error} />
    {!scan ? scanning.error ? <LoadError error={scanning.error} onRetry={scanning.retry} /> : <Waiting since={scanning.since} label="Scanning the repository">Scanning the repository. Nothing is imported until you choose.</Waiting> : <>
      <p className="repo-found"><b>{plural(scan.skills.length, 'skill')}, {plural(scan.agents.length, 'agent')} found</b>{scan.instructions.length > 0 && <span className="muted"> · also {scan.instructions.slice(0, 3).join(', ')}{scan.instructions.length > 3 ? ` and ${scan.instructions.length - 3} more` : ''}</span>}{scan.truncated && <span className="muted"> · very large, scan stopped early</span>}</p>
      {all.length > 0 && <div className="repo-list">{rows(scan.skills, 'Skills')}{rows(scan.agents, 'Agents')}</div>}
      <label className="repo-collection"><span>Collection</span><input value={collection} disabled={Boolean(busy)} onChange={e => setCollection(e.target.value)} aria-label="Collection" /></label>
      <p className="repo-dig"><Sparkles size={14} /><span><b>{all.length ? `${plural(scan.skills.length, 'skill')} found. ` : 'Nothing packaged here. '}Dig deeper?</b> {agent} reads the README, docs, scripts and CI read-only and proposes new skills and entries.</span></p>
      <div className="modal-actions">
        <span className="muted small">{offered.length ? `${chosen.size} of ${offered.length} selected` : all.length ? 'Everything here is already in your library' : ''}</span>
        {offered.length > 0 && <button type="button" className="text-button" disabled={Boolean(busy)} onClick={() => setChosen(chosen.size === offered.length ? new Set() : new Set(offered.map(e => e.key)))}>{chosen.size === offered.length ? 'Select none' : 'Select all'}</button>}
        {onBack && <button type="button" className="button" disabled={Boolean(busy)} onClick={onBack}><ArrowLeft size={14} />Back</button>}
        <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void run(true)}>{busy === 'dig' ? 'Starting…' : chosen.size ? `Import ${chosen.size} & dig deeper` : 'Dig deeper'}</button>
        <button type="button" className="button primary" disabled={!chosen.size || Boolean(busy)} onClick={() => void run(false)}>{busy === 'import' ? 'Importing…' : `Import ${chosen.size}`}</button>
      </div>
    </>}
  </Modal>;
}

function Browse({ onScan, onMine, onClose }: { onScan: (url: string) => void; onMine: () => void; onClose: () => void }) {
  const [adding, setAdding] = useState(''), [error, setError] = useState('');
  const reading = useLoad(() => api<Registry[]>('repos.registries'), []), list = reading.data, setList = reading.setData;
  const save = (next: Registry[]) => api<Registry[]>('repos.saveRegistries', { repositories: next }).then(saved => { setList(saved); setError(''); return true; }).catch(e => { setError(short(e)); return false; });
  const add = () => { const url = adding.trim(); if (!parseGitHubRepo(url)) { setError('Paste a GitHub repository link such as https://github.com/owner/repo.'); return; } void save([...(list ?? []), { url, description: '' }]).then(ok => { if (ok) setAdding(''); }); };
  return <Modal title="Browse skill repositories" subtitle="Well-known public repositories of skills. Scan one to review and preview its skills before importing any." onClose={onClose} wide>
    <InlineError error={error} />
    {!list ? reading.error ? <LoadError error={reading.error} onRetry={reading.retry} /> : <Waiting since={reading.since} label="Reading the list">Reading the list…</Waiting> : <div className="repo-list">{list.map(r => <div key={r.url} className="repo-row">
      <button type="button" className="repo-title repo-link" title={r.url} onClick={() => onScan(r.url)}>{label(r.url)}</button>
      <span className="repo-desc" title={r.description}>{r.description}</span>
      <button type="button" className="button small" onClick={() => onScan(r.url)}>Scan</button>
      <button type="button" className="icon-button" aria-label={`Remove ${label(r.url)}`} title="Remove from this list" onClick={() => void save(list.filter(other => other !== r))}><X size={13} /></button>
    </div>)}{!list.length && <div className="repo-row"><span className="muted">The list is empty. Add a repository below.</span></div>}</div>}
    <form className="repo-add" onSubmit={e => { e.preventDefault(); add(); }}><input value={adding} onChange={e => setAdding(e.target.value)} placeholder="Add a GitHub repository link" aria-label="Repository link" /><button type="submit" className="button" disabled={!adding.trim()}><Plus size={14} />Add</button></form>
    <div className="modal-actions"><button type="button" className="text-button" onClick={onMine}><Github size={13} />Scan my GitHub repositories</button><span className="repo-grow" /><button type="button" className="button" onClick={onClose}>Close</button></div>
  </Modal>;
}

function MyRepositories({ state, setState, onReview, onBack, onClose }: { state: Mine; setState: (update: (current: Mine) => Mine) => void; onReview: (url: string) => void; onBack?: () => void; onClose: () => void }) {
  const [error, setError] = useState(''), [scanning, setScanning] = useState(false), [since, setSince] = useState<number | null>(null);
  const readRepos = () => { setError(''); setSince(Date.now()); void api<Repo[]>('repos.mine').then(repos => setState(current => ({ ...current, repos }))).catch(e => setError(short(e))).finally(() => setSince(null)); };
  useEffect(() => { if (!state.repos) readRepos(); }, []);
  const words = state.filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (state.repos ?? []).filter(r => words.every(w => `${r.nameWithOwner} ${r.description ?? ''}`.toLowerCase().includes(w)));
  const toggle = (name: string) => setState(current => { const chosen = new Set(current.chosen); if (chosen.has(name)) chosen.delete(name); else chosen.add(name); return { ...current, chosen }; });
  const result = (name: string, value: RepoScan | string | null) => setState(current => ({ ...current, results: { ...current.results, [name]: value } }));
  // Two at a time: each scan is one shallow fetch.
  const scanChosen = async () => {
    setScanning(true); const queue = [...state.chosen];
    await Promise.all([0, 1].map(async () => { for (let name = queue.shift(); name; name = queue.shift()) { result(name, null); try { result(name, await api<RepoScan>('repos.scan', { url: `https://github.com/${name}` })); } catch (e) { result(name, short(e)); } } }));
    setScanning(false);
  };
  const allShown = shown.length > 0 && shown.every(r => state.chosen.has(r.nameWithOwner));
  return <Modal title="Scan my GitHub repositories" subtitle="Your repositories, scanned one commit at a time. Each shows which skills are new, already in the library, or differ from a library item." onClose={() => { if (!scanning) onClose(); }} wide>
    <input className="setup-filter" placeholder="Filter repositories" value={state.filter} onChange={e => { const filter = e.target.value; setState(current => ({ ...current, filter })); }} aria-label="Filter repositories" />
    {!state.repos ? error ? <LoadError error={error} onRetry={readRepos} /> : <Waiting since={since} label="Reading your repositories">Reading your repositories…</Waiting> : <div className="repo-list">{shown.map(repo => { const found = state.results[repo.nameWithOwner]; return <div key={repo.nameWithOwner} className="repo-row">
      <label className="repo-check" title={repo.description || repo.url}><input type="checkbox" disabled={scanning} checked={state.chosen.has(repo.nameWithOwner)} onChange={() => toggle(repo.nameWithOwner)} /><span className="repo-title">{repo.nameWithOwner}</span>{repo.isPrivate && <Lock size={11} className="muted" aria-label="Private" />}</label>
      <span className="repo-desc">{found === null ? <><Loader2 size={12} className="spin" /> Scanning…</> : typeof found === 'string' ? <span className="repo-error" title={found}>{found}</span> : found ? tally(found) : ''}</span>
      {found && typeof found === 'object' && <button type="button" className="button small" onClick={() => onReview(`https://github.com/${repo.nameWithOwner}`)}>Review</button>}
    </div>; })}{!shown.length && <div className="repo-row"><span className="muted">No repositories match.</span></div>}</div>}
    <div className="modal-actions">
      <span className="muted small">{state.chosen.size} selected{state.repos && state.repos.length >= 100 ? ' · the 100 most recent' : ''}</span>
      {shown.length > 0 && <button type="button" className="text-button" disabled={scanning} onClick={() => setState(current => { const chosen = new Set(current.chosen); for (const r of shown) { if (allShown) chosen.delete(r.nameWithOwner); else chosen.add(r.nameWithOwner); } return { ...current, chosen }; })}>{allShown ? 'Select none' : 'Select all'}</button>}
      {onBack && <button type="button" className="button" disabled={scanning} onClick={onBack}><ArrowLeft size={14} />Back</button>}
      <button type="button" className="button primary" disabled={!state.chosen.size || scanning} onClick={() => void scanChosen()}>{scanning ? 'Scanning…' : `Scan ${state.chosen.size || ''}`}</button>
    </div>
  </Modal>;
}
