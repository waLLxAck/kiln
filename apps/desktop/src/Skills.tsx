import { skillLocation, skillLocationLabel, targetSkillsFolder, sharedSkillReaders, compatibilityChecked } from '../../../packages/providers/skill-locations';
import { agentFolder } from '../../../packages/domain/agent-format';
import { useEffect, useState } from 'react';
import { Check, Download, FileDiff, FolderOpen, Link2, Settings, TriangleAlert } from 'lucide-react';
import type { Installation, Item, Provider, ProviderId, Snapshot, Target } from '../../../packages/protocol/schema';
import { api } from './api';
import { Badge, InlineError, Modal, providerName } from './components';
import { FolderComparison } from './Compare';

import { personalTarget } from './skill-folders';
export { personalTarget };
export type SkillState = 'off' | 'on' | 'linked' | 'found' | 'differs' | 'drifted';
export function skillState(item: Item, target: Target, installations: Installation[]): { state: SkillState; installation?: Installation } {
  const installation = installations.find(i => i.itemId === item.id && i.targetId === target.id);
  if (!installation) return { state: 'off' };
  if (installation.state === 'installed') return { state: 'on', installation };
  if (installation.state === 'drifted') return { state: 'drifted', installation };
  if (installation.linked) return { state: 'linked', installation };
  return { state: installation.matches ? 'found' : 'differs', installation };
}
const stateHint: Record<SkillState, string> = {
  off: 'Not in this folder. Click to install the approved version.',
  on: 'Installed by Kiln and identical to the approved version. Click to remove.',
  linked: 'A link (junction) points somewhere else. Click to remove the link or replace it with a real copy.',
  found: 'An identical copy exists that Kiln does not manage yet. Click to let Kiln manage or remove it.',
  differs: 'The installed copy differs from the approved version. Click to replace or remove it.',
  drifted: 'Installed by Kiln, then edited outside Kiln. Click to reinstall the approved version or remove.',
};
/** Primary folders stay visible; client-specific copies are available on demand. */
export function SkillToggles({ item, providers, snapshot, installations, onToggle, onSetup }: { item: Item; providers: Provider[]; snapshot: Snapshot; installations: Installation[]; onToggle: (provider: ProviderId, targetId?: string) => void; onSetup: () => void }) {
  const locations = providers.filter(p => item.kind === 'agent' ? p.id === item.agent?.provider : p.id !== 'copilot').map(p => ({ provider: p, target: personalTarget(snapshot.targets, providers, p.id) })).filter(l => l.target) as { provider: Provider; target: Target }[];
  const extras = item.kind === 'skill' ? installations.filter(i => i.itemId === item.id && (i.location === 'codex' || i.location === 'copilot')) : [];
  const extraTargets = item.kind === 'skill' ? snapshot.targets.filter(t => t.scope === 'personal' && (t.provider === 'copilot' || t.skillFolder)) : [];
  const toggle = (provider: Provider, target: Target) => {
    const { state } = skillState(item, target, installations);
    return <button key={target.id} className={`skill-toggle ${state}`} title={`${stateHint[state]} ${target.root}/${item.kind === 'agent' ? agentFolder(target.provider, target.scope) : targetSkillsFolder(target)}`} aria-pressed={state !== 'off'} onClick={() => onToggle(provider.id, target.id)}>
      {state === 'on' ? <Check size={14} /> : state === 'linked' ? <Link2 size={14} /> : state === 'off' ? <Download size={14} /> : <TriangleAlert size={14} />}<span>{item.kind === 'agent' ? provider.label : skillLocationLabel[skillLocation(target)]}</span><small>{state === 'off' ? 'Install' : state === 'on' ? 'Installed' : state === 'found' ? 'found' : state === 'linked' ? 'linked' : state === 'differs' ? 'differs' : 'edited'}</small>
    </button>;
  };
  return <div className="installation-locations"><div className="skill-toggles" role="group" aria-label="Installed for">{locations.map(({ provider, target }) => toggle(provider, target))}{!locations.length && <button className="button" onClick={onSetup}><Settings size={15} />Set up install locations</button>}</div>
    {item.kind === 'skill' && <details className="other-copies"><summary>Client-specific copies{extras.length ? ` (${extras.length})` : ''}</summary><p className="small muted">These are separate folders. Codex and Copilot can also read the shared Agents installation. Folder presence does not prove a client has loaded it.</p><div className="skill-toggles">{extraTargets.map(target => toggle(providers.find(p => p.id === target.provider)!, target))}</div>{extras.map(copy => <div key={copy.destination}><b>{skillLocationLabel[copy.location!]}</b><span className="muted small"> · {copy.linked ? 'linked' : copy.matches ? 'matches library' : 'differs from library'}</span><code className="path-text">{copy.destination}</code></div>)}{!extras.length && <p className="small muted">No client-specific copies found in the configured homes or projects.</p>}<button className="text-button" onClick={onSetup}>Manage locations in Settings</button></details>}
  </div>;
}

