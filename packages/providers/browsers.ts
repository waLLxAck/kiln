import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { YouTubeAuth } from '../protocol/schema';

type Browser = Exclude<YouTubeAuth['youtubeBrowser'], ''>;
export type BrowserSource = { id: Browser; name: string; profiles: { name: string; path: string }[] };
const names: Record<Browser, string> = { brave: 'Brave', chrome: 'Chrome', chromium: 'Chromium', edge: 'Edge', firefox: 'Firefox', opera: 'Opera', safari: 'Safari', vivaldi: 'Vivaldi', whale: 'Whale' };
const directory = (file: string) => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };
/** Browser profile directories only. Cookie contents and browser credentials are never read by discovery. */
export function browserSources(home = os.homedir(), platform: NodeJS.Platform = process.platform, env = process.env, selected?: Partial<YouTubeAuth>): BrowserSource[] {
  const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), roaming = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const config = env.XDG_CONFIG_HOME ?? path.join(home, '.config'), support = path.join(home, 'Library', 'Application Support');
  const layouts: Record<Browser, string[][]> = {
    brave: [[local, 'BraveSoftware/Brave-Browser/User Data'], [support, 'BraveSoftware/Brave-Browser'], [config, 'BraveSoftware/Brave-Browser']],
    chrome: [[local, 'Google/Chrome/User Data'], [support, 'Google/Chrome'], [config, 'google-chrome']],
    chromium: [[local, 'Chromium/User Data'], [support, 'Chromium'], [config, 'chromium']],
    edge: [[local, 'Microsoft/Edge/User Data'], [support, 'Microsoft Edge'], [config, 'microsoft-edge']],
    firefox: [[roaming, 'Mozilla/Firefox/Profiles'], [support, 'Firefox/Profiles'], [home, '.mozilla/firefox']],
    opera: [[roaming, 'Opera Software/Opera Stable'], [support, 'com.operasoftware.Opera'], [config, 'opera']],
    safari: [[], [home, 'Library/Cookies'], []],
    vivaldi: [[local, 'Vivaldi/User Data'], [support, 'Vivaldi'], [config, 'vivaldi']],
    whale: [[local, 'Naver/Naver Whale/User Data'], [support, 'Naver/Whale'], [config, 'naver-whale']],
  };
  const index = platform === 'win32' ? 0 : platform === 'darwin' ? 1 : 2;
  return (Object.keys(names) as Browser[]).flatMap(id => {
    const parts = layouts[id][index], roots = parts.length ? [path.join(parts[0], ...parts[1].split('/'))] : [];
    if (platform === 'linux') {
      if (id === 'firefox') roots.push(path.join(home, 'snap/firefox/common/.mozilla/firefox'), path.join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox'));
      if (id === 'chromium') roots.push(path.join(home, 'snap/chromium/common/chromium'), path.join(home, '.var/app/org.chromium.Chromium/config/chromium'));
      if (id === 'chrome') roots.push(path.join(home, '.var/app/com.google.Chrome/config/google-chrome'));
      if (id === 'brave') roots.push(path.join(home, '.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser'));
      if (id === 'edge') roots.push(path.join(home, '.var/app/com.microsoft.Edge/config/microsoft-edge'));
    }
    if (id === 'safari' && platform === 'darwin') roots.push(path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Cookies'));
    const profiles = new Map<string, { name: string; path: string }>();
    const add = (folder: string) => { if (directory(folder)) profiles.set(folder, { name: path.basename(folder), path: folder }); };
    for (const root of roots) {
      if (!directory(root)) continue;
      if (id === 'safari') { if (fs.existsSync(path.join(root, 'Cookies.binarycookies'))) add(root); continue; }
      if (['Cookies', 'Network/Cookies', 'cookies.sqlite', 'Preferences', 'prefs.js'].some(file => fs.existsSync(path.join(root, file)))) add(root);
      try {
        for (const entry of fs.readdirSync(root)) {
          const folder = path.join(root, entry);
          if (id === 'firefox' ? ['cookies.sqlite', 'prefs.js'].some(file => fs.existsSync(path.join(folder, file))) : /^(Default|Profile \d+)$/.test(entry) || fs.existsSync(path.join(folder, 'Preferences'))) add(folder);
        }
      } catch { /* An inaccessible profile is omitted. */ }
    }
    if (selected?.youtubeBrowser === id && selected.youtubeBrowserProfile && path.isAbsolute(selected.youtubeBrowserProfile)) add(selected.youtubeBrowserProfile);
    return profiles.size ? [{ id, name: names[id], profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)) }] : [];
  });
}
