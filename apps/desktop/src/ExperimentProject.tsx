import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Target } from '../../../packages/protocol/schema';
import { api } from './api';
import { Field } from './components';

/** A run location is independent of deployment enrollment and provider. */
export function ExperimentProject({ targets, value, onChange, disabled = false }: { targets: Target[]; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [error, setError] = useState('');
  const projects = [...new Map(targets.filter(t => t.scope === 'project').map(t => [t.root, t])).values()];
  const browse = async () => {
    setError('');
    try { const folder = await api<string | null>('desktop.chooseDirectory'); if (folder) onChange(folder); }
    catch (error) { setError(String(error)); }
  };
  return <>
    <Field label="Project / repository" hint="Select a local project, or use an isolated example without a repository.">
      <select value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
        <option value="">No project — isolated example</option>
        {value && !projects.some(t => t.root === value) && <option value={value}>{value}</option>}
        {projects.map(t => <option key={t.root} value={t.root}>{t.name} — {t.root}</option>)}
      </select>
    </Field>
    <div className="wrap-actions"><button type="button" className="button" disabled={disabled} onClick={() => void browse()}><FolderOpen size={14} />Choose project folder…</button></div>
    {value && <p className="path-text">{value}</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
  </>;
}
