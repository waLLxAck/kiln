import { useState, type FormEvent } from 'react';
import { ArrowRight, Copy, FolderOpen, ShieldCheck } from 'lucide-react';
import type { ItemDetail, Plan, Provider, Snapshot, Target, Trial } from '../../../packages/protocol/schema';
import { api, shortHash, variablesIn } from './api';
import { ExperimentProject } from './ExperimentProject';
import { Badge, Field, InlineError, Modal, Submit } from './components';
import { machinesEnabled } from './features';

type Common = { onClose: () => void; onDone: (id?: string) => void };
const values = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); return Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>; };
function useSubmit() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); } };
  return { busy, error, run };
}

export function VariablesDialog({ detail, onClose, onDone }: Common & { detail: ItemDetail }) {
  const { busy, error, run } = useSubmit();
  // Every variable is optional: blank fields keep their {{name}} placeholder in the copied text.
  const copy = (variables: Record<string, string>) => void run(async () => { await api('desktop.copy', { id: detail.item.id, revision: detail.item.revision, variables }); onDone(); });
  return <Modal title="Fill in variables" subtitle={detail.item.title} onClose={onClose}><form onSubmit={event => copy(values(event))} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
    <p className="muted small">All optional. Blank fields stay as <code>{'{{name}}'}</code> in the copied text; your saved template stays unchanged.</p>
    {variablesIn(detail.revision.content).map((key, i) => <Field label={key} key={key}><textarea autoFocus={i === 0} name={key} rows={3} placeholder={`Leave blank to keep {{${key}}}`} /></Field>)}<InlineError error={error} /><div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={() => copy({})}>Copy without filling</button><Submit busy={busy}><Copy size={15} />Copy</Submit></div>
  </form></Modal>;
}

export function TrialDialog({ detail, providers, targets, initialWorkspace = '', onClose, onDone }: Common & { detail: ItemDetail; providers: Provider[]; targets: Target[]; initialWorkspace?: string }) {
  const { busy, error, run } = useSubmit(); const [prepared, setPrepared] = useState<{ trial: Trial; folder: string; prompt: string } | null>(null);
  const [provider, setProvider] = useState('codex'), [workspace, setWorkspace] = useState(initialWorkspace);
  return <Modal title={prepared ? 'Your trial is ready' : 'Test this revision'} subtitle={`${detail.item.title} · ${shortHash(detail.item.revision)}`} onClose={onClose} wide>
    {prepared ? <><div className="callout"><ArrowRight size={22} /><span>Open your signed-in official agent, start a session {workspace ? <>in <code>{workspace}</code></> : <>in a trusted workspace</>}, and paste this prompt. Return to attach the result and your judgement.</span></div><ol className="handoff-steps"><li>Use the agent’s normal login and permission prompts.</li><li>Review inherited workspace instructions and hooks before running.</li><li>Keep the exact prompt below; it identifies this trial’s revision.</li></ol><pre className="prompt-preview">{prepared.prompt}</pre><p className="path-text">{prepared.folder}</p><div className="modal-actions"><button className="button" onClick={() => void run(async () => { await api('desktop.openRun', { id: prepared.trial.id }); })}><FolderOpen size={16} />Run folder</button><button className="button" onClick={() => void run(async () => { await api('desktop.copyTrial', { id: prepared.trial.id }); })}><Copy size={16} />Copy handoff</button><button className="button primary" onClick={() => onDone()}>Done</button></div><InlineError error={error} /></> : <form onSubmit={event => { const v = values(event); const variables = Object.fromEntries(variablesIn(detail.revision.content).filter(k => v[`var:${k}`]?.trim()).map(k => [k, v[`var:${k}`]])); void run(async () => setPrepared(await api('trials.create', { id: detail.item.id, revision: detail.item.revision, provider, variables, task: v.task, rubric: v.rubric.split('\n').filter(Boolean), case: v.case, workspace, retainInput: v.retainInput === 'on', agentVersion: providers.find(p => p.id === provider)?.version ?? 'unknown' }))); }}>
      <div className="form-grid"><Field label="Official agent"><select value={provider} onChange={e => setProvider(e.target.value)}><option value="codex">Codex · manual handoff</option><option value="claude">Claude Code · manual handoff</option><option value="manual">Another agent · manual handoff</option></select></Field><Field label="Test case"><select name="case"><option value="typical">Typical case</option><option value="boundary">Boundary / failure case</option></select></Field></div>
      <p className="muted">{provider === 'manual' ? 'Use the agent you choose.' : providers.find(p => p.id === provider)?.available ? `${providers.find(p => p.id === provider)?.version} · authentication stays in the official client` : 'Client not detected on PATH. You can still hand off to your installed app.'}</p>
      {variablesIn(detail.revision.content).map(key => <Field label={`${key} (optional)`} hint={`Leave blank to keep {{${key}}} in the prompt.`} key={key}><textarea name={`var:${key}`} rows={2} /></Field>)}
      <Field label="Representative task"><textarea name="task" required rows={4} placeholder="What should this prompt accomplish? Include a realistic input." /></Field><Field label="Evaluation rubric" hint="One criterion per line."><textarea name="rubric" required rows={3} placeholder={'Produces a usable result\nDoes not invent facts\nHandles missing inputs clearly'} /></Field>
      <ExperimentProject targets={targets} value={workspace} onChange={setWorkspace} disabled={busy} />
      <label className="check-row"><input type="checkbox" name="retainInput" /><span>Include task inputs and variables in the Git-owned experiment summary</span></label><p className="muted small">By default, inputs and output transcripts remain only in this machine’s private run folder.</p>
      <InlineError error={error} /><div className="modal-actions"><span className="muted">No API key. No automatic execution.</span><Submit busy={busy}>Prepare trial <ArrowRight size={15} /></Submit></div>
    </form>}
  </Modal>;
}

