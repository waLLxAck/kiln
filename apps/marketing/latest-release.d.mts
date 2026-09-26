export type DownloadKey = 'windows' | 'mac-arm64' | 'mac-x64' | 'appimage' | 'deb' | 'targz';
export type Release = { version: string; page: string; assets: Record<DownloadKey, string> };
export const repository: string;
export const releasesPage: string;
export function latestRelease(fetcher?: typeof fetch, token?: string): Promise<Release>;
export function fallbackRelease(): Release;
