import { useEffect, useState } from 'react';
import { CircleArrowUp, FileDiff, FolderOpen, FolderPlus, Trash2 } from 'lucide-react';
import type { Installation, Item, ProviderId, Snapshot } from '../../../packages/protocol/schema';
import type { ProjectLocation, ProjectPreview } from '../../../packages/deployment/projects';
import { skillLocationLabel } from '../../../packages/providers/skill-locations';
import { agentFolder } from '../../../packages/domain/agent-format';
import { api } from './api';
import { Badge, InlineError, Modal } from './components';
import { installationLabel } from './Installations';
import { sourceLabel, useKnownProjects, type KnownProject } from './KnownProjects';

// Experimental: projectInstalls ("Install into project folders").
/** Which clients read each project location, from docs/SKILL_LOCATIONS.md. */
const locations: { id: ProjectLocation; label: string; folder: string; readers: string }[] = [
  { id: 'agents', label: 'Agents', folder: '.agents/skills', readers: 'Shared: Codex, Copilot, Cursor, Gemini CLI, OpenCode, Amp and most other clients.' },
  { id: 'claude', label: 'Claude', folder: '.claude/skills', readers: 'Claude Code; Copilot in VS Code, OpenCode and Crush read it too.' },
  { id: 'copilot', label: 'Copilot', folder: '.github/skills', readers: 'GitHub Copilot’s project folder. Copilot also reads .agents/skills.' },
];
type Row = Pick<KnownProject, 'root' | 'name' | 'sources' | 'exists' | 'targets' | 'managed'>;
const done: Record<string, string> = { installed: 'installed', updated: 'updated', adopted: 'the existing copy is now managed by Kiln', unchanged: 'already installed' };
const folderOf = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || value;
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