export function ResultDialog({ trial, onClose, onDone }: Common & { trial: Trial }) {
  const { busy, error, run } = useSubmit();
  return <Modal title="Record the result" subtitle={`${trial.case} case · ${shortHash(trial.revision)}`} onClose={onClose} wide><form onSubmit={event => { const v = values(event); void run(async () => { await api('trials.finish', { ...v, id: trial.id }); onDone(); }); }}>
    <div className="callout"><span>{trial.rubric.map(r => <div key={r}>• {r}</div>)}</span></div><Field label="Your judgement"><select name="judgement"><option value="pass">Pass</option><option value="fail">Fail</option><option value="uncertain">Uncertain</option></select></Field><Field label="What happened?"><textarea required name="note" rows={3} autoFocus placeholder="Record what passed, what failed, and what you learned." /></Field><Field label="Output transcript (stored only on this machine)"><textarea className="code-input" name="output" rows={6} placeholder="Paste the agent’s result, or add a reference below" /></Field><Field label="Output reference (alternative)"><input name="outputReference" placeholder="A session link or local transcript path" /></Field><InlineError error={error} /><div className="modal-actions"><button type="button" className="button danger-text" onClick={() => void run(async () => { await api('trials.finish', { id: trial.id, cancel: true, judgement: 'uncertain', note: 'Cancelled by user' }); onDone(); })}>Cancel handoff</button><Submit busy={busy}>Save judgement</Submit></div><p className="muted small">Cancelling this record does not stop an agent running in another window.</p>
  </form></Modal>;
}

