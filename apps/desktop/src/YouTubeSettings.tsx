import { useEffect, useState } from 'react';
import type { Settings, YouTubeAuth } from '../../../packages/protocol/schema';
import type { BrowserSource } from '../../../packages/providers/browsers';
import { api } from './api';
import { Field, InlineError } from './components';

export function YouTubeSettings({ settings, perform, refresh }: { settings: Settings; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void> }) {
  const [browser, setBrowser] = useState(settings.youtubeBrowser ?? '');
  const [profile, setProfile] = useState(settings.youtubeBrowserProfile ?? '');
  const [sources, setSources] = useState<BrowserSource[]>([]), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  useEffect(() => { let active = true; void api<BrowserSource[]>('settings.youtubeSources').then(value => { if (active) { setSources(value); setLoaded(true); } }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  useEffect(() => { setBrowser(settings.youtubeBrowser ?? ''); setProfile(settings.youtubeBrowserProfile ?? ''); }, [settings.youtubeBrowser, settings.youtubeBrowserProfile]);
  const selected = sources.find(source => source.id === browser), profiles = selected?.profiles ?? [];
  const availableBrowser = selected ? browser : '', availableProfile = profiles.find(p => p.path === profile || p.name === profile)?.path ?? '';
  return <section className="settings-card"><h3>YouTube</h3>
    <p>If YouTube asks you to confirm you’re not a bot, open the video in your browser, sign in and complete the check. Choose that browser here so Kiln can use its cookies when fetching captions.</p>
    <InlineError error={error} />
    {loaded && browser && !selected && <p className="muted small">The saved browser profile is no longer on this machine. Choose an available browser.</p>}
    <form onSubmit={event => { event.preventDefault(); void perform(async () => { await api('settings.youtube', { youtubeBrowser: availableBrowser, youtubeBrowserProfile: availableBrowser ? availableProfile : '' }); await refresh(); }, 'YouTube settings saved'); }}>
      <Field label="YouTube cookies from browser"><select aria-label="YouTube cookies from browser" disabled={!loaded} value={availableBrowser} onChange={event => { setBrowser(event.target.value as YouTubeAuth['youtubeBrowser']); setProfile(''); }}>
        <option value="">No browser (use ~/cookies.txt if present)</option>
        {sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}
      </select></Field>
      <Field label="Browser profile" hint="Only profile folders found on this machine are listed."><select aria-label="Browser profile" value={availableProfile} onChange={event => setProfile(event.target.value)} disabled={!availableBrowser || selected?.id === 'safari'}><option value="">Most recently used profile</option>{profiles.map(value => <option key={value.path} value={value.path}>{value.name} · {value.path}</option>)}</select></Field>
      <p className="muted small">The selected browser’s cookies are read locally by yt-dlp. This choice stays on this machine. If cookies cannot be read, export YouTube cookies to <code>cookies.txt</code> in your home folder and choose “No browser”.</p>
      <button className="button" type="submit" disabled={!loaded}>Save YouTube settings</button>
    </form>
  </section>;
}
