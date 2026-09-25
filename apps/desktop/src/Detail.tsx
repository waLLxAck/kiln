import { Markdown } from './Markdown';
import { useScrollMemory } from './view-memory';
import { primarySkillLabel } from '../../../packages/providers/skill-locations';
import { AgentPanel, AgentStatus } from './AgentPanel';
import type { AgentJob, AgentKind } from '../../../packages/agent/service';
import { useEffect, useRef, useState } from 'react';
import { LineDiff } from './Diff';
import { ArrowRight, Check, Copy, Download, ExternalLink, FlaskConical, Folder, GitBranch, Github, History, Loader2, Pencil, Rocket, RotateCcw, ShieldCheck, Sparkles, Star, Trash2, TriangleAlert, ZoomIn } from 'lucide-react';
import type { Installation, ItemDetail, Provider, ProviderId, PublishJob, Revision, Snapshot, Trial } from '../../../packages/protocol/schema';
import { api, date, shortHash } from './api';
import { isTextFile } from '../../../packages/domain/text';
import { Badge, ContextMenu, Field, KindIcon, Lightbox, imageFile, imageSource, statusHelp } from './components';
import { Installations } from './Installations';
import { personalTarget, SkillToggles } from './Skills';

const publishPhase: Record<string, string> = { queued: 'Waiting to commit', composing: 'Writing the commit message', committing: 'Committing', pushing: 'Pushing to GitHub' };
/** Where this approval is on its way to GitHub: in progress, failed with a retry, or landed with its commit. */
function PublishState({ job, ahead, onRetry }: { job?: PublishJob; ahead: number; onRetry: () => void }) {
  if (job && !['done', 'failed'].includes(job.status)) return <span className="publish-state"><Loader2 size={12} className="spin" />{publishPhase[job.status] ?? job.status}…</span>;
  if (job?.status === 'failed') return <span className="publish-state failed"><TriangleAlert size={12} />Not on GitHub yet: {job.error} <button className="text-button" onClick={onRetry}>Retry</button></span>;
  if (job?.status === 'done') return <span className="publish-state done" title={job.message}><Github size={12} />On GitHub · {shortHash(job.commit)} · “{job.message.split('\n')[0]}”</span>;
  return <span className={`publish-state ${ahead ? '' : 'done'}`}><Github size={12} />{ahead ? 'Committed on this machine; push pending' : 'On GitHub'}</span>;
}

