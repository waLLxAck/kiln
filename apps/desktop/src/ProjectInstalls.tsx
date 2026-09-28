import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Item, ProviderId } from '../../../packages/protocol/schema';
import type { ProjectLocation, ProjectPreview } from '../../../packages/deployment/projects';
import { agentFolder } from '../../../packages/domain/agent-format';
import { api } from './api';
import { Badge, InlineError, Modal } from './components';
import { sourceLabel, useKnownProjects, type KnownProject } from './KnownProjects';

/** Which clients read each project location, from docs/SKILL_LOCATIONS.md. A project gets one target per client: Agents is Codex's. */
const locations: { id: ProjectLocation; label: string; folder: string; provider: ProviderId; readers: string }[] = [
  { id: 'agents', label: 'Agents', folder: '.agents/skills', provider: 'codex', readers: 'Shared: Codex, Copilot, Cursor, Gemini CLI, OpenCode, Amp and most other clients.' },
  { id: 'claude', label: 'Claude', folder: '.claude/skills', provider: 'claude', readers: 'Claude Code; Copilot in VS Code, OpenCode and Crush read it too.' },
  { id: 'copilot', label: 'Copilot', folder: '.github/skills', provider: 'copilot', readers: 'GitHub Copilot’s project folder. Copilot also reads .agents/skills.' },
];
type Row = Pick<KnownProject, 'root' | 'name' | 'sources' | 'exists' | 'targets' | 'managed'>;
const done: Record<string, string> = { installed: 'installed', updated: 'updated', adopted: 'the existing copy is now managed by Kiln', unchanged: 'already installed' };
const folderOf = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value;
const join = (root: string, folder: string) => `${root.replace(/[\\/]+$/, '')}${root.includes('\\') ? '\\' : '/'}${root.includes('\\') ? folder.replaceAll('/', '\\') : folder}`;
const stateText: Record<ProjectPreview['state'], string> = {
  absent: 'Nothing is there yet. Kiln creates the folder and writes the approved files.',
  installed: 'Kiln installed this revision here already. Nothing needs to change.',
  older: 'Kiln installed an earlier revision here, unchanged since. Installing writes this revision over it; the receipt keeps the previous files for rollback.',
  drifted: 'Kiln installed this item here, and the copy was edited afterwards.',
  identical: 'An identical copy is already there, not managed by Kiln. Installing records ownership without rewriting anything.',
  differs: 'A different copy with this name is already there, not written by Kiln for this item.',
  linked: 'A link to a folder elsewhere is there. Installing removes only the link and writes a real copy; the folder it points to is untouched.',
};
const stateBadge: Record<ProjectPreview['state'], string> = { absent: 'create', installed: 'installed', older: 'update_available', drifted: 'drifted', identical: 'found', differs: 'differs', linked: 'linked' };

/**
 * The one project dialog. With an item it is Install into project…: pick a known project (or any folder), a location in it,
 * check the preview, install. Without one (Machines → Add project…) it adds the folder as a project for a location, so its
 * column appears in the matrix, without writing anything into it. Either way a project with no Kiln copies can be forgotten.
 */