/** Install into project…: pick a known project (or any folder), a location in it, check the preview, install. */
export function ProjectInstallDialog({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: (message: string) => void }) {
  const { projects, error: listError, reload } = useKnownProjects(true);
  const [chosen, setChosen] = useState<string[]>([]), [root, setRoot] = useState(''), [location, setLocation] = useState<ProjectLocation>('agents');
  const [preview, setPreview] = useState<ProjectPreview | null>(null), [replace, setReplace] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const skill = item.kind === 'skill';
  // A folder picked with Choose folder… is listed until the install makes it a known project.
  const listed: Row[] = [...chosen.filter(c => !projects?.some(p => p.root === c)).map(c => ({ root: c, name: folderOf(c), sources: [], exists: true, targets: [], managed: 0 })), ...(projects ?? [])];
  useEffect(() => { if (!root && projects?.length) { const first = projects.find(p => p.exists); if (first) setRoot(first.root); } }, [projects]);
  useEffect(() => {
    setPreview(null); setReplace(false); setError('');
    if (!root) return;
    let active = true;
    void api<ProjectPreview>('projects.preview', { itemId: item.id, root, location: skill ? location : undefined }).then(result => { if (active) setPreview(result); }).catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [root, location, item.id, item.revision]);
  const choose = async () => { setError(''); try { const folder = await api<string | null>('desktop.chooseDirectory'); if (folder) { setChosen(c => [folder, ...c.filter(x => x !== folder)]); setRoot(folder); } } catch (e) { setError(String(e)); } };
  const forget = async (project: Row) => {
    setBusy(true); setError('');
    try { await api('projects.forget', { root: project.root, confirm: true }); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const install = async () => {
    if (!preview) return;
    // Named before the wait, so the message names the location that was installed into.
    const where = skill ? locations.find(l => l.id === location)!.label : 'agent definitions';
    setBusy(true); setError('');
    try {
      const result = await api<{ method: string; name: string; enrolled: boolean }>('projects.install', { itemId: item.id, root, location: skill ? location : undefined, replace, confirm: true, expect: { state: preview.state, current: preview.current } });
      onDone(`${item.title}: ${done[result.method] ?? result.method} in ${result.name} (${where}). ${result.enrolled ? `${result.name} is now one of your projects. ` : ''}Start a new client session to use it.`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  const needsConfirm = preview?.state === 'differs' || preview?.state === 'drifted';
  const action = !preview ? 'Install' : { absent: 'Install', installed: 'Already installed', older: 'Update', drifted: 'Replace', identical: 'Let Kiln manage it', differs: 'Replace', linked: 'Replace the link with a copy' }[preview.state];
  return <Modal title="Install into project" subtitle={item.title} onClose={onClose} wide>
    <h3 className="project-install-heading">Project</h3>
    {!projects && !listError ? <p className="muted small">Reading known projects…</p> : !listed.length ? <p className="empty-inline">No projects yet. Choose a folder to install into.</p> : <div className="project-choices" role="radiogroup" aria-label="Project">{listed.map(project => <div className={`project-choice ${project.root === root ? 'selected' : ''}`} key={project.root}>
      <label><input type="radio" name="project" value={project.root} checked={project.root === root} disabled={!project.exists} onChange={() => setRoot(project.root)} /><span><b>{project.name}</b><code className="path-text">{project.root}</code><small>{project.exists ? project.sources.length ? `Known from ${project.sources.map(s => sourceLabel[s]).join(', ')}` : 'Chosen now' : 'Folder not found'}{project.managed ? ` · ${project.managed} Kiln cop${project.managed === 1 ? 'y' : 'ies'}` : ''}</small></span></label>
      {project.targets.length > 0 && <button type="button" className="text-button" disabled={busy} aria-label={`Forget ${project.name}`} title={project.managed ? 'Remove the copies Kiln installed here first.' : 'Stop installing into this folder. Nothing in it changes.'} onClick={() => void forget(project)}>Forget</button>}
    </div>)}</div>}
    <div className="wrap-actions"><button type="button" className="button" disabled={busy} onClick={() => void choose()}><FolderOpen size={14} />Choose folder…</button></div>
    <InlineError error={listError} />
    {skill ? <><h3 className="project-install-heading">Where in the project</h3><div className="project-choices" role="radiogroup" aria-label="Location">{locations.map(l => <div className={`project-choice ${l.id === location ? 'selected' : ''}`} key={l.id}><label><input type="radio" name="location" value={l.id} checked={l.id === location} disabled={busy} onChange={() => setLocation(l.id)} /><span><b>{l.label} <code>{l.folder}</code></b><small>{l.readers}</small></span></label></div>)}</div></>
      : <p className="small muted">Agent definitions keep their client’s format, so this goes into <code>{agentFolder(item.agent?.provider ?? 'claude', 'project')}</code>.</p>}
    {preview && <div className="project-preview" aria-label="Preview">
      <div className="plan-summary"><Badge status={stateBadge[preview.state]} /><code className="path-text">{preview.destination}</code></div>
      <p>{stateText[preview.state]}</p>
      {!preview.enrolled && <p className="small muted">Installing adds this folder to your projects as “{preview.name}”.</p>}
      {!preview.approved && <p className="notice">This draft is not approved yet. Installing approves exactly this revision and pushes it to your Kiln repo on GitHub.</p>}
      {preview.problem && <InlineError error={preview.problem} />}
      {needsConfirm && <label className="check-row"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} /><span>Set the existing folder aside (kept under Kiln’s private data, not deleted) and install this revision in its place</span></label>}
    </div>}
    <InlineError error={error} />
    <div className="modal-actions"><span className="muted small">Project installs stay on this machine; other machines do not repeat them.</span><button className="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !preview || Boolean(preview.problem) || preview.state === 'installed' || (needsConfirm && !replace)} onClick={() => void install()}>{busy ? 'Installing…' : action}</button></div>
  </Modal>;
}

/** The part of a copy's path above `<location folder>/<name>`: the project folder. */
const rootOf = (destination: string) => destination.split(/[\\/]/).slice(0, -3).join(destination.includes('\\') ? '\\' : '/');
/** Installs tab → Projects: this item's copies in project folders, grouped by project, with the same actions as personal copies. */
export function ProjectCopies({ item, snapshot, installations, onInstall, onManage, onCompare }: { item: Item; snapshot: Snapshot; installations: Installation[]; onInstall: () => void; onManage: (provider: ProviderId, targetId: string) => void; onCompare: (copy: Installation) => void }) {
  const copies = installations.filter(i => i.itemId === item.id && i.scope === 'project');
  const groups = new Map<string, { name: string; root: string; copies: Installation[] }>();
  for (const copy of copies) {
    const target = snapshot.targets.find(t => t.id === copy.targetId), root = target?.root ?? rootOf(copy.destination), key = root.replace(/[\\/]+$/, '');
    const group = groups.get(key) ?? { name: target?.name ?? folderOf(root), root, copies: [] };
    group.copies.push(copy); groups.set(key, group);
  }
  return <section className="content-section project-copies"><div className="section-heading"><h3>Projects</h3><button className="button" onClick={onInstall}><FolderPlus size={15} />Install into project…</button></div>
    <p className="muted small">Copies in project folders on this machine. They are not part of the library’s installs, so other machines do not repeat them.</p>
    {!groups.size ? <p className="empty-inline">Not installed in any project yet.</p> : [...groups.values()].map(group => <div className="project-group" key={group.root}><h4>{group.name} <small className="path-text">{group.root}</small></h4><div className="installation-list">{group.copies.map(copy => <div className="installation-row" key={copy.destination}>
      <div><b>{item.kind === 'agent' ? 'Agent definition' : copy.location ? skillLocationLabel[copy.location] : 'Skill'}</b><code className="path-text">{copy.destination}</code></div>
      <Badge status={copy.state === 'installed' ? copy.outdated ? 'update_available' : 'installed' : copy.state === 'drifted' ? 'drifted' : copy.matches ? 'found' : 'differs'} />
      {copy.targetId && (copy.state === 'drifted' || !copy.matches) && <button className="button" title="See which files differ and how" onClick={() => onCompare(copy)}><FileDiff size={13} />Compare</button>}
      {copy.targetId && copy.outdated && <button className="button" onClick={() => onManage(copy.provider, copy.targetId)}><CircleArrowUp size={13} />Update</button>}
      {copy.targetId ? <button className="button danger-text" onClick={() => onManage(copy.provider, copy.targetId)}><Trash2 size={13} />Remove</button> : <span className="muted small" title="Install into this location with Install into project… to let Kiln manage it.">not managed here</span>}
      <span className="muted small">{installationLabel(copy)}</span>
    </div>)}</div></div>)}
  </section>;
}
