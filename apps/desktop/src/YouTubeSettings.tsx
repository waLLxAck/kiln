import { useEffect, useState } from 'react';
import { youtubeAuthSchema, type Settings, type YouTubeAuth } from '../../../packages/protocol/schema';
import { api } from './api';
import { Field } from './components';

const browserNames: Record<string, string> = { brave: 'Brave', chrome: 'Chrome', chromium: 'Chromium', edge: 'Edge', firefox: 'Firefox', opera: 'Opera', safari: 'Safari', vivaldi: 'Vivaldi', whale: 'Whale' };

export function YouTubeSettings({ settings, perform, refresh }: { settings: Settings; perform: (action: () => Promise<unknown>, message?: string) => Promise<void>; refresh: () => Promise<void> }) {
  const [browser, setBrowser] = useState(settings.youtubeBrowser ?? '');
  const [profile, setProfile] = useState(settings.youtubeBrowserProfile ?? '');
  useEffect(() => { setBrowser(settings.youtubeBrowser ?? ''); setProfile(settings.youtubeBrowserProfile ?? ''); }, [settings.youtubeBrowser, settings.youtubeBrowserProfile]);
  return <section className="settings-card"><h3>YouTube</h3>
    <p>If YouTube asks you to confirm you’re not a bot, open the video in your browser, sign in and complete the check. Choose that browser here so Kiln can use its cookies when fetching captions.</p>
    <form onSubmit={event => { event.preventDefault(); void perform(async () => { await api('settings.youtube', { youtubeBrowser: browser, youtubeBrowserProfile: profile }); await refresh(); }, 'YouTube settings saved'); }}>
      <Field label="YouTube cookies from browser"><select aria-label="YouTube cookies from browser" value={browser} onChange={event => setBrowser(event.target.value as YouTubeAuth['youtubeBrowser'])}>
        <option value="">No browser (use ~/cookies.txt if present)</option>
        {youtubeAuthSchema.shape.youtubeBrowser.removeDefault().options.filter(Boolean).map(value => <option key={value} value={value}>{browserNames[value]}</option>)}
      </select></Field>
      <Field label="Browser profile" hint="Optional profile name or folder path. Leave blank to use the browser’s most recently used profile."><input aria-label="Browser profile" value={profile} onChange={event => setProfile(event.target.value)} disabled={!browser} maxLength={1000} placeholder="Most recently used profile" /></Field>
      <p className="muted small">The selected browser’s cookies are read locally by yt-dlp. This choice stays on this machine. If cookies cannot be read, export YouTube cookies to <code>cookies.txt</code> in your home folder and choose “No browser”.</p>
      <button className="button" type="submit">Save YouTube settings</button>
    </form>
  </section>;
}