type Props = { jobs: AgentJob[]; detail: ItemDetail; snapshot: Snapshot; providers: Provider[]; installations: Installation[]; onAction: (name: string, trial?: Trial) => void; onToggleInstall: (provider: ProviderId, targetId?: string) => void; refresh: () => Promise<void>; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; onSelect: (id: string) => void; onSetup: () => void; onCollection: (name: string) => void };
function savedDraft(id: string): { content: string; base: string } | null {
  try { const value = JSON.parse(localStorage.getItem(`kiln-draft:${id}`) ?? 'null'); return value && typeof value.content === 'string' && typeof value.base === 'string' ? value : null; } catch { return null; }
}
const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
export function Detail({ jobs, detail, snapshot, providers, installations, onAction, onToggleInstall, refresh, perform, onSelect, onSetup, onCollection }: Props) {
  const { item, revision } = detail;
  const [tab, setTab] = useState(() => { const saved = localStorage.getItem('kiln-detail-tab'); return saved === 'deployments' ? 'installs' : saved ?? 'overview'; });
  const [raw, setRaw] = useState(false);
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(Boolean(savedDraft(item.id)));
  const [draft, setDraft] = useState(savedDraft(item.id)?.content ?? revision.content);
  const [base, setBase] = useState(savedDraft(item.id)?.base ?? revision.hash);
  const [compare, setCompare] = useState<Revision | null>(null);
  const [output, setOutput] = useState<{ output: string; reference: string; prompt: string } | null>(null);
  const [filePreview, setFilePreview] = useState<{ name: string; text: string } | null>(null);
  const [zoom, setZoom] = useState<{ name: string; src: string } | null>(null);
  useEffect(() => { const saved = savedDraft(item.id); setEditing(Boolean(saved)); setDraft(saved?.content ?? revision.content); setBase(saved?.base ?? revision.hash); setCompare(null); setOutput(null); setFilePreview(null); }, [item.id]);
  useEffect(() => { if (editing) localStorage.setItem(`kiln-draft:${item.id}`, JSON.stringify({ content: draft, base })); }, [draft, base, editing, item.id]);
  useEffect(() => { if (!editing) { setDraft(revision.content); setBase(revision.hash); } }, [revision.hash, editing]);
  const changeTab = (value: string) => { setTab(value); localStorage.setItem('kiln-detail-tab', value); };
  // Only skills and instruction files can be installed into agent folders, so other kinds do not get an Installs tab.
  const installable = ['skill', 'agent', 'instruction'].includes(item.kind);
  useEffect(() => { if (!installable && tab === 'installs') setTab('overview'); }, [installable, tab]);
  const scroll = useScrollMemory(`detail:${item.id}:${tab}`, true);
  // Agent results live in the tab they belong to (experiments under Trials, notes and skill drafts under Overview), so jump there when a run starts.
  const tabFor = (kind: AgentKind) => changeTab(kind === 'trial' ? 'trials' : 'overview');
  useEffect(() => { const jump = (event: Event) => { const kind = (event as CustomEvent<{ kind?: AgentKind }>).detail?.kind; if (kind) tabFor(kind); }; window.addEventListener('kiln:agent-started', jump); return () => window.removeEventListener('kiln:agent-started', jump); }, []);
  const approvals = detail.approvals.filter(a => a.revision === item.revision && a.trust === 'local');
  const trials = detail.trials.filter(t => t.revision === item.revision);
  const deployed = snapshot.receipts.filter(r => r.itemId === item.id);
  const copied = detail.observations.filter(o => o.kind === 'copied').length;
  const currentApproved = approvals.length > 0;
  const locations = providers.filter(p => (item.kind === 'agent' ? p.id === item.agent?.provider : p.id !== 'copilot') && personalTarget(snapshot.targets, providers, p.id));
  // The newest approved revision, when the current draft has moved past it.
  const lastApproved = detail.approvals.filter(a => a.trust === 'local').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const draftAfterApproval = !currentApproved && lastApproved && detail.revisions.some(r => r.hash === lastApproved.revision);
  const publishJob = snapshot.publish.find(j => j.itemId === item.id && j.revision === item.revision);
  const copies = installations.filter(copy => copy.itemId === item.id);
  const installedNames = [...new Set(copies.filter(copy => copy.state === 'installed').map(copy => { const target = snapshot.targets.find(target => target.id === copy.targetId); return copy.scope === 'project' ? target?.name ?? 'project folder' : copy.location === 'agents' ? 'Agents' : copy.provider === 'claude' ? 'Claude' : copy.provider === 'copilot' ? 'Copilot' : 'Codex'; }))];
  const changedCopies = copies.some(copy => copy.state !== 'installed');
  const images = Object.entries(revision.files).filter(([name]) => imageFile(name));
  const openFile = (name: string) => void perform(() => api('desktop.openAttachment', { id: item.id, relative: name }));
  return <article className="detail-pane" aria-label="Selected item">
    <header className="detail-heading"><div className="eyebrow"><KindIcon kind={item.kind} size={14} />{item.kind}<span className="dot">·</span><span title={`In the “${item.collection}” collection. Collections are folders you organise; the lifecycle state is the badge below.`}><Folder size={13} />{item.collection}</span></div><div className="title-row"><div><h1>{item.title}</h1>{item.description && <p className="item-lede">{item.description}</p>}</div><button className={`icon-button ${item.favourite ? 'favourited' : ''}`} aria-label={item.favourite ? 'Remove favourite' : 'Add favourite'} onClick={() => void perform(async () => { await api('items.meta', { id: item.id, expect: item.revision, favourite: !item.favourite }); await refresh(); })}><Star size={20} fill={item.favourite ? 'currentColor' : 'none'} /></button></div><div className="detail-meta"><Badge status={item.deletedAt ? 'deleted' : ['archived', 'rejected'].includes(item.status) ? item.status : currentApproved ? 'approved' : 'draft'} /><span>Updated {date(item.updatedAt)}</span></div>
      <div className="detail-actions">{item.deletedAt ? <><button className="button primary" onClick={() => void perform(async () => { await api('items.meta', { id: item.id, expect: item.revision, deleted: false }); await refresh(); }, 'Item restored')}><RotateCcw size={15} />Restore</button><button className="button danger-text" onClick={() => onAction('purge')}><Trash2 size={15} />Delete permanently…</button></>
        : <>
          {['skill', 'agent'].includes(item.kind) && (locations.length > 0 || copies.length > 0)
            ? <button className={`button ${copies.length ? '' : 'primary'}`} onClick={() => copies.length ? changeTab('installs') : onAction('approve-install')} title={copies.length ? 'Manage installed copies and remove them from individual locations' : undefined}>{copies.length ? <Check size={15} /> : <Download size={15} />}{copies.length ? installedNames.length || copies.some(copy => copy.state === 'drifted') ? 'Installed' : 'Manage installations' : currentApproved ? 'Install' : 'Approve & install'}</button>
            : item.kind === 'link' || (['tool', 'resource'].includes(item.kind) && /^https?:\/\/\S+$/i.test(revision.content.trim().split('\n')[0]))
              ? <button className="button primary" onClick={() => void perform(() => api('desktop.openItem', { id: item.id }))}><ExternalLink size={15} />Open link</button>
              : ['file', 'image', 'reference'].includes(item.kind)
                ? <button className="button primary" onClick={() => void perform(() => api('desktop.openItem', { id: item.id }))}><ExternalLink size={15} />Open file</button>
                : <button className="button primary" onClick={() => onAction('copy')}><Copy size={15} />Copy</button>}
          <button className="button" onClick={() => { changeTab('content'); setEditing(true); }}><Pencil size={15} />Edit</button>
          <button className="button" onClick={() => onAction('trial')}><FlaskConical size={15} />Test</button>
          <button className="button" aria-haspopup="menu" aria-expanded={Boolean(more)} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMore({ x: rect.left, y: rect.bottom + 4 }); }}>More</button>
          {more && <ContextMenu x={more.x} y={more.y} onClose={() => setMore(null)} entries={[
            { label: 'Copy', icon: <Copy />, onSelect: () => onAction('copy') },
            { label: currentApproved ? 'Unapprove' : 'Approve', icon: <ShieldCheck />, hint: currentApproved ? 'Withdraw approval; installed copies stay in place.' : 'Approve this revision and publish it to GitHub.', onSelect: () => onAction(currentApproved ? 'unapprove' : 'approve') },
            ...(installable ? [{ label: 'Install into a project folder…', icon: <Download />, disabled: !detail.approvals.length, onSelect: () => onAction('deploy') }] : [{ label: 'Create skill', icon: <Sparkles />, onSelect: () => onAction('derive') }]),
            { label: 'Open stored file or link', icon: <ExternalLink />, onSelect: () => void perform(() => api('desktop.openItem', { id: item.id })) },
            ...(['archived', 'rejected'].includes(item.status) ? [{ label: 'Back to library', icon: <RotateCcw />, onSelect: () => void perform(async () => { await api('items.meta', { id: item.id, expect: item.revision, status: 'captured' }); await refresh(); }, 'Back in the library') }] : []),
          ]} />}
        </>}</div>
    </header>
    <nav className="detail-tabs" aria-label="Item details">{['overview', 'content', 'history', 'trials', ...(installable ? ['installs'] : [])].map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => changeTab(t)}>{t}{t === 'trials' && detail.trials.length > 0 && <span>{detail.trials.length}</span>}</button>)}</nav>
    <div className="detail-scroll" {...scroll}><AgentStatus itemId={item.id} jobs={jobs} onOpen={tabFor} />
      {tab === 'overview' && <>
        <AgentPanel itemId={item.id} jobs={jobs} kinds={['capture', 'derive', 'distill']} onOpen={onSelect} onOpenCollection={onCollection} />
        <details className="item-status-details"><summary>{['archived', 'rejected'].includes(item.status) ? item.status === 'archived' ? 'Archived' : 'Rejected' : currentApproved ? 'Approved' : 'Draft'}{installable && item.kind !== 'instruction' && <> · {installedNames.length ? `Installed in ${installedNames.join(' and ')}` : 'Not installed'}{changedCopies ? ' · Copies need attention' : ''}</>}{item.kind === 'instruction' ? deployed.length ? ' · Install history available' : ' · No install records' : ''}{draftAfterApproval ? ' · New edits pending' : ''}{publishJob?.status === 'failed' ? ' · GitHub sync failed' : publishJob && !['done', 'failed'].includes(publishJob.status) ? ' · Saving to GitHub' : ''}</summary>
          <p>{currentApproved ? 'You approved this revision.' : 'This revision has not been approved.'} {trials.some(t => t.status === 'completed') ? 'A completed test is available in Trials.' : 'No completed test for this revision.'}</p>
        {approvals.map(a => <div className="notice success" key={a.id}><b>Approved by {a.reviewer}</b><PublishState job={publishJob} ahead={snapshot.git.ahead} onRetry={() => void perform(async () => { if (publishJob) await api('publish.retry', { id: publishJob.id }); await refresh(); })} /><p>{a.scope}</p><p>{a.note}</p>{a.waivedChecks && <p>Checks waived: {a.waivedChecks}</p>}<small>{date(a.createdAt)}</small></div>)}
          <button className="text-button" onClick={() => changeTab('history')}>View history</button>{installable && <button className="text-button" onClick={() => changeTab('installs')}>View installs</button>}
        {draftAfterApproval && <div className="notice"><b>Draft with unapproved edits</b><p>Revision {shortHash(lastApproved.revision)} is the approved version on GitHub and the one installs use. This draft ({shortHash(item.revision)}) exists only on this machine until you approve it.</p></div>}
        </details>

        {detail.validation.length > 0 && <div className="notice warning"><b>Needs attention before approval</b>{detail.validation.map(v => <p key={v}>{v}</p>)}</div>}
        {detail.duplicates.length > 0 && <div className="notice warning"><b>Similar content already in your library</b>{detail.duplicates.map(d => <button key={d.id} className="text-button" onClick={() => onSelect(d.id)}>{d.title} <ArrowRight size={12} /></button>)}</div>}
        <section className="content-section"><div className="section-heading"><h3>Content preview</h3><button className="text-button" aria-pressed={raw} onClick={() => setRaw(!raw)}>{raw ? 'Read formatted' : 'Raw text'}</button><button className="text-button" onClick={() => { changeTab('content'); setEditing(true); }}>Open editor <ArrowRight size={13} /></button></div>
          {images.length > 0 && <div className="asset-gallery">{images.map(([name, content]) => <button key={name} type="button" className="asset-button" title={`Enlarge ${name}`} onClick={() => setZoom({ name, src: imageSource(name, content) })}><img className="asset-preview" alt={name} src={imageSource(name, content)} /><span><ZoomIn size={13} />{name}</span></button>)}</div>}
          {raw ? <pre className="content-preview">{revision.content}</pre> : <Markdown>{revision.content}</Markdown>}</section>
        <section className="content-section"><div className="section-heading"><h3>Provenance</h3><GitBranch size={15} /></div><dl className="metadata-list"><dt>Source</dt><dd>{item.source || 'Captured locally'}</dd><dt>Licence</dt><dd>{item.licence}</dd><dt>Captured</dt><dd>{date(item.createdAt)}</dd><dt>Item ID</dt><dd><code>{item.id}</code></dd>{item.origin && <><dt>Derived from</dt><dd><button className="text-button" onClick={() => onSelect(item.origin!.itemId)}>{snapshot.items.find(i => i.id === item.origin!.itemId)?.title ?? shortHash(item.origin.itemId)} @ {shortHash(item.origin.revision)} <ArrowRight size={12} /></button></dd></>}</dl><div className="tags">{item.tags.map(tag => <span key={tag}>#{tag}</span>)}</div></section>
        <div className="evidence-grid"><div><strong>{copied}</strong><span>copies observed</span></div><div><strong>{trials.filter(t => t.status === 'completed').length}</strong><span>completed trials</span></div><div><strong>{deployed.filter(d => d.status === 'applied').length}</strong><span>install receipts</span></div></div>

      </>}
      {tab === 'content' && <>
        <div className="section-heading"><h3>{item.kind === 'agent' ? item.agent?.filename : item.kind === 'skill' ? 'SKILL.md' : 'Content & metadata'}</h3><button className="text-button" aria-label={editing ? 'Discard local draft' : 'Edit text'} onClick={() => { if (editing) localStorage.removeItem(`kiln-draft:${item.id}`); setEditing(!editing); }}><Pencil size={14} />{editing ? 'Discard local draft' : 'Edit'}</button></div>
        {editing ? <form onSubmit={event => { event.preventDefault(); const fields = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>; void perform(async () => { await api('items.update', { id: item.id, expect: base, summary: fields.summary, value: { ...revision, ...fields, content: draft, ...(item.kind === 'agent' ? { agent: { provider: item.agent?.provider, filename: fields.agentFilename } } : {}), tags: fields.tags.split(',').map(t => t.trim()).filter(Boolean) } }); localStorage.removeItem('kiln-draft:' + item.id); setEditing(false); await refresh(); }, 'New draft revision saved'); }}>
          {base !== item.revision && <div className="notice warning">This item changed elsewhere. Your unsaved text is preserved. Copy it before cancelling, then compare in History.</div>}<Field label="Title"><input name="title" defaultValue={item.title} required /></Field>{item.kind === 'agent' && <Field label="Agent filename"><input name="agentFilename" defaultValue={item.agent?.filename} required /></Field>}<Field label="Content"><textarea className="code-input editor" value={draft} onChange={e => setDraft(e.target.value)} rows={16} /></Field><div className="form-grid"><Field label="Collection"><input name="collection" defaultValue={item.collection} list="collection-names" required /><datalist id="collection-names">{snapshot.collections.map(name => <option key={name} value={name} />)}</datalist></Field><Field label="Tags"><input name="tags" defaultValue={item.tags.join(', ')} /></Field></div><Field label="Source"><input name="source" defaultValue={item.source} /></Field><Field label="Licence"><input name="licence" defaultValue={item.licence} /></Field><Field label="What changed? (optional)" hint="Leave it empty to use a plain revision note."><input name="summary" placeholder="Brief revision note" /></Field><div className="modal-actions"><span className="muted small">Text autosaves privately. Save creates an unapproved revision.</span><button className="button primary" type="submit">Save revision</button></div>
        </form> : <pre className="content-preview full">{revision.content}</pre>}
        <section className="content-section"><h3>Bundled files</h3>{Object.keys(revision.files).length ? <div className="file-preview-list">{Object.entries(revision.files).map(([name, content]) => <div key={name} className="bundled-file">
          {imageFile(name) ? <button type="button" className="bundled-thumb" aria-label={`Enlarge ${name}`} onClick={() => setZoom({ name, src: imageSource(name, content) })}><img src={imageSource(name, content)} alt="" /></button> : null}
          <span className="bundled-name">{name}<small>{Math.round(content.length * .75).toLocaleString()} bytes</small></span>
          <span className="wrap-actions">{isTextFile(name) && <button className="text-button" onClick={() => setFilePreview({ name, text: decode(content) })}>Preview</button>}{imageFile(name) && <button className="text-button" onClick={() => setZoom({ name, src: imageSource(name, content) })}><ZoomIn size={13} />Enlarge</button>}<button className="text-button" onClick={() => openFile(name)}><ExternalLink size={13} />Open</button><button className="text-button danger-text" onClick={() => void perform(async () => { await api('desktop.removeAttachment', { id: item.id, expect: item.revision, relative: name }); await refresh(); }, 'Attachment removed in a new draft revision')}>Remove</button></span></div>)}</div> : <p className="muted">This revision contains text only.</p>}
          {filePreview && <div><div className="section-heading"><h3>{filePreview.name}</h3><button className="text-button" onClick={() => setFilePreview(null)}>Close preview</button></div><pre className="prompt-preview">{filePreview.text}</pre></div>}
          <form onSubmit={event => { event.preventDefault(); const v = new FormData(event.currentTarget); void perform(async () => { await api('desktop.addAttachment', { id: item.id, expect: item.revision, relative: v.get('relative') }); await refresh(); }); }}><Field label="Add or replace a bundled file" hint="Choose its relative path, then select the file. Scripts stay inert until separately reviewed and run."><div className="input-button"><input name="relative" required placeholder="scripts/check.py or references/guide.md" /><button className="button" type="submit">Choose file</button></div></Field></form>
        </section>
        <section className="content-section"><h3>Library actions</h3><p className="muted small">Approved is set by Approve. Testing is set automatically when an experiment starts. Rejected and Archived move the item out of the main library into Archive.</p><div className="wrap-actions">{['captured', 'testing', 'rejected', 'archived'].filter(status => status !== item.status).map(status => <button className="button" key={status} title={statusHelp[status]} onClick={() => void perform(async () => { await api('items.meta', { id: item.id, expect: item.revision, status }); await refresh(); })}>Move to {status}</button>)}<button className="button danger-text" onClick={() => void perform(async () => { await api('items.meta', { id: item.id, expect: item.revision, deleted: !item.deletedAt }); await refresh(); }, item.deletedAt ? 'Item restored' : 'Moved to Trash. Restore it any time.')}><Trash2 size={14} />{item.deletedAt ? 'Restore item' : 'Move to trash'}</button>{item.deletedAt && <button className="button danger-text" onClick={() => onAction('purge')}><Trash2 size={14} />Delete permanently</button>}</div></section>
      </>}
      {tab === 'history' && <>
        <div className="section-heading"><h3>Every version, preserved</h3><History size={16} /></div><p className="muted">Compare a previous revision with the current draft. Restoring library content does not change installed files.</p>
        <div className="revision-list">{detail.revisions.map(r => <button key={r.hash} className={`revision-row ${compare?.hash === r.hash ? 'selected' : ''}`} onClick={() => setCompare(r)}><div><b>{r.summary}</b><span>{r.author} · {date(r.createdAt)}</span></div><code>{shortHash(r.hash)}</code>{detail.approvals.some(a => a.revision === r.hash) && <ShieldCheck size={15} className="green" />}</button>)}</div>
        {compare && <><div className="section-heading"><h3>{shortHash(compare.hash)} → {shortHash(item.revision)}</h3>{compare.hash !== item.revision && <button className="button" onClick={() => void perform(async () => { await api('items.restore', { id: item.id, expect: item.revision, revision: compare.hash }); await refresh(); }, 'Revision restored. Installed snapshots are unchanged.')}><RotateCcw size={14} />Restore this version</button>}</div><LineDiff before={compare.content} after={revision.content} names={{ before: 'the selected version', after: 'the current draft' }} /><details><summary>Selected version metadata and files</summary><pre className="prompt-preview">{JSON.stringify({ title: compare.title, source: compare.source, tags: compare.tags, licence: compare.licence, files: Object.keys(compare.files) }, null, 2)}</pre></details></>}
      </>}
      {tab === 'trials' && <>
        <AgentPanel itemId={item.id} jobs={jobs} kinds={['trial']} onOpen={onSelect} />
        <div className="section-heading"><h3>Learn from real tasks</h3><button className="button" onClick={() => onAction('trial')}><FlaskConical size={15} />New trial</button></div>{!detail.trials.length && <p className="muted">Try a typical task and a boundary case. Keep your rubric and judgement alongside this revision.</p>}
        {[...detail.trials].reverse().map(t => <div className="trial-card" key={t.id}><div className="section-heading"><b>{t.case === 'typical' ? 'Typical case' : 'Boundary case'}</b><Badge status={t.judgement ?? t.status} /></div><p>{t.note || t.task}</p><ul>{t.rubric.map(r => <li key={r}>{r}</li>)}</ul><div className="detail-meta"><code>{shortHash(t.revision)}</code><span>{t.provider} · {date(t.createdAt)}</span></div><div className="wrap-actions">{t.status === 'prepared' ? <><button className="button primary" onClick={() => onAction('result', t)}>Record result</button><button className="button" onClick={() => void perform(() => api('desktop.copyTrial', { id: t.id }), 'Handoff copied')}><Copy size={14} />Copy handoff</button></> : <button className="button" onClick={() => void perform(async () => { setOutput(await api('desktop.trialOutput', { id: t.id })); })}>View local evidence</button>}<button className="button danger-text" onClick={() => { setOutput(null); onAction('delete-trial', t); }}><Trash2 size={14} />Delete experiment</button></div></div>)}
        {output && <div><div className="section-heading"><h3>Local trial evidence</h3><button className="text-button" onClick={() => setOutput(null)}>Close</button></div><pre className="prompt-preview">{output.output || output.reference || 'No output available on this machine.'}</pre></div>}
      </>}
      {tab === 'installs' && <>
        {['skill', 'agent'].includes(item.kind) && <section className="install-controls"><h3>Install locations</h3><p className="small muted">Choose a location to install, update or remove this item.</p><SkillToggles item={item} providers={providers} snapshot={snapshot} installations={installations} onToggle={onToggleInstall} onSetup={onSetup} /></section>}
        <div className="notice"><b>What installing does</b><p>Kiln copies the approved SKILL.md and bundled files into the agent’s skills folder, for example <code>~/.agents/skills/&lt;name&gt;</code> for Codex or <code>~/.claude/skills/&lt;name&gt;</code> for Claude Code. The agent loads it in new sessions. Removing deletes only that folder. Every install and removal leaves a receipt below.</p></div>
        <Installations snapshot={snapshot} installations={installations} itemId={item.id} onUninstall={id => onAction(`uninstall:${id}`)} onCompare={i => onAction(`compare:${i.itemId}:${i.targetId}`)} />
        <div className="section-heading"><h3>Install receipts</h3><button className="button" onClick={() => onAction('deploy')} disabled={!detail.approvals.length || !['skill', 'agent', 'instruction'].includes(item.kind)} title="Install an approved revision into a project folder or an earlier revision anywhere."><Rocket size={15} />Install into a project folder…</button></div><p className="muted">Receipts record what was written where. Check live drift in Machines before treating an old receipt as current.</p>{!deployed.length && <p className="empty-inline">No install receipts for this item.</p>}
        {[...deployed].reverse().map(r => <div className="trial-card" key={r.id}><div className="section-heading"><b>{snapshot.targets.find(t => t.id === r.targetId)?.name ?? 'Unknown environment'}</b><Badge status={r.status} /></div><code className="path-text">{r.destination}</code><p className="muted">{shortHash(r.revision)} · {date(r.createdAt)} · new session required</p>{r.status === 'applied' && <button className="button" onClick={() => onAction(`rollback:${r.id}`)}><RotateCcw size={14} />Review rollback</button>}{r.error && <p className="error-box">{r.error}</p>}</div>)}
      </>}
    </div>
    {zoom && <Lightbox src={zoom.src} name={zoom.name} onClose={() => setZoom(null)} />}
  </article>;
}