export function SkillLocationSettings({ providers, targets, onSet, onScan }: { providers: Provider[]; targets: Target[]; onSet: (provider: Provider, on: boolean, native?: boolean) => void; onScan: (provider: ProviderId, target: Target) => void }) {
  const row = (provider: Provider, native = false) => {
    const target = personalTarget(targets, providers, provider.id, native);
    const shape = target ?? { provider: provider.id, scope: 'personal' as const, skillFolder: native ? '.codex/skills' as const : undefined };
    const root = target?.root ?? provider.personalRoot;
    return <div className="check-row location-row" key={`${provider.id}-${native}`}><input aria-label={`Manage ${skillLocationLabel[skillLocation(shape)]}`} type="checkbox" checked={Boolean(target)} onChange={e => onSet(provider, e.target.checked, native)} /><div><b>{skillLocationLabel[skillLocation(shape)]}</b><small className="location-kind">Skills</small><code className="path-text">{root}/{targetSkillsFolder(shape)}</code>{!native && <><small className="location-kind">{provider.label} agent definitions · client-specific</small><code className="path-text">{root}/{agentFolder(provider.id, 'personal')}</code></>}{target && <button type="button" className="text-button" onClick={() => onScan(provider.id, target)}><FolderOpen size={13} />{native ? 'Find skills not in the library' : 'Find skills and agents not in the library'}</button>}</div></div>;
  };
  return <><p>Install skills into shared Agents or Claude folders. Agent definitions keep their client’s format and folder. Removing an installation keeps the library item and its history.</p>{providers.filter(p => p.id !== 'copilot').map(p => row(p))}<p className="small muted">Agents is shared by Codex, Copilot, Cursor and other clients. Claude folders can also be read by some other clients. These labels describe locations, not exclusive access.</p><details><summary>Clients that read .agents/skills</summary><p className="small muted">Checked {compatibilityChecked}. Client versions, disabled skills, workspace trust and folder precedence affect what is loaded.</p><ul>{sharedSkillReaders.map(reader => <li key={reader.name}><a href={reader.url} target="_blank" rel="noreferrer">{reader.name}</a> — {reader.note}</li>)}</ul><p className="small muted">The <a href="https://github.com/vercel-labs/skills/blob/main/src/agents.ts" target="_blank" rel="noreferrer">skills installer registry</a> also uses this project convention for Antigravity, Antigravity CLI, Cline, Deep Agents, Dexto, Firebender, Loaf, Replit and PromptScript. Their personal-folder loading is not verified here.</p></details><details><summary>Client-specific locations</summary><p className="small muted">Optional separate copies. A missing folder does not mean skills are unavailable to that client. Codex’s .codex/skills folder is also used by older clients and installers.</p>{providers.filter(p => p.id === 'codex').map(p => row(p, true))}{providers.filter(p => p.id === 'copilot').map(p => row(p))}</details></>;
}
/** Explains exactly what will happen in the agent folder before installing or removing. */
export function SkillInstallDialog({ item, provider, target, installations, approved, onClose, onDone }: { item: Item; provider: Provider; target: Target; installations: Installation[]; approved: boolean; onClose: () => void; onDone: (message: string) => void }) {
  const { state, installation } = skillState(item, target, installations);
  const label = item.kind === 'agent' ? provider.label : skillLocationLabel[skillLocation(target)];
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  // A "differs" or "drifted" verdict opens with the file comparison visible, so the decision is made on evidence rather than a label.
  const [comparing, setComparing] = useState(state === 'differs' || state === 'drifted');
  const destination = installation?.destination ?? (item.kind === 'agent' ? `${target.root}/${agentFolder(target.provider, target.scope)}/${item.agent?.filename}` : `${target.root}/${targetSkillsFolder(target)}\\${item.title}`);
  const run = async (action: () => Promise<{ method?: string; destination: string }>, message: string) => { setBusy(true); setError(''); try { const result = await action(); onDone(message.replace('{method}', result.method ?? '')); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); } };
  const install = (replace = false) => run(() => api('skills.install', { itemId: item.id, targetId: target.id, replace, confirm: true }), `${item.title}: {method} for ${label}. Start a new client session to use it.`);
  const remove = (force = false) => run(() => api('skills.remove', { itemId: item.id, targetId: target.id, force, confirm: true }), `${item.title} removed from ${label} ({method}). The item stays in your library.`);
  const reveal = () => void api('desktop.revealPath', { path: destination }).catch(e => setError(String(e)));
  const titles: Record<SkillState, string> = { off: `Install for ${label}`, on: `Remove from ${label}`, linked: `Linked copy in ${label}`, found: `Existing copy in ${label}`, differs: `Different version in ${label}`, drifted: `Edited copy in ${label}` };
  return <Modal title={titles[state]} subtitle={item.title} onClose={onClose} wide={comparing}>
    <code className="path-text">{destination}</code>
    {state === 'off' && <><p>{item.kind === 'agent' ? 'Kiln copies the agent definition to this file.' : 'Kiln copies SKILL.md and the bundled files into this folder.'} Clients that read this location can use it in new sessions.</p>{!approved && <p className="notice">This draft is not approved yet. Installing approves exactly this revision and pushes it to your Kiln repo on GitHub.</p>}</>}
    {state === 'on' && <p>The installed copy is deleted. Your library keeps the item, its history and approvals, and you can install it again later.</p>}
    {state === 'linked' && <p>This entry is a link to a folder elsewhere on this machine, probably created by another installer. Removing deletes only the link; the folder it points to is untouched. Replacing it turns it into a real copy managed by Kiln.</p>}
    {state === 'found' && <p>These files are byte-for-byte the same as the approved version, but Kiln did not put them there. Letting Kiln manage the folder records ownership without rewriting anything, so future updates and removal work from here.</p>}
    {state === 'differs' && <p>The installed copy differs from the approved version in Kiln. Replacing sets the current folder aside (kept under Kiln’s private data, not deleted) and installs the approved version. Open the folder first if you want to bring those changes into Kiln.</p>}
    {state === 'drifted' && <p>Kiln installed this item, and the copy was edited afterwards. Reinstalling sets the edited copy aside (kept, not deleted) and writes the approved version again.</p>}
    {installation && <button className="text-button" aria-expanded={comparing} onClick={() => setComparing(!comparing)}><FileDiff size={14} />{comparing ? 'Hide file comparison' : 'Compare the installed copy with the approved version'}</button>}
    {installation && comparing && <FolderComparison itemId={item.id} targetId={target.id} />}
    <InlineError error={error} />
    <div className="modal-actions">
      {state !== 'off' && <button className="button" onClick={reveal}><FolderOpen size={14} />Open folder</button>}
      <button className="button" onClick={onClose}>Cancel</button>
      {state === 'off' && <button className="button primary" disabled={busy} onClick={() => void install()}>Install</button>}
      {state === 'on' && <button className="button primary" disabled={busy} onClick={() => void remove()}>Remove</button>}
      {state === 'linked' && <><button className="button danger-text" disabled={busy} onClick={() => void remove()}>Remove link</button><button className="button primary" disabled={busy} onClick={() => void install()}>Replace with a copy</button></>}
      {state === 'found' && <><button className="button danger-text" disabled={busy} onClick={() => void remove()}>Remove</button><button className="button primary" disabled={busy} onClick={() => void install()}>Let Kiln manage it</button></>}
      {(state === 'differs' || state === 'drifted') && <><button className="button danger-text" disabled={busy} onClick={() => void remove(true)}>Remove anyway</button><button className="button primary" disabled={busy} onClick={() => void install(true)}>{state === 'drifted' ? 'Reinstall approved version' : 'Replace with approved version'}</button></>}
    </div>
  </Modal>;
}
type ScanEntry = { cleanup?: 'link' | 'folder' | null; kind: 'skill' | 'agent'; error: string; name: string; destination: string; linked: boolean; hasSkillFile: boolean; realPath: string };
/** Shows skill folders in a location that no library item knows about, with one-click import. */
export function ScanDialog({ target, provider, onClose, onImported }: { target: Target; provider: Provider; onClose: () => void; onImported: () => Promise<void> }) {
  const [result, setResult] = useState<{ root: string; agentsRoot: string; entries: ScanEntry[] } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(''), [done, setDone] = useState<string[]>([]);
  useEffect(() => { void api<{ root: string; agentsRoot: string; entries: ScanEntry[] }>('skills.scan', { targetId: target.id }).then(setResult).catch(e => setError(String(e))); }, [target.id]);
  const importOne = async (entry: ScanEntry) => { setBusy(entry.destination); setError(''); try { if (entry.kind === 'agent') { const result = await api<{ failed: string[] }>('agents.import', { files: [{ path: entry.destination, provider: target.provider }], confirm: true }); if (result.failed.length) throw new Error(result.failed.join('\n')); } else await api('skills.import', { targetId: target.id, name: entry.name }); setDone(d => [...d, entry.destination]); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); } };
  const pending = result?.entries.filter(e => e.hasSkillFile && !done.includes(e.destination)) ?? [];
  return <Modal title={`Discover in ${skillLocationLabel[skillLocation(target)]}`} subtitle={target.root} onClose={() => { void onImported(); onClose(); }} wide>
    <p>Importing adds drafts to the library and leaves the originals untouched.</p>{result && <div className="scan-roots"><small>Skills</small><code className="path-text">{result.root}</code>{!target.skillFolder && <><small>{provider.label} agent definitions</small><code className="path-text">{result.agentsRoot}</code></>}</div>}
    <InlineError error={error} />
    {!result ? <p className="muted">Reading folders…</p> : !result.entries.length ? <p className="empty-inline">No new skills or agents found here.</p> : <div className="inventory-list">{result.entries.map(entry => <div key={entry.destination}><div><div className="scan-entry-heading"><b>{entry.name}</b><Badge status={entry.cleanup ? 'cleanup' : entry.kind} /></div><code className="path-text">{entry.destination}</code>{entry.linked && <small>Link → {entry.realPath}</small>}{!entry.hasSkillFile && <p className="small muted">{entry.error || 'No SKILL.md inside; skipped.'}</p>}</div>{done.includes(entry.destination) ? <Badge status={entry.cleanup ? 'removed' : 'imported'} /> : entry.cleanup ? <button className="button" disabled={Boolean(busy)} onClick={async () => { setBusy(entry.destination); try { await api('skills.cleanEntry', { targetId: target.id, name: entry.name, confirm: true }); setDone(d => [...d, entry.destination]); } catch (e) { setError(String(e)); } finally { setBusy(''); } }}>Remove {entry.cleanup === 'link' ? 'broken link' : 'empty folder'}</button> : <button className="button" disabled={!entry.hasSkillFile || Boolean(busy)} onClick={() => void importOne(entry)}>{busy === entry.destination ? 'Importing…' : 'Import'}</button>}</div>)}</div>}
    <div className="modal-actions"><span className="muted">{done.length ? `${done.length} handled` : ''}</span><button className="button" disabled={!pending.length || Boolean(busy)} onClick={async () => { for (const entry of pending) await importOne(entry); }}>Import all {pending.length ? `(${pending.length})` : ''}</button><button className="button primary" onClick={() => { void onImported(); onClose(); }}>Done</button></div>
  </Modal>;
}
