import { useEffect, useState, type ReactNode } from 'react';
import { FolderOpen, Github, Link2, TriangleAlert } from 'lucide-react';
import { api } from './api';
import { Badge, Field, InlineError, Modal } from './components';
import type { AgentFile } from '../../../packages/domain/agents-import';
import type { LocalSkill } from '../../../packages/domain/skills-import';
import type { MigrationEntry } from '../../../packages/git/migration';

const short = (message: string) => message.replace(/^[A-Z_]+: /, '');
export type Migration = { unchanged: number; conflicts: number; pending: number; hash: string; count: number; importable: number; totalBytes: number; entries: MigrationEntry[]; source: string };
type Repo = { nameWithOwner: string; url: string; isPrivate: boolean; description: string };

/** Skills already installed for Codex or Claude Code on this machine, offered for import as drafts. */
export function LocalSkillsDialog({ onClose, onDone }: { onClose: () => void; onDone: (summary: string) => void | Promise<void> }) {
  const [scan, setScan] = useState<{ roots: string[]; entries: LocalSkill[] } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => { void api<{ roots: string[]; entries: LocalSkill[] }>('skills.scanLocal').then(result => { setScan(result); setChosen(new Set(result.entries.filter(e => e.hasSkillFile && !e.imported && !e.error).map(e => e.path))); }).catch(e => setError(short(String(e)))); }, []);
  const toggle = (entryPath: string) => setChosen(set => { const next = new Set(set); if (next.has(entryPath)) next.delete(entryPath); else next.add(entryPath); return next; });
  const importable = scan?.entries.filter(e => e.hasSkillFile && !e.error) ?? [];
  const run = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<{ imported: string[]; unchanged: string[]; failed: { path: string; error: string }[] }>('skills.importLocal', { paths: [...chosen], confirm: true });
      await onDone(`${result.imported.length} skill${result.imported.length === 1 ? '' : 's'} imported as drafts${result.unchanged.length ? `, ${result.unchanged.length} already in the library` : ''}${result.failed.length ? `, ${result.failed.length} failed: ${result.failed.map(f => short(f.error)).join('; ')}` : ''}.`);
    } catch (e) { setError(short(e instanceof Error ? e.message : String(e))); setBusy(false); }
  };
  return <Modal title="Import my installed skills" subtitle="Skills your agents already use on this machine, copied into the library as drafts. The folders stay where they are." onClose={() => { if (!busy) onClose(); }} wide>
    {scan && <p className="muted small">Looked in {scan.roots.map(r => <code key={r}>{r}</code>).reduce<ReactNode[]>((all, node, i) => i ? [...all, ', ', node] : [node], [])}.</p>}
    <InlineError error={error} />
    {!scan ? <p className="muted">Reading skill folders…</p> : !scan.entries.length ? <p className="empty-inline">No skill folders found in those locations.</p> : <div className="inventory-list">{scan.entries.map(entry => <div key={entry.path}><label className="check-row"><input type="checkbox" disabled={!entry.hasSkillFile || Boolean(entry.error) || busy} checked={chosen.has(entry.path)} onChange={() => toggle(entry.path)} /><span><b>{entry.name}</b>{entry.linked && <Link2 size={12} className="muted" />}<code className="path-text">{entry.linked ? `${entry.path} → ${entry.realPath}` : entry.path}</code>{entry.error && <p className="error-box">{entry.error}</p>}{!entry.error && !entry.hasSkillFile && <p className="small muted">No SKILL.md inside; skipped.</p>}{entry.validation.length > 0 && <p className="small muted"><TriangleAlert size={11} /> {entry.validation[0]}</p>}</span></label>{entry.imported ? <Badge status="imported" /> : entry.hasSkillFile && !entry.error ? <span className="muted small">{entry.fileCount} file{entry.fileCount === 1 ? '' : 's'}</span> : null}</div>)}</div>}
    <div className="modal-actions"><span className="muted small">{scan ? `${chosen.size} of ${importable.length} selected` : ''}</span><button className="button" onClick={() => setChosen(new Set(importable.map(e => e.path)))} disabled={!importable.length || busy}>Select all</button><button className="button" disabled={busy} onClick={() => setChosen(new Set())}>Clear selection</button><button className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={!chosen.size || busy} onClick={() => void run()}>{busy ? 'Importing…' : `Import ${chosen.size || ''}`}</button></div>
  </Modal>;
}

