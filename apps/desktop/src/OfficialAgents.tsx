import { useEffect, useState } from 'react';
import { Download, RefreshCw, Terminal } from 'lucide-react';
import type { Provider, RunProviderId } from '../../../packages/protocol/schema';
import type { ClientUpdate } from '../../../packages/providers/clients';
import { api } from './api';
import { Badge, InlineError } from './components';

export function OfficialAgents({ providers, error, onChanged }: { providers: Provider[]; error: string; onChanged: (providers: Provider[]) => void }) {
  const [updates, setUpdates] = useState<ClientUpdate[]>([]), [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<RunProviderId | null>(null), [failure, setFailure] = useState('');
  const check = async (force = false) => {
    setChecking(true);
    try { setUpdates(await api<ClientUpdate[]>('providers.updates', { force })); }
    catch (e) { setFailure(String(e)); }
    finally { setChecking(false); }
  };
  useEffect(() => { void check(); }, []);
  const install = async (provider: RunProviderId) => {
    setBusy(provider); setFailure('');
    try { onChanged(await api<Provider[]>('providers.install', { provider, confirm: true })); await check(true); }
    catch (e) { setFailure(String(e)); }
    finally { setBusy(null); }
  };
  return <>
    <InlineError error={failure || error} />
    {providers.map(provider => {
      const update = updates.find(value => value.provider === provider.id), supported = provider.id !== 'copilot';
      return <div className="provider-row" key={provider.id}><div className={`provider-mark ${provider.id}`}><Terminal size={18} /></div>
        <div><b>{provider.label}</b><small>{provider.available ? provider.version : 'Not installed'}</small>{provider.error && <small>{provider.error}</small>}{update?.error && <small>{update.error}</small>}</div>
        {supported && (!provider.available || update?.updateAvailable) ? <button className="button" disabled={busy !== null} onClick={() => void install(provider.id as RunProviderId)}><Download size={14} />{busy === provider.id ? 'Installing…' : provider.available ? `Update to ${update!.latestVersion}` : `Install ${provider.label}`}</button> : <Badge status={provider.available ? 'detected' : 'unavailable'} />}
      </div>;
    })}
    <p className="muted small">Install and update with the official native installers. After installing, sign in through the official client to run agents.</p>
    <button className="button" disabled={checking || busy !== null} onClick={() => { setFailure(''); void api<Provider[]>('providers.detect', { refresh: true }, { fresh: true }).then(onChanged).then(() => check(true)).catch(e => setFailure(String(e))); }}><RefreshCw size={14} />{checking ? 'Checking…' : 'Check for updates'}</button>
  </>;
}
