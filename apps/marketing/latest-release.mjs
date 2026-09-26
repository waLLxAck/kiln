// The newest published Kiln release and its download links, read from GitHub when the site is built. The site always offers the
// files that release actually has, so nothing here needs editing when a version ships. Shared by vite.config.ts and
// scripts/verify-marketing.mjs.

export const repository = 'https://github.com/waLLxAck/kiln';
export const releasesPage = `${repository}/releases`;
/** Which release asset each download on the page is, by file name. Anything missing from a release links to that release's page. */
const patterns = {
  windows: /^Kiln[ .-]Setup[ .-]\d+\.\d+\.\d+\.exe$/,
  'mac-arm64': /-arm64\.dmg$/,
  'mac-x64': /-x64\.dmg$/,
  appimage: /\.AppImage$/,
  deb: /_amd64\.deb$/,
  targz: /-x64\.tar\.gz$/,
};

/**
 * @returns {Promise<{ version: string; page: string; assets: Record<keyof typeof patterns, string> }>}
 * Uses GITHUB_TOKEN when set (the Pages workflow passes one) to stay clear of the unauthenticated rate limit.
 */
export async function latestRelease(fetcher = fetch, token = process.env.GITHUB_TOKEN) {
  const response = await fetcher('https://api.github.com/repos/waLLxAck/kiln/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'kiln-marketing-build', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the latest release.`);
  /** @type {{ tag_name: string; html_url: string; assets: { name: string; browser_download_url: string }[] }} */
  const release = await response.json();
  const version = release.tag_name.replace(/^v/, '');
  const assets = /** @type {Record<keyof typeof patterns, string>} */ (Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, release.assets.find(asset => pattern.test(asset.name))?.browser_download_url ?? release.html_url])));
  return { version, page: release.html_url, assets };
}

/** Offline or rate-limited local builds still work: every link goes to the latest release page, which GitHub keeps current. */
export const fallbackRelease = () => ({ version: '', page: `${releasesPage}/latest`, assets: /** @type {Record<keyof typeof patterns, string>} */ (Object.fromEntries(Object.keys(patterns).map(key => [key, `${releasesPage}/latest`]))) });