/**
 * Skills from a Git repository: a folder on this machine (a clone, or any folder with SKILL.md files inside) or one of the
 * user's GitHub repositories, cloned first. Every SKILL.md is found wherever it sits; supporting and linked files come along.
 */
export function RepositorySkillsDialog({ initialSource = '', onClose, onDone }: { initialSource?: string; onClose: () => void; onDone: (summary: string) => void | Promise<void> }) {
  const [source, setSource] = useState(initialSource), [reading, setReading] = useState(false), [error, setError] = useState('');
  const [migration, setMigration] = useState<Migration | null>(null), [repos, setRepos] = useState<Repo[] | null>(null), [filter, setFilter] = useState(''), [busy, setBusy] = useState('');
  const read = async (folder: string) => { setReading(true); setError(''); try { setSource(folder); setMigration(await api<Migration>('repository.migrationPlan', { source: folder })); } catch (e) { setError(short(e instanceof Error ? e.message : String(e))); } finally { setReading(false); } };
  const clone = async (repo: Repo) => {
    setBusy(repo.nameWithOwner); setError('');
    try { const parent = `${await api<string>('repository.defaultParent')}\\sources`; const result = await api<{ root: string }>('github.clone', { repo: repo.nameWithOwner, parent }); await read(result.root); }
    catch (e) { const message = short(e instanceof Error ? e.message : String(e)); if (/FOLDER_EXISTS|already exists/i.test(message)) setError('That repository was cloned before. Browse to the existing folder instead.'); else setError(message); }
    finally { setBusy(''); }
  };
  const filtered = (repos ?? []).filter(r => !filter.trim() || r.nameWithOwner.toLowerCase().includes(filter.toLowerCase()));
  return <Modal title="Import skills from a repository" subtitle="Every SKILL.md in the repository is copied into the library as a draft, with its supporting and linked files. The source is left untouched." onClose={onClose} wide>
    {!migration ? <>
      <Field label="Folder on this machine" hint="A clone of your skills repository, or any folder that holds SKILL.md files."><div className="input-button"><input value={source} onChange={e => setSource(e.target.value)} placeholder="C:\path\to\skills" aria-label="Folder" /><button type="button" className="button" onClick={() => void api<string | null>('desktop.chooseDirectory').then(chosen => { if (chosen) setSource(chosen); })}><FolderOpen size={14} />Browse</button></div></Field>
      <details onToggle={e => { if ((e.target as HTMLDetailsElement).open && repos === null) void api<Repo[]>('github.repositories').then(setRepos).catch(err => setError(short(String(err)))); }}><summary><Github size={13} /> Or clone one of your GitHub repositories</summary>
        <input className="setup-filter" placeholder="Filter repositories" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter repositories" />
        {repos === null ? <p className="muted">Reading your repositories…</p> : <div className="inventory-list">{filtered.map(repo => <div key={repo.nameWithOwner}><div><b>{repo.nameWithOwner}</b><p className="small muted">{repo.isPrivate ? 'Private' : 'Public'}{repo.description ? ` · ${repo.description}` : ''}</p></div><button className="button" disabled={Boolean(busy)} onClick={() => void clone(repo)}>{busy === repo.nameWithOwner ? 'Cloning…' : 'Clone & read'}</button></div>)}{!filtered.length && <div><span className="muted">No repositories match.</span></div>}</div>}
      </details>
      <InlineError error={error} />
      <div className="modal-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={!source.trim() || reading} onClick={() => void read(source.trim())}>{reading ? 'Reading skills…' : 'Read skills'}</button></div>
    </> : <>
      <code className="path-text">{migration.source}</code>
      <div className="migration-stats"><div><b>{migration.count}</b><span>skill files found</span></div><div><b>{migration.pending}</b><span>new or updated</span></div><div><b>{migration.unchanged}</b><span>already imported</span></div></div>
      {migration.count === 0 && <p className="notice">No SKILL.md files found there. Skills are folders that contain a SKILL.md; pick the folder that holds them.</p>}
      {migration.conflicts > 0 && <p className="notice warning">{migration.conflicts} source updates conflict with local edits. Resolve these before importing.</p>}
      <div className="inventory-list">{migration.entries.map(entry => <div key={entry.path}><div><b>{entry.title}</b><code className="path-text">{entry.path}</code>{entry.error && <p className="error-box">{entry.error}</p>}</div><span className="inline"><span className="muted small">{entry.fileCount} file{entry.fileCount === 1 ? '' : 's'}</span><Badge status={entry.error ? 'blocked' : entry.validation.length ? 'review' : 'ready'} /></span></div>)}</div>
      <p className="muted small">Repeating an import does not duplicate items. Source updates become new drafts; local edits produce conflicts for review.</p>
      <InlineError error={error} />
      <div className="modal-actions"><button className="button" onClick={() => setMigration(null)}>Back</button><button className="button primary" disabled={migration.count !== migration.importable || migration.pending === 0 || migration.conflicts > 0 || reading} onClick={() => { setReading(true); void api('repository.migrate', { expect: migration.hash, confirm: true, source: migration.source }).then(() => onDone(`${migration.pending} skill${migration.pending === 1 ? '' : 's'} imported as drafts from ${migration.source}.`)).catch(e => { setError(short(e instanceof Error ? e.message : String(e))); setReading(false); }); }}>{migration.pending ? `Import ${migration.pending} skills` : 'Already imported'}</button></div>
    </>}
  </Modal>;
}