export function ProjectInstallDialog({ item, onClose, onDone }: { item?: Item; onClose: () => void; onDone: (message: string) => void }) {
  const { projects, error: listError, reload } = useKnownProjects(true);
  const [chosen, setChosen] = useState<string[]>([]), [root, setRoot] = useState(''), [location, setLocation] = useState<ProjectLocation>('agents');
  const [preview, setPreview] = useState<ProjectPreview | null>(null), [replace, setReplace] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const skill = !item || item.kind === 'skill';
  // A folder picked with Choose folder… is listed until the install makes it a known project.
  const listed: Row[] = [...chosen.filter(c => !projects?.some(p => p.root === c)).map(c => ({ root: c, name: folderOf(c), sources: [], exists: true, targets: [], managed: 0 })), ...(projects ?? [])];
  const project = listed.find(p => p.root === root);
  const place = locations.find(l => l.id === location)!;
  useEffect(() => { if (!root && projects?.length) { const first = projects.find(p => p.exists); if (first) setRoot(first.root); } }, [projects]);
  useEffect(() => {
    setPreview(null); setReplace(false); setError('');
    if (!root || !item) return;
    let active = true;
    void api<ProjectPreview>('projects.preview', { itemId: item.id, root, location: skill ? location : undefined }).then(result => { if (active) setPreview(result); }).catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [root, location, item?.id, item?.revision]);
  const choose = async () => { setError(''); try { const folder = await api<string | null>('desktop.chooseDirectory'); if (folder) { setChosen(c => [folder, ...c.filter(x => x !== folder)]); setRoot(folder); } } catch (e) { setError(String(e)); } };
  const forget = async (row: Row) => {
    setBusy(true); setError('');
    try { await api('projects.forget', { root: row.root, confirm: true }); if (row.root === root) setRoot(''); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const install = async () => {
    if (!preview || !item) return;
    // Named before the wait, so the message names the location that was installed into.
    const where = skill ? place.label : 'agent definitions';
    setBusy(true); setError('');
    try {
      const result = await api<{ method: string; name: string; enrolled: boolean }>('projects.install', { itemId: item.id, root, location: skill ? location : undefined, replace, confirm: true, expect: { state: preview.state, current: preview.current } });
      onDone(`${item.title}: ${done[result.method] ?? result.method} in ${result.name} (${where}). ${result.enrolled ? `${result.name} is now one of your projects. ` : ''}Start a new client session to use it.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  // Adding enrols the folder for that location, as the first install into it would; the project keeps the name it already has.
  const added = Boolean(project?.targets.some(t => t.location === location));
  const add = async () => {
    if (!project) return;
    setBusy(true); setError('');
    try {
      await api('targets.enroll', { name: project.name.slice(0, 100), root, provider: place.provider, scope: 'project', profile: 'Personal' });
      onDone(`${project.name} is now one of your projects (${place.label}). Install into it from Machines or an item’s Installs.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const needsConfirm = preview?.state === 'differs' || preview?.state === 'drifted';
  const action = !preview ? 'Install' : { absent: 'Install', installed: 'Already installed', older: 'Update', drifted: 'Replace', identical: 'Let Kiln manage it', differs: 'Replace', linked: 'Replace the link with a copy' }[preview.state];
  return <Modal title={item ? 'Install into project' : 'Add project'} subtitle={item?.title ?? 'A folder on this machine that Kiln installs skills and agents into'} onClose={onClose} wide>
    <h3 className="project-install-heading">Project</h3>
    {!projects && !listError ? <p className="muted small">Reading known projects…</p> : !listed.length ? <p className="empty-inline">No projects yet. Choose a folder{item ? ' to install into' : ''}.</p> : <div className="project-choices" role="radiogroup" aria-label="Project">{listed.map(row => <div className={`project-choice ${row.root === root ? 'selected' : ''}`} key={row.root}>
      <label><input type="radio" name="project" value={row.root} checked={row.root === root} disabled={!row.exists} onChange={() => setRoot(row.root)} /><span><b>{row.name}</b><code className="path-text">{row.root}</code><small>{row.exists ? row.sources.length ? `Known from ${row.sources.map(s => sourceLabel[s]).join(', ')}` : 'Chosen now' : 'Folder not found'}{row.managed ? ` · ${row.managed} Kiln cop${row.managed === 1 ? 'y' : 'ies'}` : ''}</small></span></label>
      {row.targets.length > 0 && <button type="button" className="text-button" disabled={busy} aria-label={`Forget ${row.name}`} title={row.managed ? 'Remove the copies Kiln installed here first.' : 'Stop installing into this folder. Nothing in it changes.'} onClick={() => void forget(row)}>Forget</button>}
    </div>)}</div>}
    <div className="wrap-actions"><button type="button" className="button" disabled={busy} onClick={() => void choose()}><FolderOpen size={14} />Choose folder…</button></div>
    <InlineError error={listError} />
    {skill ? <><h3 className="project-install-heading">Where in the project</h3><div className="project-choices" role="radiogroup" aria-label="Location">{locations.map(l => <div className={`project-choice ${l.id === location ? 'selected' : ''}`} key={l.id}><label><input type="radio" name="location" value={l.id} checked={l.id === location} disabled={busy} onChange={() => setLocation(l.id)} /><span><b>{l.label} <code>{l.folder}</code></b><small>{l.readers}</small></span></label></div>)}</div></>
      : <p className="small muted">Agent definitions keep their client’s format, so this goes into <code>{agentFolder(item?.agent?.provider ?? 'claude', 'project')}</code>.</p>}
    {item && preview && <div className="project-preview" aria-label="Preview">
      <div className="plan-summary"><Badge status={stateBadge[preview.state]} /><code className="path-text">{preview.destination}</code></div>
      <p>{stateText[preview.state]}</p>
      {!preview.enrolled && <p className="small muted">Installing adds this folder to your projects as “{preview.name}”.</p>}
      {!preview.approved && <p className="notice">This draft is not approved yet. Installing approves exactly this revision and pushes it to your Kiln repo on GitHub.</p>}
      {preview.problem && <InlineError error={preview.problem} />}
      {needsConfirm && <label className="check-row"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} /><span>Set the existing folder aside (kept under Kiln’s private data, not deleted) and install this revision in its place</span></label>}
    </div>}
    {!item && project && <div className="project-preview" aria-label="Preview">
      <code className="path-text">{join(root, place.folder)}</code>
      <p>{added ? `${project.name} is already one of your projects for ${place.label}.` : `Adds this folder to your projects as “${project.name}”, with a ${place.label} column in Machines. Nothing is written into it until you install something.`}</p>
    </div>}
    <InlineError error={error} />
    <div className="modal-actions"><span className="muted small">Project installs stay on this machine; other machines do not repeat them.</span><button className="button" onClick={onClose}>Cancel</button>
      {item ? <button className="button primary" disabled={busy || !preview || Boolean(preview.problem) || preview.state === 'installed' || (needsConfirm && !replace)} onClick={() => void install()}>{busy ? 'Installing…' : action}</button>
        : <button className="button primary" disabled={busy || !project?.exists || added} onClick={() => void add()}>{added ? 'Already added' : 'Add project'}</button>}</div>
  </Modal>;
}