export function DeployDialog({ detail, snapshot, onClose, onDone }: Common & { detail: ItemDetail; snapshot: Snapshot }) {
  const { busy, error, run } = useSubmit(); const [plan, setPlan] = useState<Plan | null>(null);
  const approved = detail.approvals.filter(a => a.trust === 'local').filter((a, i, all) => all.findIndex(b => b.revision === a.revision) === i);
  return <Modal title="Install into an enrolled environment" subtitle="For project folders and earlier approved revisions. Personal skill folders use the one-click toggles instead." onClose={onClose} wide>
    {!plan ? <form onSubmit={event => { const v = values(event); void run(async () => setPlan(await api('deploy.plan', { ...v, itemId: detail.item.id }))); }}><Field label="Approved revision"><select name="revision" required>{approved.map(a => <option key={a.id} value={a.revision}>{shortHash(a.revision)} · {a.scope}{a.revision === detail.item.revision ? ' · current' : ' · earlier revision'}</option>)}</select></Field><Field label="Environment"><select name="targetId" required>{snapshot.targets.map(t => <option value={t.id} key={t.id}>{t.name} · {t.provider} · {t.profile}</option>)}</select></Field>{!snapshot.targets.length && <p className="callout">{machinesEnabled ? 'Enroll a folder in Machines first, or turn on a skill location in Settings.' : 'Turn on a skill location in Settings first.'} Nothing is installed automatically.</p>}<InlineError error={error} /><div className="modal-actions"><span className="muted">Preview does not write to your agent folders.</span><Submit busy={busy || !snapshot.targets.length || !approved.length}>Preview install</Submit></div></form> : <>
      <div className="plan-summary"><Badge status={plan.operation} /><code>{shortHash(plan.revision)}</code><span>→</span><code className="path-text">{plan.destination}</code></div>
      <div className="file-preview-list">{Object.entries(plan.files).map(([file, content]) => <div key={file}><span>{file === '.instruction' ? plan.destination.split(/[\\/]/).at(-1) : file}</span><span className="muted">{Math.round(content.length * .75).toLocaleString()} bytes</span></div>)}</div>
      {plan.files['SKILL.md'] && <pre className="prompt-preview">{new TextDecoder().decode(Uint8Array.from(atob(plan.files['SKILL.md']), c => c.charCodeAt(0)))}</pre>}
      {plan.files['.instruction'] && <pre className="prompt-preview">{new TextDecoder().decode(Uint8Array.from(atob(plan.files['.instruction']), c => c.charCodeAt(0)))}</pre>}
      {plan.blocked ? <InlineError error={plan.blocked} /> : <div className="callout"><ShieldCheck size={20} /><span>{plan.operation === 'replace' ? 'This replaces a Kiln-owned snapshot. A receipt preserves the previous approved bundle for rollback.' : 'This creates a new managed snapshot.'} Start a new agent session after applying.</span></div>}
      <InlineError error={error} /><div className="modal-actions"><button className="button" onClick={() => setPlan(null)}>Back</button><button className="button primary" disabled={busy || Boolean(plan.blocked)} onClick={() => void run(async () => { await api('deploy.apply', { planId: plan.id, expectState: plan.expectedState, confirm: true }); onDone(); })}>Confirm & install</button></div>
    </>}
  </Modal>;
}

export function TargetDialog({ onClose, onDone }: Common) {
  const [root, setRoot] = useState(''); const { busy, error, run } = useSubmit();
  return <Modal title="Enroll a project folder" subtitle="Kiln may then install skills and instructions inside this folder. Personal home folders are set up in Settings → Skill locations." onClose={onClose}><form onSubmit={event => { const v = values(event); void run(async () => { await api<Target>('targets.enroll', { ...v, root }); onDone(); }); }}>
    <Field label="Name"><input name="name" required autoFocus placeholder="Personal Codex, Work Claude…" /></Field><div className="form-grid"><Field label="Agent"><select name="provider"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="copilot">GitHub Copilot</option></select></Field><Field label="Scope"><select name="scope"><option value="project">Project folder</option><option value="personal">Personal home folder</option></select></Field></div><Field label="Profile"><input name="profile" defaultValue="Personal" required /></Field><Field label="Allowed root"><div className="input-button"><input value={root} onChange={e => setRoot(e.target.value)} required placeholder="Choose an existing folder" /><button type="button" className="button" onClick={() => void run(async () => { const picked = await api<string | null>('desktop.chooseDirectory'); if (picked) setRoot(picked); })}><FolderOpen size={16} />Browse</button></div></Field><div className="callout">Codex skills use .agents/skills; Claude skills use .claude/skills. Copilot uses .copilot/skills personally and .github/skills in projects. Instructions preserve the selected agent and scope. Existing unmanaged files block replacement.</div><InlineError error={error} /><div className="modal-actions"><span className="muted">Local machine · no files deployed yet</span><Submit busy={busy}>Enroll environment</Submit></div>
  </form></Modal>;
}