/** Native agent definitions are imported in their provider's format, as drafts. */
export function LocalAgentsDialog({ onClose, onDone }: { onClose: () => void; onDone: (summary: string) => void | Promise<void> }) {
  const [entries, setEntries] = useState<AgentFile[] | null>(null), [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = (entry: AgentFile) => `${entry.provider}:${entry.path}`;
  useEffect(() => { void api<AgentFile[]>('agents.scan').then(found => { setEntries(found); setChosen(new Set(found.filter(e => !e.imported && !e.error).map(key))); }).catch(e => setError(short(String(e)))); }, []);
  const run = async () => {
    setBusy(true); setError('');
    try {
      const files = (entries ?? []).filter(e => chosen.has(key(e))).map(({ path, provider }) => ({ path, provider }));
      const result = await api<{ imported: string[]; failed: string[] }>('agents.import', { files, confirm: true });
      await onDone(`${result.imported.length} agents imported as drafts${result.failed.length ? `; ${result.failed.length} failed: ${result.failed.join('; ')}` : ''}.`);
    } catch (e) { setError(short(String(e))); } finally { setBusy(false); }
  };
  return <Modal title="Import my agents" subtitle="Discover Codex, Claude Code and Copilot definitions in personal and configured folders. Copies enter the library as drafts; originals stay in place." onClose={() => { if (!busy) onClose(); }} wide>
    <InlineError error={error} />
    {!entries ? <p>Reading agent folders…</p> : !entries.length ? <p>No agent definitions found.</p> : <div className="inventory-list">{entries.map(entry => <div key={key(entry)}><label className="check-row"><input type="checkbox" disabled={busy || Boolean(entry.error)} checked={chosen.has(key(entry))} onChange={() => setChosen(current => { const next = new Set(current); if (next.has(key(entry))) next.delete(key(entry)); else next.add(key(entry)); return next; })} /><span><b>{entry.name}</b><small> · {entry.provider}</small><code className="path-text">{entry.path}</code>{entry.error && <p className="error-box">{entry.error}</p>}{entry.validation.length > 0 && <p className="small muted">{entry.validation[0]}</p>}</span></label>{entry.imported && <Badge status="imported" />}</div>)}</div>}
    <div className="modal-actions"><span>{chosen.size} selected</span><button className="button" disabled={busy || !entries?.length} onClick={() => setChosen(new Set(entries?.filter(e => !e.error).map(key)))}>Select all</button><button className="button" disabled={busy} onClick={() => setChosen(new Set())}>Clear selection</button><button className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !chosen.size} onClick={() => void run()}>{busy ? 'Importing…' : `Import ${chosen.size}`}</button></div>
  </Modal>;
}
